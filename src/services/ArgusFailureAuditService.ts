import { logger } from '../config/logger';
import { queryArgus } from '../lib/db';

export interface AttemptTrace {
  attempt: number;
  elapsedMs: number;
  httpStatus?: number | null;
  error: string;
}

export interface FailureAuditRecordInput {
  serviceName: string;
  operationName: string;
  attemptsCount: number;
  maxAttempts: number;
  finalStatus: 'FALLBACK_ACTIVATED' | 'FAILED_FINAL';
  errorMessage: string;
  errorStack?: string | null;
  httpStatus?: number | null;
  endpointUrl?: string | null;
  payloadSummary?: Record<string, unknown>;
  attemptHistory: AttemptTrace[];
}

export class ArgusFailureAuditService {
  private tableEnsured = false;

  private async ensureTable(): Promise<void> {
    if (this.tableEnsured) return;
    await queryArgus(`
      CREATE TABLE IF NOT EXISTS argus.processing_failure_audits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        service_name TEXT NOT NULL,
        operation_name TEXT NOT NULL,
        attempts_count INT NOT NULL,
        max_attempts INT NOT NULL,
        final_status TEXT NOT NULL,
        error_message TEXT NOT NULL,
        error_stack TEXT,
        http_status INT,
        endpoint_url TEXT,
        payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        attempt_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    this.tableEnsured = true;
  }

  async recordFailure(input: FailureAuditRecordInput): Promise<string | null> {
    try {
      await this.ensureTable();
      const rows = await queryArgus<{ id: string }>(
        `INSERT INTO argus.processing_failure_audits (
           service_name,
           operation_name,
           attempts_count,
           max_attempts,
           final_status,
           error_message,
           error_stack,
           http_status,
           endpoint_url,
           payload_summary,
           attempt_history
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
         RETURNING id`,
        [
          input.serviceName,
          input.operationName,
          input.attemptsCount,
          input.maxAttempts,
          input.finalStatus,
          input.errorMessage.slice(0, 2000),
          input.errorStack ? input.errorStack.slice(0, 4000) : null,
          input.httpStatus ?? null,
          input.endpointUrl ?? null,
          JSON.stringify(input.payloadSummary ?? {}),
          JSON.stringify(input.attemptHistory ?? [])
        ]
      );
      const auditId = rows[0]?.id ?? null;
      logger.warn(
        {
          auditId,
          serviceName: input.serviceName,
          operationName: input.operationName,
          attemptsCount: input.attemptsCount,
          finalStatus: input.finalStatus
        },
        '[AUDITORIA-BANCO] Falha definitiva registrada em argus.processing_failure_audits'
      );
      return auditId;
    } catch (dbErr) {
      logger.error(
        { err: dbErr instanceof Error ? dbErr.message : String(dbErr) },
        '[AUDITORIA-BANCO] Não foi possível gravar falha em argus.processing_failure_audits'
      );
      return null;
    }
  }

  /**
   * Executa `fn` com até `maxAttempts` tentativas (padrão 3) e backoff exponencial.
   * Quando todas as tentativas falham, persiste auditoria completa no PostgreSQL.
   */
  async executeWithRetryAndAudit<T>(params: {
    serviceName: string;
    operationName: string;
    maxAttempts?: number;
    baseDelayMs?: number;
    endpointUrl?: string;
    payloadSummary?: Record<string, unknown>;
    extractHttpStatus?: (err: unknown) => number | null;
    fn: (attempt: number) => Promise<T>;
    fallbackValue?: () => T;
  }): Promise<T> {
    const maxAttempts = Math.max(1, params.maxAttempts ?? 3);
    const baseDelayMs = Math.max(200, params.baseDelayMs ?? 1200);
    const history: AttemptTrace[] = [];

    let lastErr: unknown;
    let lastHttpStatus: number | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStart = Date.now();
      try {
        if (attempt > 1) {
          logger.info(
            {
              serviceName: params.serviceName,
              operationName: params.operationName,
              attempt,
              maxAttempts
            },
            `[RETRY ${attempt}/${maxAttempts}] Reexecutando operação após falha anterior`
          );
        }
        return await params.fn(attempt);
      } catch (err) {
        lastErr = err;
        lastHttpStatus = params.extractHttpStatus ? params.extractHttpStatus(err) : null;
        const msg = err instanceof Error ? err.message : String(err);
        const elapsedMs = Date.now() - attemptStart;

        history.push({
          attempt,
          elapsedMs,
          httpStatus: lastHttpStatus,
          error: msg.slice(0, 500)
        });

        logger.warn(
          {
            serviceName: params.serviceName,
            operationName: params.operationName,
            attempt,
            maxAttempts,
            elapsedMs,
            httpStatus: lastHttpStatus,
            err: msg.slice(0, 220)
          },
          `[FALHA-TENTATIVA ${attempt}/${maxAttempts}] Erro na execução`
        );

        if (attempt < maxAttempts) {
          const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }

    const finalMessage = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const finalStack = lastErr instanceof Error ? lastErr.stack : null;
    const hasFallback = typeof params.fallbackValue === 'function';

    await this.recordFailure({
      serviceName: params.serviceName,
      operationName: params.operationName,
      attemptsCount: maxAttempts,
      maxAttempts,
      finalStatus: hasFallback ? 'FALLBACK_ACTIVATED' : 'FAILED_FINAL',
      errorMessage: finalMessage,
      errorStack: finalStack,
      httpStatus: lastHttpStatus,
      endpointUrl: params.endpointUrl ?? null,
      payloadSummary: params.payloadSummary,
      attemptHistory: history
    });

    if (hasFallback && params.fallbackValue) {
      return params.fallbackValue();
    }
    throw lastErr;
  }
}

export const failureAuditService = new ArgusFailureAuditService();
