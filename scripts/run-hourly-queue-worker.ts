import { Bot } from 'grammy';
import { env } from '../src/config/env';
import { ArgusPriceScannerService } from '../src/services/ArgusPriceScannerService';
import { ArgusReconciliationService } from '../src/services/ArgusReconciliationService';
import { ArgusDashboardBuilderService } from '../src/services/ArgusDashboardBuilderService';

async function main() {
  console.log('⏱️ [Argus Hourly Worker] Verificando fila argus.media_processing_queue e atualizando BI...');
  const scanner = new ArgusPriceScannerService();
  const reconciler = new ArgusReconciliationService();
  const dashboardBuilder = new ArgusDashboardBuilderService();

  const bot = env.TELEGRAM_BOT_TOKEN ? new Bot(env.TELEGRAM_BOT_TOKEN) : null;

  const downloadTelegramFileById = async (fileId: string): Promise<Buffer | null> => {
    if (!bot || !env.TELEGRAM_BOT_TOKEN) return null;
    try {
      const f = await bot.api.getFile(fileId);
      if (!f.file_path) return null;
      const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`;
      const r = await fetch(url);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch {
      return null;
    }
  };

  const outcomes = await scanner.processDueQueueJobs(downloadTelegramFileById, false);
  console.log(`📋 Mídias na fila processadas nesta execução: ${outcomes.length}`);

  if (bot) {
    for (const outcome of outcomes) {
      if (!outcome.telegramChatId) continue;
      const replyOpts = outcome.telegramMessageId
        ? { reply_parameters: { message_id: outcome.telegramMessageId } }
        : undefined;

      const text =
        outcome.status === 'SUCCEEDED'
          ? `✅ [REPROCESSAMENTO HORÁRIO CONCLUÍDO COM SUCESSO]\n• Job #${outcome.queueJobId.slice(
              0,
              8
            )} (${outcome.storeNameDetected})\n• ${outcome.items.length} produto(s) coletado(s) | Confiabilidade média: ${outcome.overallConfidencePct}%`
          : `❌ [FALHA NA TENTATIVA DE REPROCESSAMENTO HORÁRIO]\n• Job #${outcome.queueJobId.slice(
              0,
              8
            )}\n• ⚠️ Erro: ${outcome.errorMessage || 'Indisponibilidade temporária'}`;

      await bot.api.sendMessage(outcome.telegramChatId, text, replyOpts).catch(() => {});
    }
  }

  await reconciler.reconcileAndSyncSheets().catch(() => {});
  const { supabasePublicUrl, storageErrorReason } = await dashboardBuilder.publishDashboardSnapshot();
  if (supabasePublicUrl) {
    console.log(`☁️  Snapshot atualizado no Supabase Storage: ${supabasePublicUrl}`);
  } else {
    console.warn(
      `⚠️ [Storage] Snapshot NÃO publicado no Supabase Storage: ${
        storageErrorReason || 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente/inválida'
      }`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro no worker horário:', err);
    process.exit(1);
  });
