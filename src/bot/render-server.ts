import http from 'node:http';
import crypto from 'node:crypto';
import { webhookCallback } from 'grammy';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus } from '../lib/db';
import { createArgusBot } from './index';

const PORT = Number(process.env.PORT || env.PORT || 3000);
const WEBHOOK_PATH = '/telegram/webhook';

function getPublicBaseUrl(): string {
  const raw =
    process.env.TELEGRAM_WEBHOOK_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    '';
  return raw.replace(/\/+$/, '');
}

async function main() {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.error('[ArgusRender] TELEGRAM_BOT_TOKEN não configurado.');
    process.exit(1);
  }

  const bot = createArgusBot();
  const publicBaseUrl = getPublicBaseUrl();
  const useWebhook =
    Boolean(publicBaseUrl) && process.env.TELEGRAM_BOT_MODE !== 'polling';

  const webhookSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET ||
    crypto
      .createHash('sha256')
      .update(env.TELEGRAM_BOT_TOKEN)
      .digest('hex')
      .slice(0, 32);

  // Inicializa informações do bot (bot.botInfo) antes de receber webhooks
  await bot.init();

  const handleWebhook = webhookCallback(bot, 'http', {
    secretToken: webhookSecret,
    timeoutMilliseconds: 55000
  });

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/health' || urlPath === '/healthz')) {
      let dbOk = false;
      let dbHost = 'not_set';
      let dbError: string | undefined;
      try {
        const rawDb = (env.DATABASE_URL || env.DIRECT_URL || '').replace(/^["']|["']$/g, '').trim();
        if (rawDb) {
          try {
            dbHost = new URL(rawDb).hostname;
          } catch {
            dbHost = 'invalid_url_format';
          }
        }
        await queryArgus('SELECT 1 AS ok');
        dbOk = true;
      } catch (e) {
        dbError = (e as Error).message;
      }

      let storageHost = 'not_set';
      if (env.SUPABASE_URL) {
        try {
          storageHost = new URL(env.SUPABASE_URL).hostname;
        } catch {
          storageHost = 'invalid_url_format';
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'moneta-argus-bot',
          bot: `@${bot.botInfo.username}`,
          mode: useWebhook ? 'webhook' : 'polling',
          dbOk,
          dbHost,
          dbError,
          storageConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
          storageHost,
          storageBucket: env.SUPABASE_STORAGE_BUCKET || 'FotosArgus',
          uptimeSec: Math.round(process.uptime()),
          timestamp: new Date().toISOString()
        })
      );
      return;
    }

    if (useWebhook && req.method === 'POST' && urlPath === WEBHOOK_PATH) {
      try {
        await handleWebhook(req, res);
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro ao processar update do webhook Telegram');
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, '0.0.0.0', async () => {
    logger.info(
      { port: PORT, mode: useWebhook ? 'webhook' : 'polling', publicBaseUrl },
      `[ArgusRender] Servidor HTTP escutando em 0.0.0.0:${PORT}`
    );

    if (useWebhook) {
      const targetWebhookUrl = `${publicBaseUrl}${WEBHOOK_PATH}`;
      try {
        await bot.api.setWebhook(targetWebhookUrl, {
          secret_token: webhookSecret,
          drop_pending_updates: false,
          allowed_updates: ['message', 'callback_query']
        });
        console.log(
          `✅ @${bot.botInfo.username} ONLINE em modo WEBHOOK no Render: ${targetWebhookUrl}`
        );
      } catch (err) {
        logger.error({ err, targetWebhookUrl }, '[ArgusRender] Falha ao registrar Webhook no Telegram');
      }
    } else {
      await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      console.log(`👁️  @${bot.botInfo.username} ONLINE em modo LONG POLLING (+ HTTP /health na porta ${PORT})`);
      bot.start({
        onStart: (info) => {
          console.log(`✅ @${info.username} escutando comandos no Telegram!`);
        }
      });
    }
  });
}

main().catch((err) => {
  logger.error({ err }, '[ArgusRender] Erro fatal ao iniciar servidor Render');
  process.exit(1);
});
