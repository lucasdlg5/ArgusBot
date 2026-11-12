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

interface PendingReceiptSession {
  extracted: ExtractedReceiptData;
  rawBuffer: Buffer;
  mimeType: string;
}

const pendingReceiptsCache = new Map<string, PendingReceiptSession>();

export function createArgusBot(): Bot {
  const token = env.TELEGRAM_BOT_TOKEN || '0000000000:AAH_ARGUS_PLACEHOLDER_TOKEN_FOR_BUILD';
  const bot = new Bot(token);

  const processor = new ArgusReceiptProcessor();
  const optimizer = new ArgusOptimizerService();
  const reconciler = new ArgusReconciliationService();
  const security = new ArgusSecurityService();
  const storage = new ArgusStorageService();

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
      '• 📸 *Envie uma Foto ou PDF de Cupom Fiscal (NFC-e/SAT)* — Decodifico o QR Code localmente (`sharp` + `jsqr`), raspo a SEFAZ ou aciono o `gemini-3.8-flash` e salvo a foto comprimida em WebP no bucket `FotosArgus`.',
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
      .text('🏦 Conciliar Open Finance', 'quick:reconciliar')
      .row()
      .text('📊 Resumo BI', 'quick:dashboard')
      .text('🛡️ Segurança', 'quick:seguranca');

    if (publicUrl && /^https?:\/\//i.test(publicUrl) && !publicUrl.includes('localhost')) {
      kb.row().url('🌐 Abrir Argus Vision BI Web', publicUrl);
    }

    await ctx.reply(welcome, { parse_mode: 'Markdown', reply_markup: kb });
  });

  // 2. /preco <termo> — Histórico e arbitragem de preços por unidade base (g/ml/un)
  async function handlePreco(ctx: { reply: Bot['api']['sendMessage'] extends (...args: any[]) => any ? any : any; match?: unknown }) {
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
        `👁️ *Argus informa:* Nenhum item localizado para *"${query}"*. Tente \`/preco frango\`, \`/preco arroz\`, \`/preco leite\` ou \`/preco omo\`.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const lines = [
      `👁️ *AUDITORIA DE PREÇOS ARGUS (${query || 'Destaques da Cesta'})*`,
      '_Decaimento temporal: 70% último preço + 30% média dos 3 anteriores_',
      ''
    ];

    for (const r of rows) {
      const est = Number(r.estimated_package_price);
      const minH = Number(r.min_historical_price);
      const badge = est <= minH * 1.02 ? '🔥 *MÍNIMA HISTÓRICA (ESTOCAR)*' : '⚖️ Normal';
      lines.push(
        `• *${r.product_name}* — 🏪 ${r.store_name}\n  💰 *R$ ${est.toFixed(2)}* (R$ ${Number(
          r.estimated_base_price
        ).toFixed(4)}/${r.base_unit}) | Mín: R$ ${minH.toFixed(2)} | ${badge}`
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }

  bot.command('preco', async (ctx) => handlePreco(ctx));

  // 3. /receita — Duplo Custo de Receitas (Proporcional vs. Desembolso de Caixa)
  async function handleReceita(ctx: { reply: any }) {
    const evaluations = await optimizer.evaluateRecipeCosts();
    const lines = [
      '👁️ *LABORATÓRIO DE RECEITAS ARGUS — CUSTO POR GRAMA vs. CAIXA*',
      ''
    ];

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
  }

  bot.command('receita', async (ctx) => handleReceita(ctx));

  // 4. /otimizar — Simulador Logístico (Mercado Único vs. Compra Dividida | Gasolina vs. Uber)
  async function handleOtimizar(ctx: { reply: any }) {
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
  }

  bot.command('otimizar', async (ctx) => handleOtimizar(ctx));

  // 5. /reconciliar — Conciliação Open Finance (Pluggy) + Google Sheets ("Argus Ledger")
  async function handleReconciliar(ctx: { reply: any }) {
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
  }

  bot.command('reconciliar', async (ctx) => handleReconciliar(ctx));

  // 6. /dashboard — Resumo Executivo de BI no Telegram + Link Cloud (Sem exibir localhost!)
  async function handleDashboard(ctx: { reply: any }) {
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
  }

  bot.command('dashboard', async (ctx) => handleDashboard(ctx));

  // 6.1. /seguranca — Relatório de Auditoria de Interações Bloqueadas & Tentativas de Ataque
  async function handleSeguranca(ctx: { reply: any }) {
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
  }

  bot.command('seguranca', async (ctx) => handleSeguranca(ctx));

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

  // 7. Recebimento de Foto ou Documento PDF de Cupom Fiscal com Botões Inline de Confirmação & Compressão no Bucket FotosArgus
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    const startMs = Date.now();
    const statusMsg = await ctx.reply(
      '⏳ [1/3] Baixando imagem e procurando QR Code SEFAZ local...'
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
        const globalTimeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(
                  'Tempo limite de processamento (45s) excedido. Por favor, envie a imagem novamente.'
                )
              ),
            45000
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

              let extracted: ExtractedReceiptData | null = null;
              const qrData = await processor.decodeQrCodeFromImage(buffer);
              if (qrData) {
                await updateStatus('🔍 [2/3] QR Code detectado! Consultando portal SEFAZ...');
                extracted = await processor.scrapeSefazReceipt(qrData);
              }
              if (!extracted) {
                await updateStatus(
                  '🧠 [2/3] Extraindo cabeçalho e itens via Gemini Vision IA (aguarde ~3 a 10s)...'
                );
                extracted = await processor.extractReceiptViaGeminiVision(buffer, mimeType);
              }

              const tokenKey = `rcpt_${Date.now()}`;
              pendingReceiptsCache.set(tokenKey, {
                extracted,
                rawBuffer: buffer,
                mimeType
              });

              const kb = new InlineKeyboard()
                .text('✅ Confirmar, Comprimir & Salvar', `confirm:${tokenKey}`)
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

              const preview = [
                `👁️ CUPOM FISCAL EXTRAÍDO EM ${elapsedSec}s (${extracted.extractionMethod})`,
                `🏪 Mercado: ${extracted.storeTradingName} (${extracted.storeCnpj})`,
                `💳 Pagamento: ${extracted.paymentMethod} | 💰 Total: R$ ${extracted.totalAmount.toFixed(2)}`,
                `📦 Itens Identificados (${extracted.items.length}):`,
                topItemsPreview + moreItems,
                '',
                `🗄️ Destino da Imagem: Bucket '${env.SUPABASE_STORAGE_BUCKET}' (WebP comprimido)`,
                'Deseja gravar este cupom no schema argus, comprimir a foto no bucket FotosArgus e conciliar com o Open Finance?'
              ].join('\n');

              await updateStatus(preview, kb);
            })(),
            globalTimeout
          ]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      });
    } catch (err) {
      logger.error({ err }, '[ArgusBot] Erro ao processar foto/PDF');
      await updateStatus(
        `⚠️ Argus informa: Não foi possível concluir a leitura do cupom (${(err as Error).message.slice(0, 220)}). Você pode reenviar a foto agora.`
      );
    }
  });

  // Callback dos Botões Inline
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, key] = data.split(':');

    if (action === 'quick') {
      await ctx.answerCallbackQuery().catch(() => {});
      await withTypingIndicator(ctx, async () => {
        if (key === 'preco') await handlePreco({ reply: ctx.reply.bind(ctx), match: '' });
        if (key === 'receita') await handleReceita({ reply: ctx.reply.bind(ctx) });
        if (key === 'otimizar') await handleOtimizar({ reply: ctx.reply.bind(ctx) });
        if (key === 'reconciliar') await handleReconciliar({ reply: ctx.reply.bind(ctx) });
        if (key === 'dashboard') await handleDashboard({ reply: ctx.reply.bind(ctx) });
        if (key === 'seguranca') await handleSeguranca({ reply: ctx.reply.bind(ctx) });
      });
      return;
    }

    if (action === 'cancel') {
      pendingReceiptsCache.delete(key);
      await ctx.answerCallbackQuery({ text: 'Cupom descartado pelo auditor.' }).catch(() => {});
      await ctx.editMessageText('👁️ Argus: Operação descartada.');
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
      });
    }
  });

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
