import type { Context } from 'grammy';
import { queryArgus } from '../lib/db';
import { logger } from '../config/logger';

export type ThreatLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type InteractionType =
  | 'COMMAND'
  | 'TEXT'
  | 'PHOTO'
  | 'DOCUMENT'
  | 'CALLBACK_QUERY'
  | 'OTHER';

export interface SecurityIncidentRecord {
  id: string;
  telegram_user_id: string;
  telegram_username: string | null;
  first_name: string | null;
  last_name: string | null;
  interaction_type: InteractionType;
  command_or_action: string | null;
  payload_preview: string | null;
  threat_level: ThreatLevel;
  threat_category: string;
  attempt_count_in_window: number;
  created_at: string;
}

// Janela de memória para detecção de Brute-Force / Flood (5 minutos)
const recentAttemptsWindow = new Map<number, number[]>();

export class ArgusSecurityService {
  /**
   * Classifica o tipo de interação, nível de ameaça (LOW, MEDIUM, HIGH, CRITICAL)
   * e categoria do ataque com base no payload e na frequência de tentativas.
   */
  classifyThreat(ctx: Context): {
    interactionType: InteractionType;
    commandOrAction: string;
    payloadPreview: string;
    threatLevel: ThreatLevel;
    threatCategory: string;
    attemptCountInWindow: number;
  } {
    const userId = ctx.from?.id ?? 0;
    const now = Date.now();
    const windowMs = 5 * 60 * 1000; // 5 minutos
    const prevTimestamps = (recentAttemptsWindow.get(userId) ?? []).filter(
      (t) => now - t < windowMs
    );
    prevTimestamps.push(now);
    recentAttemptsWindow.set(userId, prevTimestamps);
    const attemptCount = prevTimestamps.length;

    let interactionType: InteractionType = 'OTHER';
    let commandOrAction = 'unknown';
    let payloadPreview = '';

    if (ctx.callbackQuery) {
      interactionType = 'CALLBACK_QUERY';
      commandOrAction = ctx.callbackQuery.data || 'callback_query';
      payloadPreview = `[Callback] ${commandOrAction}`;
    } else if (ctx.message?.photo) {
      interactionType = 'PHOTO';
      commandOrAction = 'upload_photo';
      const bestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
      payloadPreview = `[Photo Upload] file_size=${bestPhoto?.file_size ?? 0}B caption="${
        ctx.message.caption || ''
      }"`;
    } else if (ctx.message?.document) {
      interactionType = 'DOCUMENT';
      commandOrAction = 'upload_document';
      payloadPreview = `[Document Upload] name="${ctx.message.document.file_name || ''}" mime="${
        ctx.message.document.mime_type || ''
      }" size=${ctx.message.document.file_size ?? 0}B`;
    } else if (ctx.message?.text) {
      const txt = ctx.message.text.trim();
      if (txt.startsWith('/')) {
        interactionType = 'COMMAND';
        commandOrAction = txt.split(/\s+/)[0];
      } else {
        interactionType = 'TEXT';
        commandOrAction = 'text_message';
      }
      payloadPreview = txt.slice(0, 300);
    }

    // Heurística de Detecção de Ataques (SQLi, Command Injection, Prompt Injection, Flood, API Quota Abuse)
    const inspectStr = `${commandOrAction} ${payloadPreview}`;
    const hasSqlOrCmdInjection =
      /(\bUNION\s+SELECT\b|\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|--|;.*EXEC|\bOR\s+1\s*=\s*1|<script|\$\(|\brm\s+-rf\b|\bcat\s+\/etc\/passwd)/i.test(
        inspectStr
      );
    const hasPromptInjection =
      /(ignore\s+(all\s+)?previous\s+instructions|system\s+prompt|jailbreak|bypass\s+security|reveal\s+api\s+key|mostre\s+o\s+token|ignore\s+as\s+regras)/i.test(
        inspectStr
      );

    let threatLevel: ThreatLevel = 'LOW';
    let threatCategory = 'UNAUTHORIZED_PROBE';

    if (hasSqlOrCmdInjection) {
      threatLevel = 'CRITICAL';
      threatCategory = 'SQLI_OR_COMMAND_INJECTION_ATTEMPT';
    } else if (hasPromptInjection) {
      threatLevel = 'CRITICAL';
      threatCategory = 'LLM_PROMPT_INJECTION_ATTEMPT';
    } else if (attemptCount >= 6) {
      threatLevel = 'CRITICAL';
      threatCategory = 'BRUTE_FORCE_FLOOD_ATTACK';
    } else if (interactionType === 'PHOTO' || interactionType === 'DOCUMENT') {
      threatLevel = 'HIGH';
      threatCategory = 'UNAUTHORIZED_MEDIA_UPLOAD_QUOTA_ABUSE';
    } else if (
      interactionType === 'CALLBACK_QUERY' ||
      ['/reconciliar', '/otimizar', '/preco', '/receita', '/seguranca'].includes(
        commandOrAction.toLowerCase()
      )
    ) {
      threatLevel = 'MEDIUM';
      threatCategory = 'UNAUTHORIZED_FINANCIAL_DATA_ACCESS';
    } else if (attemptCount >= 3) {
      threatLevel = 'MEDIUM';
      threatCategory = 'REPEATED_UNAUTHORIZED_PROBING';
    }

    return {
      interactionType,
      commandOrAction,
      payloadPreview,
      threatLevel,
      threatCategory,
      attemptCountInWindow: attemptCount
    };
  }

  /**
   * Grava a tentativa bloqueada em `argus.security_audit_logs`
   */
  async recordBlockedInteraction(ctx: Context) {
    const classification = this.classifyThreat(ctx);
    const userId = ctx.from?.id ?? 0;
    const username = ctx.from?.username ?? null;
    const firstName = ctx.from?.first_name ?? null;
    const lastName = ctx.from?.last_name ?? null;
    const languageCode = ctx.from?.language_code ?? null;
    const isBot = Boolean(ctx.from?.is_bot);
    const chatId = ctx.chat?.id ?? null;
    const chatType = ctx.chat?.type ?? null;

    const rawMetadata = {
      update_id: ctx.update.update_id,
      date: ctx.message?.date ?? Math.floor(Date.now() / 1000),
      is_premium: (ctx.from as { is_premium?: boolean } | undefined)?.is_premium ?? false
    };

    try {
      await queryArgus(
        `INSERT INTO argus.security_audit_logs (
           telegram_user_id,
           telegram_username,
           first_name,
           last_name,
           language_code,
           is_bot,
           chat_id,
           chat_type,
           interaction_type,
           command_or_action,
           payload_preview,
           threat_level,
           threat_category,
           attempt_count_in_window,
           blocked,
           raw_update_metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,$15)`,
        [
          userId,
          username,
          firstName,
          lastName,
          languageCode,
          isBot,
          chatId,
          chatType,
          classification.interactionType,
          classification.commandOrAction,
          classification.payloadPreview,
          classification.threatLevel,
          classification.threatCategory,
          classification.attemptCountInWindow,
          JSON.stringify(rawMetadata)
        ]
      );
    } catch (err) {
      logger.error({ err }, '[ArgusSecurityService] Falha ao persistir security_audit_logs no banco');
    }

    return classification;
  }

  /**
   * Lista os últimos eventos bloqueados e o resumo de ameaças para o proprietário
   */
  async getRecentSecurityReport(limit = 10): Promise<{
    totalBlockedCount: number;
    uniqueAttackersCount: number;
    criticalOrHighCount: number;
    recentLogs: SecurityIncidentRecord[];
  }> {
    const [statsRows, logsRows] = await Promise.all([
      queryArgus<{
        total_blocked: string;
        unique_attackers: string;
        critical_high: string;
      }>(
        `SELECT
           COUNT(*)::text AS total_blocked,
           COUNT(DISTINCT telegram_user_id)::text AS unique_attackers,
           COUNT(*) FILTER (WHERE threat_level IN ('HIGH', 'CRITICAL'))::text AS critical_high
         FROM argus.security_audit_logs`
      ),
      queryArgus<SecurityIncidentRecord>(
        `SELECT
           id,
           telegram_user_id::text,
           telegram_username,
           first_name,
           last_name,
           interaction_type,
           command_or_action,
           payload_preview,
           threat_level,
           threat_category,
           attempt_count_in_window,
           created_at
         FROM argus.security_audit_logs
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      )
    ]);

    const st = statsRows[0];
    return {
      totalBlockedCount: Number(st?.total_blocked ?? 0),
      uniqueAttackersCount: Number(st?.unique_attackers ?? 0),
      criticalOrHighCount: Number(st?.critical_high ?? 0),
      recentLogs: logsRows
    };
  }
}
