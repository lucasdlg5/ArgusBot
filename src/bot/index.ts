import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard } from 'grammy';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus } from '../lib/db';
import { ArgusReceiptProcessor, type ExtractedReceiptData } from '../services/ArgusReceiptProcessor';
import { ArgusOptimizerService } from '../services/ArgusOptimizerService';
import { ArgusReconciliationService } from '../services/ArgusReconciliationService';
import { ArgusSecurityService } from '../services/ArgusSecurityService';
import { ArgusStorageService } from '../services/ArgusStorageService';
import { ArgusStickerService } from '../services/ArgusStickerService';
import {
  ArgusPriceScannerService,
  type PriceScanProcessOutcome
} from '../services/ArgusPriceScannerService';

interface PendingReceiptSession {
  extracted: ExtractedReceiptData;
  rawBuffer: Buffer;
  mimeType: string;
}

const pendingReceiptsCache = new Map<string, PendingReceiptSession>();
const inFlightImageHashes = new Set<string>();

export function createArgusBot(): Bot {
  const token = env.TELEGRAM_BOT_TOKEN || '0000000000:AAH_ARGUS_PLACEHOLDER_TOKEN_FOR_BUILD';
  const bot = new Bot(token);

  const processor = new ArgusReceiptProcessor();
  const optimizer = new ArgusOptimizerService();
  const reconciler = new ArgusReconciliationService();
  const security = new ArgusSecurityService();
  const storage = new ArgusStorageService();
  const stickers = new ArgusStickerService();
  const priceScanner = new ArgusPriceScannerService();
  let lastPriceScanJobId: string | null = null;

  bot.catch((err) => {
    logger.error({ err: err.error }, '[ArgusBot] Erro capturado pelo handler global');
  });

  // 0. Guardião de Acesso Exclusivo & Detector de Ataques (Allowlist + Persistência em argus.security_audit_logs)
  bot.use(async (ctx, next) => {
    const allowedIds = new Set<string>([
      ...env.TELEGRAM_ALLOWED_USER_IDS,
      ...(env.TELEGRAM_DEFAULT_CHAT_ID ? [env.TELEGRAM_DEFAULT_CHAT_ID] : [])
    ]);
    const allowedUsernames = new Set<string>(env.TELEGRAM_ALLOWED_USERNAMES);

    const senderId = ctx.from?.id ? String(ctx.from.id) : '';
    const senderUsername = (ctx.from?.username || '').toLowerCase();

    const isAuthorizedById = allowedIds.size > 0 && allowedIds.has(senderId);
    const isAuthorizedByUsername =
      allowedUsernames.size > 0 && Boolean(senderUsername) && allowedUsernames.has(senderUsername);

    // Se houver regras configuradas, exige match estrito (ID imutável ou @AsminnAeterna)
    if (allowedIds.size > 0 || allowedUsernames.size > 0) {
      if (!isAuthorizedById && !isAuthorizedByUsername) {
        const incident = await security.recordBlockedInteraction(ctx);

        logger.warn(
          {
            unauthorizedUserId: senderId,
            unauthorizedUsername: senderUsername,
            threatLevel: incident.threatLevel,
            threatCategory: incident.threatCategory,
            attemptCountInWindow: incident.attemptCountInWindow
          },
          '[ArgusBot] Tentativa de acesso bloqueada e persistida em argus.security_audit_logs'
        );

        // Notifica proativamente o proprietário (@AsminnAeterna) quando detectar ameaça HIGH ou CRITICAL
        if (
          env.TELEGRAM_DEFAULT_CHAT_ID &&
          (incident.threatLevel === 'HIGH' || incident.threatLevel === 'CRITICAL')
        ) {
          await bot.api
            .sendMessage(
              env.TELEGRAM_DEFAULT_CHAT_ID,
              `🚨 *ALERTA DE SEGURANÇA ARGUS (${incident.threatLevel})*\n\n` +
                `• *Intruso:* \`${senderId}\` (@${senderUsername || 'sem_username'})\n` +
                `• *Vetor:* \`${incident.threatCategory}\` (${incident.interactionType})\n` +
                `• *Tentativas (5 min):* ${incident.attemptCountInWindow}\n` +
                `• *Payload:* \`${incident.payloadPreview.replace(/`/g, "'").slice(0, 140)}\`\n\n` +
                `Registrado na tabela \`argus.security_audit_logs\`.`,
              { parse_mode: 'Markdown' }
            )
            .catch(() => {});
          await stickers.sendEmotionalStickerToChat(
            bot.api,
            env.TELEGRAM_DEFAULT_CHAT_ID,
            'SHOCK_ALERT'
          );
        }

        if (ctx.callbackQuery) {
          await ctx
            .answerCallbackQuery({
              text: '⛔ Acesso não autorizado.',
              show_alert: true
            })
            .catch(() => {});
        } else {
          // Resposta mínima OpSec (Zero Information Disclosure: não revela dono, schema, tabelas ou regras)
          await ctx.reply('⛔ Acesso não autorizado. Esta tentativa foi registrada.');
        }
        return;
      }
    }

    await next();
  });

  // 1. /start — Apresentação oficial da persona Argus (@MonetaArgusBot - "O Olho Fiscal")
  bot.command('start', async (ctx) => {
    const publicUrl = env.PUBLIC_DASHBOARD_URL.trim();
    const welcome = [
      '👁️ *Saudações. Eu sou o ARGUS (@MonetaArgusBot) — O Olho Fiscal do ecossistema Moneta.*',
      '',
      'Sou um auditor analítico, direto e afiado. Minha função é vigiar cada centavo do seu orçamento, caçar reduflação oculta nas embalagens, calcular o custo exato por grama de cada receita e decidir na ponta do lápis se compensa ir de carro ou de Uber.',
      '',
      '📋 *Comandos de Auditoria Disponíveis:*',
      '• 📸 *Envie uma Foto ou PDF de Cupom Fiscal (NFC-e/SAT)* — Decodifico o QR Code localmente (`sharp` + `jsqr`), raspo a SEFAZ ou aciono o Gemini Vision e salvo a foto comprimida em WebP no bucket `FotosArgus`.',
      '• 🎥 *Envie um Vídeo do Corredor ou Foto de Gôndola/Panfleto (Flyer)* — Extraio todos os produtos e preços visíveis, calculo a *% de Confiabilidade* (apontando se faltou loja, filial ou nitidez), gravo na planilha `Precos_Coletados` e mantenho fila automática em `argus.media_processing_queue` caso precise reprocessar!',
      '• `/fila` — Consulta a Tabela de Controle de mídias processadas com sucesso, fila de reprocessamento e últimos preços coletados de gôndolas/flyers.',
      '• `/loja <Nome do Mercado | Bairro>` — Define ou corrige a loja da última coleta de vídeo/gôndola para elevar o score de confiabilidade.',
      '• `/preco <item>` — Consulta o preço estimado atual por grama/ml em cada mercado e alerta se é hora de estocar.',
      '• `/receita` — Calcula o *Custo Proporcional por Marmita* vs. *Desembolso de Caixa (Embalagens Fechadas)* das suas receitas.',
      '• `/otimizar` — Roda o Simulador Logístico (Rota Real OSRM: Mercado Único vs. Compra Dividida | Gasolina vs. Uber com trava de R$ 25,00).',
      '• `/reconciliar` — Cruza cupons fiscais com transações do Pluggy Open Finance (`-2h` a `+48h`, `<= R$ 0,05`) e sincroniza a planilha *Argus Ledger*.',
      '• `/seguranca` — Exibe o relatório de tentativas de invasão e acessos bloqueados em `argus.security_audit_logs`.',
      '• `/dashboard` — Exibe o Resumo Executivo de BI (ou abre o *Argus Vision BI* na nuvem).'
    ].join('\n');

    const kb = new InlineKeyboard()
      .text('💰 Preços da Cesta', 'quick:preco')
      .text('🍲 Custos de Receitas', 'quick:receita')
      .row()
      .text('🚗 Simular Rota (Carro vs Uber)', 'quick:otimizar')
      .text('🗂️ Fila & Coletas', 'quick:fila')
      .row()
      .text('🏦 Conciliar Open Finance', 'quick:reconciliar')
      .text('📊 Resumo BI', 'quick:dashboard')
      .row()
      .text('🛡️ Segurança', 'quick:seguranca');

    if (publicUrl && /^https?:\/\//i.test(publicUrl) && !publicUrl.includes('localhost')) {
      kb.row().url('🌐 Abrir Argus Vision BI Web', publicUrl);
    }

    await ctx.reply(welcome, { parse_mode: 'Markdown', reply_markup: kb });
    await stickers.sendEmotionalSticker(ctx, 'DETECTIVE');
  });

  // 2. /preco <termo> — Histórico e arbitragem de preços por unidade base (g/ml/un)
  async function handlePreco(ctx: {
    api: Bot['api'];
    chat?: { id: number };
    reply: any;
    replyWithSticker?: (sticker: string) => Promise<unknown>;
    match?: unknown;
  }) {
    const query = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const rows = await queryArgus<{
      product_name: string;
      store_name: string;
      base_unit: string;
      standard_package_size: string;
      estimated_base_price: string;
      estimated_package_price: string;
      min_historical_price: string;
      max_historical_price: string;
      days_since_last_seen: number;
    }>(
      query
        ? `SELECT * FROM argus.v_current_product_prices WHERE product_name ILIKE $1 ORDER BY estimated_package_price ASC LIMIT 9`
        : `SELECT * FROM argus.v_current_product_prices ORDER BY product_name ASC, estimated_package_price ASC LIMIT 9`,
      query ? [`%${query}%`] : []
    );

    if (rows.length === 0) {
      await ctx.reply(
        query
          ? `👁️ *Argus informa:* Nenhum item real localizado para *"${query}"*. Envie fotos das suas notas fiscais para popular o histórico real!`
          : '👁️ *Argus informa:* A base foi limpa de dados fictícios e ainda não possui itens reais cadastrados. Envie a foto do seu primeiro cupom fiscal aqui no chat!',
        { parse_mode: 'Markdown' }
      );
      await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
      return;
    }

    const lines = [
      `👁️ *AUDITORIA DE PREÇOS ARGUS (${query || 'Destaques da Cesta'})*`,
      '_Decaimento temporal: 70% último preço + 30% média dos 3 anteriores_',
      ''
    ];

    let foundHistoricalLow = false;
    for (const r of rows) {
      const est = Number(r.estimated_package_price);
      const minH = Number(r.min_historical_price);
      const isLow = est <= minH * 1.02;
      if (isLow) foundHistoricalLow = true;
      const badge = isLow ? '🔥 *MÍNIMA HISTÓRICA (ESTOCAR)*' : '⚖️ Normal';
      lines.push(
        `• *${r.product_name}* — 🏪 ${r.store_name}\n  💰 *R$ ${est.toFixed(2)}* (R$ ${Number(
          r.estimated_base_price
        ).toFixed(4)}/${r.base_unit}) | Mín: R$ ${minH.toFixed(2)} | ${badge}`
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    await stickers.sendEmotionalSticker(ctx, foundHistoricalLow ? 'CELEBRATION' : 'DETECTIVE');
  }

  bot.command('preco', async (ctx) => handlePreco(ctx));

  // 3. /receita — Duplo Custo de Receitas (Proporcional vs. Desembolso de Caixa)
  async function handleReceita(ctx: {
    api: Bot['api'];
    chat?: { id: number };
    reply: any;
    replyWithSticker?: (sticker: string) => Promise<unknown>;
  }) {
    const evaluations = await optimizer.evaluateRecipeCosts();
    const lines = [
      '👁️ *LABORATÓRIO DE RECEITAS ARGUS — CUSTO POR GRAMA vs. CAIXA*',
      ''
    ];

    if (evaluations.length === 0) {
      lines.push(
        'ℹ️ _Nenhuma receita cadastrada após a limpeza dos dados fictícios. À medida que seus cupons reais entrarem no banco, suas receitas usarão exclusivamente os preços reais das suas compras._'
      );
    }

    for (const rec of evaluations) {
      lines.push(`🍲 *${rec.recipeName}* (${rec.servings} porções/marmitas)`);
      lines.push(
        `  • 🎯 *Custo Proporcional por Marmita:* *R$ ${rec.proportionalCostPerPortion.toFixed(
          2
        )}* (Total usado: R$ ${rec.proportionalTotalCost.toFixed(2)})`
      );
      lines.push(
        `  • 🛒 *Desembolso no Caixa (Embalagens Fechadas):* *R$ ${rec.cashOutlayTotalCost.toFixed(
          2
        )}*`
      );
      lines.push(`  • 🏆 *Melhor Mercado Único:* ${rec.bestSingleStoreName}`);
      lines.push('');
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    await stickers.sendEmotionalSticker(ctx, 'FOOD_CHEF');
  }

  bot.command('receita', async (ctx) => handleReceita(ctx));

  // 4. /otimizar — Simulador Logístico (Mercado Único vs. Compra Dividida | Gasolina vs. Uber)
  async function handleOtimizar(ctx: {
    api: Bot['api'];
    chat?: { id: number };
    reply: any;
    replyWithSticker?: (sticker: string) => Promise<unknown>;
  }) {
    const verdict = await optimizer.optimizeShoppingTrip();
    const s1 = verdict.singleStoreBest;
    const s2 = verdict.splitStoreBest;

    const text = [
      '👁️ *SIMULADOR LOGÍSTICO ARGUS (ROTA OSRM: CARRO vs. UBER)*',
      '',
      `1️⃣ *${s1.title}*`,
      `   • Produtos: R$ ${s1.productsCost.toFixed(2)} | Distância OSRM: ${s1.totalDistanceKm} km (${s1.totalDurationMin} min)`,
      `   • ⛽ Com Gasolina: *R$ ${s1.totalWithGas.toFixed(2)}* (Combustível: R$ ${s1.gasCost.toFixed(2)})`,
      `   • 🚗 Com Uber: *R$ ${s1.totalWithUber.toFixed(2)}* (Corridas: R$ ${s1.uberCost.toFixed(2)})`,
      '',
      `2️⃣ *${s2.title}*`,
      `   • Produtos: R$ ${s2.productsCost.toFixed(2)} | Distância OSRM: ${s2.totalDistanceKm} km (${s2.totalDurationMin} min)`,
      `   • ⛽ Com Gasolina: *R$ ${s2.totalWithGas.toFixed(2)}* (Combustível: R$ ${s2.gasCost.toFixed(2)})`,
      `   • 🚗 Com Uber: *R$ ${s2.totalWithUber.toFixed(2)}* (Corridas: R$ ${s2.uberCost.toFixed(2)})`,
      '',
      `⚖️ *Economia Bruta nos Produtos:* R$ ${verdict.grossProductSavings.toFixed(2)}`,
      `💵 *Economia Líquida (Carro):* R$ ${verdict.netSavingsWithGas.toFixed(2)} | *(Uber):* R$ ${verdict.netSavingsWithUber.toFixed(2)}`,
      `🚧 *Trava Mínima Argus (Hurdle):* R$ ${verdict.minSavingsHurdle.toFixed(2)}`,
      '',
      `*${verdict.argusVerdictText}*`
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
    await stickers.sendEmotionalSticker(
      ctx,
      verdict.recommendSplitWithGas || verdict.recommendSplitWithUber
        ? 'CELEBRATION'
        : 'SKEPTICAL'
    );
  }

  bot.command('otimizar', async (ctx) => handleOtimizar(ctx));

  // 5. /reconciliar — Conciliação Open Finance (Pluggy) + Google Sheets ("Argus Ledger")
  async function handleReconciliar(ctx: {
    api: Bot['api'];
    chat?: { id: number };
    reply: any;
    replyWithSticker?: (sticker: string) => Promise<unknown>;
  }) {
    const { summary } = await reconciler.reconcileAndSyncSheets();
    const msg = [
      '👁️ *AUDITORIA DE CONCILIAÇÃO OPEN FINANCE (PLUGGY) & SHEETS*',
      '',
      `• 📄 Cupons Fiscais Escaneados: *${summary.scannedReceipts}*`,
      `• 🏦 Transações Pluggy Analisadas: *${summary.pluggyTransactions}*`,
      `• 🔗 Taxa de Conciliação (-2h a +48h, <= R$ 0,05): *${summary.reconciliationRatePct}%* (${summary.totalReconciled} conciliados)`,
      `• 💳 Cupons lançados na Carteira VR/VA: *${summary.vrVaSyncedCount}*`,
      `• 📊 Linhas sincronizadas no Google Sheets (*Argus Ledger*): *${summary.sheetsSyncedRows}*`
    ].join('\n');

    await ctx.reply(msg, { parse_mode: 'Markdown' });
    await stickers.sendEmotionalSticker(ctx, 'CELEBRATION');
  }

  bot.command('reconciliar', async (ctx) => handleReconciliar(ctx));

  // 6. /dashboard — Resumo Executivo de BI no Telegram + Link Cloud (Sem exibir localhost!)
  async function handleDashboard(ctx: {
    api: Bot['api'];
    chat?: { id: number };
    reply: any;
    replyWithSticker?: (sticker: string) => Promise<unknown>;
  }) {
    const publicUrl = env.PUBLIC_DASHBOARD_URL.trim();
    const [spendingRows, shrinkRows, lowRows] = await Promise.all([
      queryArgus<{ spending_pillar: string; total_spent: string }>(
        `SELECT spending_pillar, ROUND(SUM(total_spent), 2)::text AS total_spent
         FROM argus.v_true_spending_breakdown
         WHERE ref_month = (SELECT MAX(ref_month) FROM argus.v_true_spending_breakdown)
         GROUP BY spending_pillar
         ORDER BY SUM(total_spent) DESC`
      ),
      queryArgus<{ product_name: string; package_reduction_pct: string }>(
        `SELECT DISTINCT product_name, package_reduction_pct::text
         FROM argus.v_personal_inflation_and_shrinkflation
         WHERE shrinkflation_detected = TRUE OR package_reduction_pct > 0`
      ),
      queryArgus<{ product_name: string; store_name: string; estimated_package_price: string }>(
        `SELECT product_name, store_name, estimated_package_price::text
         FROM argus.v_current_product_prices
         WHERE estimated_package_price <= min_historical_price * 1.02
         ORDER BY estimated_package_price ASC
         LIMIT 5`
      )
    ]);

    const lines = [
      '📊 *ARGUS VISION BI — RESUMO EXECUTIVO DIRETO NO TELEGRAM*',
      ''
    ];

    if (spendingRows.length === 0 && shrinkRows.length === 0 && lowRows.length === 0) {
      lines.push(
        '✨ *Base 100% Limpa (Somente Dados Reais):* Todos os valores fictícios foram removidos. Envie seu primeiro cupom fiscal real aqui no chat para inaugurar os indicadores!'
      );
      lines.push('');
    }

    if (spendingRows.length > 0) {
      lines.push('💳 *Desconstrução de Gastos (Mês Atual):*');
      for (const s of spendingRows) {
        lines.push(`  • ${s.spending_pillar}: *R$ ${Number(s.total_spent).toFixed(2)}*`);
      }
      lines.push('');
    }

    if (shrinkRows.length > 0) {
      lines.push(`🚨 *Produtos com Reduflação Detectada (${shrinkRows.length}):*`);
      for (const sh of shrinkRows) {
        lines.push(`  • ${sh.product_name} (-${sh.package_reduction_pct}% na embalagem)`);
      }
      lines.push('');
    }

    if (lowRows.length > 0) {
      lines.push('🔥 *Top Oportunidades na Mínima Histórica (Estocar):*');
      for (const lw of lowRows) {
        lines.push(`  • ${lw.product_name} (${lw.store_name}): *R$ ${Number(lw.estimated_package_price).toFixed(2)}*`);
      }
      lines.push('');
    }

    if (publicUrl && /^https?:\/\//i.test(publicUrl) && !publicUrl.includes('localhost')) {
      const kb = new InlineKeyboard().url('🌐 Abrir Argus Vision BI na Nuvem', publicUrl);
      lines.push(`🌐 *Painel Web Online:* ${publicUrl}`);
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
    } else {
      lines.push(
        '☁️ _Status Web UI: Quando você hospedar o Argus Vision BI (ex: Vercel/Render), basta preencher `PUBLIC_DASHBOARD_URL` no `.env` para habilitar o botão direto de WebApp aqui!_'
      );
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    }

    await stickers.sendEmotionalSticker(
      ctx,
      shrinkRows.length > 0 ? 'SHOCK_ALERT' : 'CELEBRATION'
    );
  }

  bot.command('dashboard', async (ctx) => handleDashboard(ctx));

  // 6.1. /seguranca — Relatório de Auditoria de Interações Bloqueadas & Tentativas de Ataque
  async function handleSeguranca(ctx: {
    api: Bot['api'];
    chat?: { id: number };
    reply: any;
    replyWithSticker?: (sticker: string) => Promise<unknown>;
  }) {
    const report = await security.getRecentSecurityReport(8);
    const lines = [
      '🛡️ *AUDITORIA DE SEGURANÇA ARGUS (`argus.security_audit_logs`)*',
      '',
      `• 🚫 Total de Interações Bloqueadas: *${report.totalBlockedCount}*`,
      `• 👤 Usuários/Bots Intrusos Únicos: *${report.uniqueAttackersCount}*`,
      `• 🚨 Tentativas de Alta Severidade (\`HIGH\`/\`CRITICAL\`): *${report.criticalOrHighCount}*`,
      ''
    ];

    if (report.recentLogs.length === 0) {
      lines.push('✅ _Nenhuma tentativa de acesso não autorizado ou ataque registrada até o momento._');
    } else {
      lines.push('📋 *Últimos Eventos Bloqueados:*');
      for (const log of report.recentLogs) {
        const dt = new Date(log.created_at).toLocaleString('pt-BR');
        const fullName = [log.first_name, log.last_name].filter(Boolean).join(' ') || 'Sem Nome';
        const userLabel =
          log.telegram_username && !log.telegram_username.startsWith('[')
            ? `@${log.telegram_username} (${fullName} | ID \`${log.telegram_user_id}\`)`
            : `${fullName} (Sem @username público | ID \`${log.telegram_user_id}\`)`;
        lines.push(
          `• [${log.threat_level}] *${log.threat_category}* — ${userLabel} (${dt})\n  ↳ Tipo: \`${log.interaction_type}\` | Ação: \`${log.command_or_action || '-'}\``
        );
      }
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    await stickers.sendEmotionalSticker(
      ctx,
      report.criticalOrHighCount > 0 ? 'SHOCK_ALERT' : 'DETECTIVE'
    );
  }

  bot.command('seguranca', async (ctx) => handleSeguranca(ctx));

  // Formata o relatório completo de Coleta de Preços (Vídeo de Corredor, Foto de Gôndola ou Panfleto/Flyer)
  function formatPriceScanOutcomeMessage(
    outcome: PriceScanProcessOutcome,
    elapsedSec?: string
  ): string {
    if (outcome.alreadyProcessedDuplicate) {
      return [
        '🛡️ MÍDIA DE COLETA DUPLICADA BLOQUEADA',
        ...outcome.confidenceWarnings.map((w) => `• ${w}`),
        `• Arquivo no Bucket: ${outcome.storageBucket}/${outcome.storagePath}`
      ].join('\n');
    }

    if (outcome.status === 'QUEUED_RETRY' || outcome.status === 'FAILED_PERMANENT') {
      const retryStr = outcome.nextRetryAt
        ? new Date(outcome.nextRetryAt).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
          })
        : 'Manual (/fila)';
      return [
        '🗂️ MÍDIA SALVA NO BUCKET E ENFILEIRADA PARA REPROCESSAMENTO',
        `• Status na Tabela de Controle (argus.media_processing_queue): ${outcome.status}`,
        `• ID do Job: #${outcome.queueJobId.slice(0, 8)}`,
        `• Arquivo Seguro no Bucket: ${outcome.storageBucket}/${outcome.storagePath}`,
        `• Motivo da Falha Temporária: ${(outcome.errorMessage || 'Instabilidade momentânea').slice(0, 160)}`,
        `• Próxima Tentativa Automática: ${retryStr} (ou clique em "🔄 Reprocessar Fila Agora" em /fila)`
      ].join('\n');
    }

    const kindLabel =
      outcome.mediaKind === 'AISLE_VIDEO'
        ? '🎥 VÍDEO DE CORREDOR / GÔNDOLA'
        : outcome.mediaKind === 'MARKET_FLYER'
          ? '📰 PANFLETO / FLYER DE MERCADO'
          : '🏷️ FOTO DE GÔNDOLA / ETIQUETA';

    const confIcon =
      outcome.overallConfidencePct >= 80
        ? '🟢'
        : outcome.overallConfidencePct >= 65
          ? '🟡'
          : '🟠';

    const warnTranslations: Record<string, string> = {
      LOJA_NAO_IDENTIFICADA:
        'Loja não identificada na imagem/vídeo (use /loja <Nome do Mercado> para vincular e subir a confiabilidade)',
      AMBIGUIDADE_NOME_LOJA: 'Possível ambiguidade no nome da loja detectada',
      LOCAL_FILIAL_AUSENTE:
        'Localização/filial exata da loja ausente (preços podem variar entre unidades da mesma rede)',
      PRODUTO_IDENTIFICACAO_INCERTA:
        'Marca ou gramatura de alguns produtos parcialmente ilegível/estimada',
      GRAMATURA_NAO_EXPLICITA: 'Peso/volume da embalagem não explícito em todas as etiquetas',
      BAIXA_NITIDEZ_OU_MOVIMENTO: 'Nitidez reduzida por movimento da câmera ou distância da gôndola',
      PRECO_DUPLO_CLUBE_VAREJO: 'Etiqueta exibe preço duplo (Varejo vs. Clube/Atacado)',
      VALIDADE_ENCARTE_AUSENTE: 'Data de validade das ofertas do panfleto não identificada'
    };

    const humanWarnings =
      outcome.confidenceWarnings.length > 0
        ? outcome.confidenceWarnings.map((w) => `  ⚠️ ${warnTranslations[w] || w}`).join('\n')
        : '  ✅ Loja, filial e produtos nítidos.';

    const itemsPreview = outcome.items
      .slice(0, 10)
      .map((it) => {
        const promoTag = it.promoClubPrice
          ? ` (Clube/Atacado: R$ ${it.promoClubPrice.toFixed(2)})`
          : '';
        const tsTag =
          it.videoTimestampSec !== null && it.videoTimestampSec !== undefined
            ? ` [@${it.videoTimestampSec}s]`
            : '';
        return `  • ${it.rawProductDescription}${tsTag} ➡️ R$ ${it.collectedPrice.toFixed(
          2
        )}${promoTag} | Conf: ${it.confidenceScorePct}%`;
      })
      .join('\n');

    const moreCount =
      outcome.items.length > 10 ? `\n  ... e mais ${outcome.items.length - 10} produto(s)` : '';

    return [
      `👁️ COLETA DE PREÇOS CONCLUÍDA${elapsedSec ? ` EM ${elapsedSec}s` : ''} (${kindLabel})`,
      `🏪 Loja: ${outcome.storeNameDetected} | 📍 Local: ${outcome.storeLocationDetected || 'Não identificado'}`,
      `${confIcon} Confiabilidade Média do Registro: ${outcome.overallConfidencePct}%`,
      '📋 Diagnóstico de Confiabilidade (Informações Faltantes / Ressalvas):',
      humanWarnings,
      '',
      `📦 Produtos Registrados na Planilha Precos_Coletados (${outcome.items.length}):`,
      itemsPreview + moreCount,
      '',
      `🗄️ Mídia Arquivada: ${outcome.storageBucket}/${outcome.storagePath}`,
      outcome.storeNameDetected === 'Loja Não Identificada'
        ? '💡 Dica: Envie `/loja Nome do Mercado - Bairro` para vincular a loja a esta coleta e elevar a confiabilidade!'
        : '✅ Sincronizado em argus.collected_prices e na aba Precos_Coletados!'
    ].join('\n');
  }

  // 6.2. /fila — Tabela de Controle de Mídias Processadas, Fila de Reprocessamento e Preços Coletados
  async function handleFila(ctx: {
    api: Bot['api'];
    chat?: { id: number };
    reply: any;
    replyWithSticker?: (sticker: string) => Promise<unknown>;
  }) {
    const summary = await priceScanner.getQueueAndCollectedSummary();
    const lines = [
      '🗂️ *TABELA DE CONTROLE DE MÍDIAS & PREÇOS COLETADOS (`argus.media_processing_queue`)*',
      '',
      `• ✅ Processados com Sucesso (\`SUCCEEDED\`): *${summary.stats.succeeded_count}*`,
      `• ⏳ Na Fila para Nova Tentativa (\`QUEUED_RETRY\`): *${summary.stats.queued_retry_count}*`,
      `• ❌ Falhas Permanentes (\`FAILED_PERMANENT\`): *${summary.stats.failed_count}*`,
      `• 🏷️ Total de Preços de Gôndola/Flyer/Vídeo Coletados: *${summary.stats.total_collected_items}*`,
      ''
    ];

    if (summary.recentJobs.length > 0) {
      lines.push('📋 *Últimas Mídias na Tabela de Controle:*');
      for (const j of summary.recentJobs.slice(0, 5)) {
        const dt = new Date(j.created_at).toLocaleString('pt-BR');
        const conf = j.overall_confidence_pct ? ` | Conf: ${j.overall_confidence_pct}%` : '';
        lines.push(
          `• [${j.status}] *${j.media_kind}* (#${j.id.slice(0, 6)}) — ${j.store_name_detected || '-'} | ${j.items_extracted_count} itens${conf} (${dt})`
        );
      }
      lines.push('');
    }

    if (summary.recentPrices.length > 0) {
      lines.push('🏷️ *Últimos Preços Coletados (Gôndola / Vídeo / Flyer):*');
      for (const p of summary.recentPrices.slice(0, 6)) {
        lines.push(
          `• *${p.canonical_product_name}* (${p.store_name_detected}): *R$ ${Number(p.collected_price).toFixed(2)}* — Conf: *${Number(p.confidence_score_pct).toFixed(0)}%*`
        );
      }
    }

    const kb = new InlineKeyboard().text('🔄 Forçar Reprocessamento da Fila Agora', 'retry_queue:now');
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
    await stickers.sendEmotionalSticker(
      ctx,
      summary.stats.queued_retry_count > 0 ? 'SKEPTICAL' : 'DETECTIVE'
    );
  }

  bot.command('fila', async (ctx) => handleFila(ctx));

  // 6.3. /loja <Nome do Mercado | Local> — Atualiza a loja da última coleta de vídeo/gôndola e eleva a confiabilidade
  bot.command('loja', async (ctx) => {
    const rawArg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!rawArg) {
      await ctx.reply(
        'ℹ️ Uso: `/loja Nome do Mercado | Bairro/Filial`\nExemplo: `/loja Atacadão | Paulista`\nIsso vincula a loja à última coleta de gôndola/vídeo e recalcula a porcentagem de confiabilidade!',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const targetJobRows = lastPriceScanJobId
      ? [{ id: lastPriceScanJobId }]
      : await queryArgus<{ id: string }>(
          `SELECT id FROM argus.media_processing_queue
           WHERE status = 'SUCCEEDED' AND media_kind <> 'RECEIPT_PHOTO'
           ORDER BY created_at DESC LIMIT 1`
        );

    if (targetJobRows.length === 0) {
      await ctx.reply('⚠️ Nenhuma coleta de gôndola/vídeo/panfleto encontrada para atualizar.');
      return;
    }

    const [storePart, locPart] = rawArg.split('|').map((s) => s.trim());
    const updated = await priceScanner.assignStoreToQueueJob(
      targetJobRows[0].id,
      storePart,
      locPart
    );
    await reconciler.reconcileAndSyncSheets().catch(() => {});

    await ctx.reply(
      `✅ Loja atualizada para *${storePart}*${locPart ? ` (${locPart})` : ''}!\n` +
        `• Itens atualizados: *${updated.updatedItemsCount}*\n` +
        `• 🟢 Nova Confiabilidade Média do Lote: *${updated.newConfidencePct}%*`,
      { parse_mode: 'Markdown' }
    );
    await stickers.sendEmotionalSticker(ctx, 'CELEBRATION');
  });

  // Helper que baixa um arquivo do Telegram dado seu file_id (usado pelo bot e pelo worker de fila)
  async function downloadTelegramFileById(fileId: string): Promise<Buffer | null> {
    try {
      const f = await bot.api.getFile(fileId);
      if (!f.file_path) return null;
      const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  // Helper que exibe o balãozinho "MonetaArgusBot está digitando..." continuamente até a tarefa concluir
  async function withTypingIndicator<T>(
    ctx: { replyWithChatAction: (action: 'typing') => Promise<unknown> },
    fn: () => Promise<T>
  ): Promise<T> {
    await ctx.replyWithChatAction('typing').catch(() => {});
    const interval = setInterval(() => {
      ctx.replyWithChatAction('typing').catch(() => {});
    }, 4000);
    try {
      return await fn();
    } finally {
      clearInterval(interval);
    }
  }

  // 6.4. Recebimento de Vídeos de Corredor de Mercado (Gôndolas / Prateleiras / Encartes em Vídeo)
  bot.on(['message:video', 'message:video_note', 'message:animation'], async (ctx) => {
    const startMs = Date.now();
    const statusMsg = await ctx.reply(
      '🎥 [1/3] Baixando vídeo do corredor e arquivando no bucket FotosArgus...'
    );

    const updateStatus = async (text: string) => {
      try {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, text);
      } catch {
        await ctx.reply(text);
      }
    };

    try {
      await withTypingIndicator(ctx, async () => {
        const mediaObj =
          ctx.message?.video || ctx.message?.video_note || ctx.message?.animation;
        const fileSize = mediaObj?.file_size ?? 0;

        // Limite da API padrão de bots do Telegram para getFile é 20 MB
        if (fileSize > 20 * 1024 * 1024) {
          await updateStatus(
            '⚠️ O vídeo enviado tem mais de 20 MB (limite de download da API de Bots do Telegram). Envie um vídeo de até ~30-45 segundos (ou comprimido pelo Telegram) para leitura das gôndolas!'
          );
          await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
          return;
        }

        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const res = await fetch(fileUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        const mimeType =
          (ctx.message?.video && 'mime_type' in ctx.message.video
            ? ctx.message.video.mime_type
            : undefined) || 'video/mp4';

        await updateStatus(
          '🧠 [2/3] Vídeo salvo no bucket FotosArgus! Analisando quadros das gôndolas e preços via Gemini Multimodal (aguarde ~8 a 25s)...'
        );

        const outcome = await priceScanner.ingestAndProcessPriceScanMedia({
          mediaBuffer: buffer,
          mimeType,
          initialMediaKind: 'AISLE_VIDEO',
          telegramChatId: ctx.chat.id,
          telegramMessageId: ctx.message?.message_id,
          telegramFileId: file.file_id,
          telegramFileUniqueId: file.file_unique_id,
          userCaption: ctx.message?.caption
        });

        if (outcome.status === 'SUCCEEDED') {
          lastPriceScanJobId = outcome.queueJobId;
        }

        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
        await updateStatus(formatPriceScanOutcomeMessage(outcome, elapsedSec));
        await stickers.sendEmotionalSticker(
          ctx,
          outcome.status === 'SUCCEEDED' ? 'FOOD_CHEF' : 'SKEPTICAL'
        );
      });
    } catch (err) {
      logger.error({ err }, '[ArgusBot] Erro ao processar vídeo de corredor');
      await updateStatus(
        `⚠️ Aviso ao processar vídeo: ${(err as Error).message.slice(0, 200)}. Consulte /fila para verificar o status.`
      );
      await stickers.sendEmotionalSticker(ctx, 'SHOCK_ALERT');
    }
  });

  // Verifica se já existe uma sessão pendente de confirmação com os mesmos hashes ou dados
  function checkPendingQueueDuplicate(
    imageSha256: string,
    normalizedImageSha256: string,
    extracted?: ExtractedReceiptData
  ): { isDuplicate: boolean; reason: string } {
    for (const [, session] of pendingReceiptsCache.entries()) {
      const ex = session.extracted;
      if (
        ex.imageSha256 === imageSha256 ||
        ex.normalizedImageSha256 === normalizedImageSha256
      ) {
        return {
          isDuplicate: true,
          reason: `Camada 1 (Fila de Confirmação Pendente): Esta foto (${ex.storeTradingName} — R$ ${ex.totalAmount.toFixed(
            2
          )}) já foi lida e aguarda seu clique em "✅ Confirmar" logo acima.`
        };
      }
      if (extracted) {
        if (extracted.hasOfficialAccessKey && ex.accessKey === extracted.accessKey) {
          return {
            isDuplicate: true,
            reason: `Camada 2 (Fila Pendente - Chave SEFAZ 44d): Este cupom já aguarda confirmação acima.`
          };
        }
        if (
          extracted.contentFingerprint &&
          ex.contentFingerprint === extracted.contentFingerprint
        ) {
          return {
            isDuplicate: true,
            reason: `Camada 4 (Fila Pendente - Fingerprint Semântico): Um cupom com os mesmos itens e valor (R$ ${ex.totalAmount.toFixed(
              2
            )}) já aguarda confirmação acima.`
          };
        }
      }
    }
    return { isDuplicate: false, reason: '' };
  }

  // 7. Recebimento de Foto ou Documento (Cupom Fiscal c/ 5 Camadas Anti-Duplicidade OU Foto de Gôndola/Panfleto/Vídeo em Arquivo)
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    const startMs = Date.now();
    const caption = (ctx.message?.caption || '').trim();
    const docMime = ctx.message?.document?.mime_type || '';
    const isVideoDocument = docMime.startsWith('video/');
    const isExplicitPriceScanCaption =
      /\b(g[oô]ndola|prateleira|panfleto|flyer|encarte|corredor|etiqueta|oferta|coleta|mercado\s*:|loja\s*:)/i.test(
        caption
      );

    const statusMsg = await ctx.reply(
      isVideoDocument || isExplicitPriceScanCaption
        ? '⏳ [1/3] Baixando mídia de preços (Gôndola / Panfleto / Vídeo) e preparando arquivamento no bucket FotosArgus...'
        : '⏳ [1/3] Baixando imagem e executando verificação anti-duplicidade (Camada 1)...'
    );

    const updateStatus = async (text: string, kb?: InlineKeyboard) => {
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          text,
          kb ? { reply_markup: kb } : undefined
        );
      } catch {
        // Caso a mensagem não possa ser editada, envia nova
        await ctx.reply(text, kb ? { reply_markup: kb } : undefined);
      }
    };

    try {
      await withTypingIndicator(ctx, async () => {
        let timeoutHandle: NodeJS.Timeout | undefined;
        let currentImgHash = '';
        let currentNormHash = '';

        const globalTimeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(
                  'Tempo limite de processamento (60s) excedido.'
                )
              ),
            60000
          );
        });

        try {
          await Promise.race([
            (async () => {
              const file = await ctx.getFile();
              const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
              const res = await fetch(fileUrl);
              const buffer = Buffer.from(await res.arrayBuffer());
              const mimeType = ctx.message?.document?.mime_type || 'image/jpeg';
              const telegramFileId =
                ctx.message?.document?.file_id ||
                ctx.message?.photo?.[ctx.message.photo.length - 1]?.file_id ||
                file.file_id;
              const telegramFileUniqueId =
                ctx.message?.document?.file_unique_id ||
                ctx.message?.photo?.[ctx.message.photo.length - 1]?.file_unique_id;

              // ROTA A: Documento de Vídeo OU Foto com legenda explícita de Gôndola/Panfleto/Corredor
              if (isVideoDocument || isExplicitPriceScanCaption) {
                await updateStatus(
                  '🧠 [2/3] Arquivando mídia no bucket FotosArgus e extraindo preços + score de confiabilidade via Gemini Vision...'
                );
                const outcome = await priceScanner.ingestAndProcessPriceScanMedia({
                  mediaBuffer: buffer,
                  mimeType,
                  initialMediaKind: isVideoDocument ? 'AISLE_VIDEO' : 'SHELF_PHOTO',
                  telegramChatId: ctx.chat.id,
                  telegramMessageId: ctx.message?.message_id,
                  telegramFileId,
                  telegramFileUniqueId,
                  userCaption: caption
                });

                if (outcome.status === 'SUCCEEDED') {
                  lastPriceScanJobId = outcome.queueJobId;
                  if (outcome.items.length > 0) {
                    await reconciler.reconcileAndSyncSheets().catch(() => {});
                  }
                }

                const kb =
                  outcome.status === 'QUEUED_RETRY'
                    ? new InlineKeyboard().text('🔄 Tentar Fila Agora', 'retry_queue:now')
                    : undefined;

                const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
                await updateStatus(formatPriceScanOutcomeMessage(outcome, elapsedSec), kb);
                await stickers.sendEmotionalSticker(
                  ctx,
                  outcome.status === 'SUCCEEDED'
                    ? 'DETECTIVE'
                    : outcome.status === 'SKIPPED_DUPLICATE'
                      ? 'SKEPTICAL'
                      : 'SHOCK_ALERT'
                );
                return;
              }

              // ROTA B: Cupom Fiscal (com Fallback inteligente para Foto de Gôndola/Panfleto e Fila de Retry!)
              // CAMADA 0 & 1 (PRÉ-OCR): Hash binário SHA-256 + Hash visual normalizado 16x16
              const { imageSha256, normalizedImageSha256 } =
                await processor.computeImageHashes(buffer);
              currentImgHash = imageSha256;
              currentNormHash = normalizedImageSha256;

              // 1A. Verifica se já está em processamento simultâneo neste exato segundo (in-flight)
              if (
                inFlightImageHashes.has(imageSha256) ||
                inFlightImageHashes.has(normalizedImageSha256)
              ) {
                await updateStatus(
                  '⏳ [Camada 0 - Processamento Ativo] Esta mesma imagem já está sendo analisada neste instante! Aguarde a resposta na mensagem anterior.'
                );
                return;
              }

              // 1B. Verifica se já está na fila de botões aguardando confirmação (pendingReceiptsCache)
              const pendingImgDup = checkPendingQueueDuplicate(
                imageSha256,
                normalizedImageSha256
              );
              if (pendingImgDup.isDuplicate) {
                await updateStatus(`🛡️ DUPLICIDADE EVITADA\n${pendingImgDup.reason}`);
                await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
                return;
              }

              // 1C. Verifica se a foto já foi salva no banco argus.receipts (sem gastar cota do Gemini!)
              const preOcrDup = await processor.checkPreOcrImageDuplicate(
                imageSha256,
                normalizedImageSha256
              );
              if (preOcrDup.isDuplicate) {
                const dtStr = preOcrDup.existingPurchaseDate
                  ? new Date(preOcrDup.existingPurchaseDate).toLocaleDateString('pt-BR')
                  : '-';
                await updateStatus(
                  [
                    '🛡️ NOTA FISCAL DUPLICADA BLOQUEADA (PRÉ-OCR)',
                    `• Motivo: ${preOcrDup.reason}`,
                    `• Registro Existente: ${preOcrDup.existingStoreName} — R$ ${(preOcrDup.existingTotalAmount || 0).toFixed(2)} (${dtStr})`,
                    '• Economia de Cota: Bloqueado instantaneamente antes de acionar a IA.'
                  ].join('\n')
                );
                await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
                return;
              }

              // Marca imagem como "em processamento" (in-flight)
              inFlightImageHashes.add(imageSha256);
              inFlightImageHashes.add(normalizedImageSha256);

              let extracted: ExtractedReceiptData | null = null;
              const qrData = await processor.decodeQrCodeFromImage(buffer);
              if (qrData) {
                await updateStatus('🔍 [2/3] QR Code detectado! Consultando portal SEFAZ...');
                extracted = await processor.scrapeSefazReceipt(qrData);
              }
              if (!extracted) {
                await updateStatus(
                  '🧠 [2/3] Analisando imagem via Gemini Vision IA (Cupom Fiscal ou Gôndola/Panfleto)...'
                );
                try {
                  extracted = await processor.extractReceiptViaGeminiVision(buffer, mimeType);
                } catch (receiptErr) {
                  // Se falhou por erro de rede/IA ou não é cupom, aciona o Scanner de Preços + Fila Resiliente!
                  logger.warn(
                    { err: receiptErr },
                    '[ArgusBot] Leitura de cupom falhou; acionando PriceScanner + Fila Resiliente'
                  );
                  const scanOutcome = await priceScanner.ingestAndProcessPriceScanMedia({
                    mediaBuffer: buffer,
                    mimeType,
                    initialMediaKind: 'SHELF_PHOTO',
                    telegramChatId: ctx.chat.id,
                    telegramMessageId: ctx.message?.message_id,
                    telegramFileId,
                    telegramFileUniqueId,
                    userCaption: caption
                  });

                  if (scanOutcome.status === 'SUCCEEDED') {
                    lastPriceScanJobId = scanOutcome.queueJobId;
                    if (scanOutcome.items.length > 0) {
                      await reconciler.reconcileAndSyncSheets().catch(() => {});
                    }
                  }

                  const kbRetry =
                    scanOutcome.status === 'QUEUED_RETRY'
                      ? new InlineKeyboard().text('🔄 Tentar Fila Agora', 'retry_queue:now')
                      : undefined;

                  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
                  await updateStatus(formatPriceScanOutcomeMessage(scanOutcome, elapsedSec), kbRetry);
                  await stickers.sendEmotionalSticker(
                    ctx,
                    scanOutcome.status === 'SUCCEEDED' ? 'DETECTIVE' : 'SHOCK_ALERT'
                  );
                  return;
                }
              }

              // Se a imagem não parece ser um cupom fiscal (ex.: totalAmount = 0 ou sem CNPJ e sem chave SEFAZ),
              // verifica no Scanner de Gôndola/Panfleto!
              const looksLikeNonReceiptShelfOrFlyer =
                !qrData &&
                (!extracted.items ||
                  extracted.items.length === 0 ||
                  (extracted.totalAmount <= 0 && !extracted.storeCnpj));

              if (looksLikeNonReceiptShelfOrFlyer) {
                await updateStatus(
                  '🏷️ [2/3] Imagem identificada como Gôndola / Etiqueta / Panfleto! Calculando preços coletados e % de confiabilidade...'
                );
                const scanOutcome = await priceScanner.ingestAndProcessPriceScanMedia({
                  mediaBuffer: buffer,
                  mimeType,
                  initialMediaKind: 'SHELF_PHOTO',
                  telegramChatId: ctx.chat.id,
                  telegramMessageId: ctx.message?.message_id,
                  telegramFileId,
                  telegramFileUniqueId,
                  userCaption: caption
                });

                if (scanOutcome.status === 'SUCCEEDED') {
                  lastPriceScanJobId = scanOutcome.queueJobId;
                  if (scanOutcome.items.length > 0) {
                    await reconciler.reconcileAndSyncSheets().catch(() => {});
                  }
                }

                const kbRetry =
                  scanOutcome.status === 'QUEUED_RETRY'
                    ? new InlineKeyboard().text('🔄 Tentar Fila Agora', 'retry_queue:now')
                    : undefined;

                const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
                await updateStatus(formatPriceScanOutcomeMessage(scanOutcome, elapsedSec), kbRetry);
                await stickers.sendEmotionalSticker(
                  ctx,
                  scanOutcome.status === 'SUCCEEDED' ? 'DETECTIVE' : 'SKEPTICAL'
                );
                return;
              }

              // Consolida identificadores multicamada (Chave SEFAZ 44d OU Fallback COO + Content Fingerprint)
              extracted = processor.finalizeReceiptIdentifiers(extracted, {
                imageSha256,
                normalizedImageSha256
              });

              // CAMADAS 2, 3, 4 e 5 (PÓS-OCR): Verifica se o conteúdo extraído já está na fila pendente ou no banco
              const pendingContentDup = checkPendingQueueDuplicate(
                imageSha256,
                normalizedImageSha256,
                extracted
              );
              if (pendingContentDup.isDuplicate) {
                await updateStatus(`🛡️ DUPLICIDADE EVITADA\n${pendingContentDup.reason}`);
                await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
                return;
              }

              const postOcrDup = await processor.checkPostOcrDuplicateLayers(extracted);
              if (postOcrDup.isDuplicate) {
                const dtStr = postOcrDup.existingPurchaseDate
                  ? new Date(postOcrDup.existingPurchaseDate).toLocaleDateString('pt-BR')
                  : '-';
                await updateStatus(
                  [
                    '🛡️ NOTA FISCAL DUPLICADA BLOQUEADA (PÓS-OCR)',
                    `• ${postOcrDup.reason}`,
                    `• Cupom Original no Banco: ${postOcrDup.existingStoreName} — R$ ${(postOcrDup.existingTotalAmount || 0).toFixed(2)} (${dtStr})`,
                    '• Ação: O cupom não foi duplicado.'
                  ].join('\n')
                );
                await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
                return;
              }

              const tokenKey = `rcpt_${Date.now()}`;
              pendingReceiptsCache.set(tokenKey, {
                extracted,
                rawBuffer: buffer,
                mimeType
              });

              const kb = new InlineKeyboard()
                .text('✅ Confirmar, Comprimir & Salvar', `confirm:${tokenKey}`)
                .text('🏷️ Ler como Gôndola/Flyer', `as_scan:${tokenKey}`)
                .row()
                .text('❌ Descartar', `cancel:${tokenKey}`);

              const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
              const topItemsPreview = extracted.items
                .slice(0, 6)
                .map(
                  (it) =>
                    `  • ${it.rawDescription} (${it.quantity} ${it.unitType}) — R$ ${it.totalPrice.toFixed(2)}`
                )
                .join('\n');
              const moreItems =
                extracted.items.length > 6
                  ? `\n  ... e mais ${extracted.items.length - 6} item(ns)`
                  : '';

              const idLayerBadge = extracted.hasOfficialAccessKey
                ? `🔑 ID Fiscal (Camada 2): Chave SEFAZ 44 dígitos (${extracted.accessKey.slice(0, 12)}...)`
                : `🧬 ID Multicamada (Sem Chave 44d): ${
                    extracted.receiptNumber ? `Doc/COO #${extracted.receiptNumber} + ` : ''
                  }Fingerprint #${(extracted.contentFingerprint || '').slice(0, 12)}`;

              const preview = [
                `👁️ CUPOM FISCAL EXTRAÍDO EM ${elapsedSec}s (${extracted.extractionMethod})`,
                `🏪 Mercado: ${extracted.storeTradingName} (${extracted.storeCnpj})`,
                `💳 Pagamento: ${extracted.paymentMethod} | 💰 Total: R$ ${extracted.totalAmount.toFixed(2)}`,
                idLayerBadge,
                `📦 Itens Identificados (${extracted.items.length}):`,
                topItemsPreview + moreItems,
                '',
                `🗄️ Destino da Imagem: Bucket '${env.SUPABASE_STORAGE_BUCKET}' (WebP comprimido)`,
                'Deseja gravar este cupom no schema argus ou reclassificar como foto de Gôndola/Panfleto?'
              ].join('\n');

              await updateStatus(preview, kb);
              await stickers.sendEmotionalSticker(ctx, 'FOOD_CHEF');
            })(),
            globalTimeout
          ]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (currentImgHash) inFlightImageHashes.delete(currentImgHash);
          if (currentNormHash) inFlightImageHashes.delete(currentNormHash);
        }
      });
    } catch (err) {
      logger.error({ err }, '[ArgusBot] Erro ao processar foto/PDF');
      await updateStatus(
        `⚠️ Argus informa: Não foi possível concluir a leitura (${(err as Error).message.slice(0, 220)}). Você pode reenviar ou usar /fila.`
      );
      await stickers.sendEmotionalSticker(ctx, 'SHOCK_ALERT');
    }
  });

  // Callback dos Botões Inline
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, key] = data.split(':');

    if (action === 'quick') {
      await ctx.answerCallbackQuery().catch(() => {});
      await withTypingIndicator(ctx, async () => {
        if (key === 'preco') await handlePreco(ctx);
        if (key === 'receita') await handleReceita(ctx);
        if (key === 'otimizar') await handleOtimizar(ctx);
        if (key === 'reconciliar') await handleReconciliar(ctx);
        if (key === 'dashboard') await handleDashboard(ctx);
        if (key === 'seguranca') await handleSeguranca(ctx);
        if (key === 'fila') await handleFila(ctx);
      });
      return;
    }

    if (action === 'retry_queue') {
      await ctx
        .answerCallbackQuery({ text: 'Reprocessando mídias na fila...' })
        .catch(() => {});
      await ctx
        .editMessageText('⏳ Reprocessando mídias pendentes em argus.media_processing_queue...')
        .catch(() => {});

      await withTypingIndicator(ctx, async () => {
        const outcomes = await priceScanner.processDueQueueJobs(downloadTelegramFileById, true);
        const succeeded = outcomes.filter((o) => o.status === 'SUCCEEDED').length;
        const failed = outcomes.length - succeeded;
        if (succeeded > 0) {
          await reconciler.reconcileAndSyncSheets().catch(() => {});
        }
        const details = outcomes.map(
          (o) =>
            `• [#${o.queueJobId.slice(0, 6)}] ${o.status}: ${o.storeNameDetected} (${o.items.length} itens | Conf: ${o.overallConfidencePct}%)`
        );
        const detailsMsg = details.length > 0 ? `\n\n${details.join('\n')}` : '\n\nNenhuma mídia aguardando na fila no momento.';
        await ctx.editMessageText(
          `🔄 REPROCESSAMENTO DA FILA CONCLUÍDO\n• Processados: ${outcomes.length} | ✅ Sucesso: ${succeeded} | ⏳ Reagendados/Falha: ${failed}${detailsMsg}`
        );
        await stickers.sendEmotionalSticker(
          ctx,
          succeeded > 0 ? 'CELEBRATION' : 'SKEPTICAL'
        );
      });
      return;
    }

    if (action === 'as_scan') {
      const session = pendingReceiptsCache.get(key);
      if (!session) {
        await ctx.answerCallbackQuery({ text: 'Sessão expirada.' }).catch(() => {});
        return;
      }
      pendingReceiptsCache.delete(key);

      await ctx
        .answerCallbackQuery({ text: 'Analisando como Gôndola/Panfleto...' })
        .catch(() => {});
      await ctx
        .editMessageText(
          '⏳ [3/3] Reclassificando imagem como Coleta de Preços (Gôndola/Panfleto) com cálculo de % de confiabilidade...'
        )
        .catch(() => {});

      await withTypingIndicator(ctx, async () => {
        const scanOutcome = await priceScanner.ingestAndProcessPriceScanMedia({
          mediaBuffer: session.rawBuffer,
          mimeType: session.mimeType,
          initialMediaKind: 'SHELF_PHOTO',
          telegramChatId: ctx.chat?.id || 0,
          userCaption: session.extracted.storeTradingName
            ? `Loja: ${session.extracted.storeTradingName}`
            : ''
        });
        if (scanOutcome.status === 'SUCCEEDED') {
          lastPriceScanJobId = scanOutcome.queueJobId;
          if (scanOutcome.items.length > 0) {
            await reconciler.reconcileAndSyncSheets().catch(() => {});
          }
        }
        await ctx.editMessageText(formatPriceScanOutcomeMessage(scanOutcome));
        await stickers.sendEmotionalSticker(ctx, 'DETECTIVE');
      });
      return;
    }

    if (action === 'cancel') {
      pendingReceiptsCache.delete(key);
      await ctx.answerCallbackQuery({ text: 'Cupom descartado pelo auditor.' }).catch(() => {});
      await ctx.editMessageText('👁️ Argus: Operação descartada.');
      await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
      return;
    }

    if (action === 'confirm') {
      const session = pendingReceiptsCache.get(key);
      if (!session) {
        await ctx.answerCallbackQuery({ text: 'Sessão expirada.' }).catch(() => {});
        return;
      }
      pendingReceiptsCache.delete(key);

      await ctx
        .answerCallbackQuery({ text: 'Comprimindo foto e gravando no banco...' })
        .catch(() => {});
      await ctx
        .editMessageText(
          '⏳ [3/3] Comprimindo foto para WebP no bucket FotosArgus, normalizando itens no schema argus e conciliando com Open Finance...'
        )
        .catch(() => {});

      await withTypingIndicator(ctx, async () => {
        // Verifica última trava transacional antes de subir para o bucket FotosArgus
        const preCommitDup = await processor.checkPostOcrDuplicateLayers(session.extracted);
        if (preCommitDup.isDuplicate) {
          await ctx.editMessageText(
            `🛡️ Duplicidade evitada na gravação final!\n• ${preCommitDup.reason}\n• Nenhuma imagem ou linha duplicada foi gerada.`
          );
          await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
          return;
        }

        // 1. Comprime a foto para WebP e envia para o bucket FotosArgus no Supabase Storage
        const uploadRes = await storage.compressAndUploadReceiptImage(
          session.rawBuffer,
          session.extracted.accessKey,
          session.extracted.storeTradingName,
          session.mimeType
        );

        session.extracted.storageBucket = uploadRes.bucket;
        session.extracted.storagePath = uploadRes.storagePath;
        session.extracted.originalSizeBytes = uploadRes.originalBytes;
        session.extracted.compressedSizeBytes = uploadRes.compressedBytes;

        // 2. Grava cupom + itens normalizados no schema argus e concilia com Pluggy Open Finance
        const result = await processor.ingestReceipt(session.extracted);
        if (result.alreadyExisted) {
          await ctx.editMessageText(
            `🛡️ Duplicidade evitada no banco (${result.duplicateReason || 'Cupom já registrado'}).`
          );
          await stickers.sendEmotionalSticker(ctx, 'SKEPTICAL');
          return;
        }

        await reconciler.reconcileAndSyncSheets();

        const shrinkMsg =
          result.shrinkflationAlerts.length > 0
            ? `\n🚨 ALERTA DE REDUFLAÇÃO: ${result.shrinkflationAlerts.join('; ')}`
            : '';

        const origKb = (uploadRes.originalBytes / 1024).toFixed(1);
        const compKb = (uploadRes.compressedBytes / 1024).toFixed(1);
        const storageMsg = uploadRes.uploaded
          ? `\n🗄️ Foto arquivada em '${uploadRes.bucket}/${uploadRes.storagePath}' (${origKb} KB ➡️ ${compKb} KB | -${uploadRes.compressionSavingsPct}% de espaço!)`
          : `\n🗄️ Foto comprimida (${origKb} KB ➡️ ${compKb} KB | -${uploadRes.compressionSavingsPct}%).`;

        await ctx.editMessageText(
          `✅ Argus auditou e persistiu o cupom! (${result.itemsProcessed} itens normalizados para g/ml/un).${storageMsg}${shrinkMsg}`
        );
        await stickers.sendEmotionalSticker(
          ctx,
          result.shrinkflationAlerts.length > 0 ? 'SHOCK_ALERT' : 'CELEBRATION'
        );
      });
    }
  });

  // Worker periódico em background (a cada 5 min) para reprocessar mídias em QUEUED_RETRY cujo next_retry_at já venceu
  const retryInterval = setInterval(async () => {
    try {
      const outcomes = await priceScanner.processDueQueueJobs(downloadTelegramFileById, false);
      if (outcomes.length > 0) {
        const succeeded = outcomes.filter((o) => o.status === 'SUCCEEDED').length;
        const failed = outcomes.length - succeeded;
        if (succeeded > 0) {
          await reconciler.reconcileAndSyncSheets().catch(() => {});
        }
        const targetChatId = Number(
          env.TELEGRAM_DEFAULT_CHAT_ID || env.TELEGRAM_ALLOWED_USER_IDS[0] || 0
        );
        if (targetChatId) {
          const details = outcomes.map(
            (o) =>
              `• [#${o.queueJobId.slice(0, 6)}] ${o.status}: ${o.storeNameDetected} (${o.items.length} itens | Conf: ${o.overallConfidencePct}%)`
          );
          await bot.api
            .sendMessage(
              targetChatId,
              [
                '🔄 WORKER DE REPROCESSAMENTO AUTOMÁTICO (argus.media_processing_queue)',
                `• Jobs processados: ${outcomes.length} | ✅ Sucesso: ${succeeded} | ⏳ Reagendados/Falha: ${failed}`,
                ...details
              ].join('\n')
            )
            .catch(() => {});
        }
      }
    } catch (err) {
      logger.warn({ err }, '[ArgusBot] Erro no worker periódico de retry da fila de mídia');
    }
  }, 5 * 60 * 1000);
  retryInterval.unref();

  return bot;
}

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log('======================================================================');
    console.log('👁️  ARGUS BOT (@MonetaArgusBot - O Olho Fiscal)');
    console.log('ℹ️  TELEGRAM_BOT_TOKEN ainda não configurado no `.env`.');
    console.log('   Adicione seu token do @BotFather em TELEGRAM_BOT_TOKEN para iniciar o polling ao vivo.');
    console.log('======================================================================');
    process.exit(0);
  }

  const bot = createArgusBot();
  console.log('👁️  Iniciando @MonetaArgusBot (O Olho Fiscal) em modo Long Polling...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ @${botInfo.username} está ONLINE e escutando comandos no Telegram!`);
    }
  });
}
