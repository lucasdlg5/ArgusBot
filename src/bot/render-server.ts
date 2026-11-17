import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { webhookCallback } from 'grammy';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { APP_VERSION } from '../config/version';
import { queryArgus } from '../lib/db';
import {
  ArgusCatalogBiService,
  type UpdateProductInput,
  type UpdateStoreInput
} from '../services/ArgusCatalogBiService';
import { ArgusDashboardBuilderService } from '../services/ArgusDashboardBuilderService';
import { ArgusPantryGuideService } from '../services/ArgusPantryGuideService';
import { ArgusReceiptProcessor } from '../services/ArgusReceiptProcessor';
import {
  ArgusRecipeService,
  type ExtractedRecipeInput,
  type UpdateRecipeIngredientInput
} from '../services/ArgusRecipeService';
import { RecipeFetchError, UnsafeUrlError } from '../lib/url-security';
import { createArgusBot } from './index';

const PORT = Number(process.env.PORT || env.PORT || 3000);
const WEBHOOK_PATH = '/telegram/webhook';

function applyCorsHeaders(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJsonCompressed(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown
) {
  const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (jsonBuf.length > 1024 && /\bgzip\b/i.test(acceptEncoding)) {
    const gz = zlib.gzipSync(jsonBuf, { level: 6 });
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding'
    });
    res.end(gz);
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(jsonBuf);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw || '{}') as T;
}

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
  const dashboardBuilder = new ArgusDashboardBuilderService();
  const recipeService = new ArgusRecipeService();
  const pantryGuideService = new ArgusPantryGuideService();
  const catalogBiService = new ArgusCatalogBiService();
  const receiptProcessor = new ArgusReceiptProcessor();
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
    timeoutMilliseconds: 85000,
    onTimeout: 'return'
  });

  let snapshotCache: { data: unknown; expiresAt: number } | null = null;

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method !== 'GET' && urlPath.startsWith('/api/')) {
      snapshotCache = null;
    }

    if (req.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
      applyCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const convertFlyerMatch = urlPath.match(/^\/api\/receipts\/([a-f0-9-]+)\/convert-to-flyer$/i);
    if (req.method === 'POST' && convertFlyerMatch) {
      applyCorsHeaders(res);
      try {
        const result = await receiptProcessor.convertReceiptToFlyer(convertFlyerMatch[1]);
        if (!result.converted) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', message: 'Nota fiscal não encontrada.' }));
          return;
        }
        snapshotCache = null;
        await dashboardBuilder.publishDashboardSnapshot().catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', ...result }));
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro em POST /api/receipts/:id/convert-to-flyer');
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/public-snapshot') {
      applyCorsHeaders(res);
      try {
        const now = Date.now();
        if (snapshotCache && snapshotCache.expiresAt > now) {
          sendJsonCompressed(req, res, 200, snapshotCache.data);
          return;
        }
        const payload = await dashboardBuilder.buildSanitizedPublicPayload();
        snapshotCache = { data: payload, expiresAt: now + 15000 };
        sendJsonCompressed(req, res, 200, payload);
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro ao gerar /api/public-snapshot');
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/recipes') {
      applyCorsHeaders(res);
      try {
        const searchParams = new URL(req.url || '/api/recipes', 'http://localhost').searchParams;
        const id = searchParams.get('id') || undefined;
        const q = searchParams.get('q') || undefined;
        const portionsParam = searchParams.get('portions');
        const requestedPortions = portionsParam ? Math.max(1, Number(portionsParam)) : undefined;
        const recipes = await recipeService.evaluateRecipesWithRoutes({
          recipeId: id,
          nameQuery: q,
          requestedPortions
        });
        sendJsonCompressed(req, res, 200, {
          status: 'ok',
          recipes,
          homeLocation: {
            lat: -23.305,
            lng: -45.965,
            address: 'Jacareí / São Paulo - SP (Coordenadas Protegidas OpSec)'
          }
        });
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro ao consultar /api/recipes');
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/recipes') {
      applyCorsHeaders(res);
      try {
        const body = await readJsonBody<{
          rawText?: string;
          recipeUrl?: string;
          previewOnly?: boolean;
          imageBase64?: string;
          mimeType?: string;
          recipe?: ExtractedRecipeInput;
        }>(req);

        let extracted: ExtractedRecipeInput;
        if (body.recipeUrl && body.recipeUrl.trim().length > 0) {
          extracted = await recipeService.extractRecipeFromUrl(body.recipeUrl);
        } else if (body.imageBase64 && body.imageBase64.trim().length > 0) {
          const cleanBase64 = body.imageBase64.replace(/^data:[^;]+;base64,/, '').trim();
          const buffer = Buffer.from(cleanBase64, 'base64');
          extracted = await recipeService.extractRecipeFromImage(
            buffer,
            body.mimeType || 'image/jpeg',
            body.rawText
          );
          if (extracted.isRecipe === false || extracted.ingredients.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                status: 'error',
                message:
                  'A imagem enviada não parece conter uma receita com ingredientes legíveis.'
              })
            );
            return;
          }
        } else if (body.rawText && body.rawText.trim().length > 0) {
          extracted = await recipeService.extractRecipeFromText(body.rawText);
        } else if (body.recipe && body.recipe.name && Array.isArray(body.recipe.ingredients)) {
          extracted = body.recipe;
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              status: 'error',
              message:
                'Envie o texto da receita (rawText), um link (recipeUrl), uma imagem (imageBase64) ou o objeto estruturado recipe.'
            })
          );
          return;
        }

        if (body.previewOnly) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'ok', preview: extracted }));
          return;
        }

        const saved = await recipeService.saveRecipeToDatabase(extracted);
        await dashboardBuilder.publishDashboardSnapshot().catch(() => {});
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', saved }));
      } catch (err) {
        const statusCode =
          err instanceof UnsafeUrlError
            ? 400
            : err instanceof RecipeFetchError
              ? err.statusCode || 422
              : 400;
        logger.error({ err }, '[ArgusRender] Erro ao salvar receita em POST /api/recipes');
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'PATCH' && urlPath === '/api/recipes') {
      applyCorsHeaders(res);
      try {
        const body = await readJsonBody<Partial<UpdateRecipeIngredientInput>>(req);
        if (!body?.recipeId || !body?.productId || !body?.productName) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              status: 'error',
              message: 'Campos obrigatórios ausentes (recipeId, productId, productName).'
            })
          );
          return;
        }
        const { updatedRecipe } = await recipeService.updateRecipeIngredient(
          body as UpdateRecipeIngredientInput
        );
        dashboardBuilder.publishDashboardSnapshot().catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', recipe: updatedRecipe }));
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro ao atualizar ingrediente em PATCH /api/recipes');
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'DELETE' && urlPath === '/api/recipes') {
      applyCorsHeaders(res);
      try {
        const id = new URL(req.url || '/api/recipes', 'http://localhost').searchParams.get('id');
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', message: 'Parâmetro id é obrigatório.' }));
          return;
        }
        await queryArgus(`DELETE FROM argus.recipes WHERE id = $1`, [id]);
        await dashboardBuilder.publishDashboardSnapshot().catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', deletedId: id }));
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro ao remover receita em DELETE /api/recipes');
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

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
          version: APP_VERSION,
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

    if (req.method === 'PATCH' && urlPath === '/api/products') {
      applyCorsHeaders(res);
      try {
        const body = await readJsonBody<UpdateProductInput>(req);
        if (!body?.id || !body?.canonicalProductName) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', message: 'Campos obrigatórios ausentes.' }));
          return;
        }
        const result = await catalogBiService.updateScannedProduct(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', ...result }));
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro ao atualizar produto em /api/products');
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'PATCH' && urlPath === '/api/stores') {
      applyCorsHeaders(res);
      try {
        const body = await readJsonBody<UpdateStoreInput>(req);
        if (!body?.storeId || !body?.tradingName) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', message: 'Campos obrigatórios ausentes.' }));
          return;
        }
        const result = await catalogBiService.updateStoreDetails(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', ...result }));
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro ao atualizar mercado em /api/stores');
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/recipes/pantry-chat') {
      applyCorsHeaders(res);
      try {
        const body = await readJsonBody<{ message?: string; recipes?: any[] }>(req);
        if (!body?.message || !body.message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', message: 'Informe os ingredientes no chat.' }));
          return;
        }
        const result = await pantryGuideService.answerPantryQuery({
          message: body.message,
          recipes: body.recipes
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        logger.error({ err }, '[ArgusRender] Erro em /api/recipes/pantry-chat');
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
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
