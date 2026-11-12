import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import { Client as PgClient } from 'pg';
import { PluggyClient as PluggySdkClient } from 'pluggy-sdk';
import dotenv from 'dotenv';

const ENV_PATH = path.resolve(process.cwd(), '.env');
dotenv.config({ path: ENV_PATH });

const REQUIRED_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'PLUGGY_CLIENT_ID',
  'PLUGGY_CLIENT_SECRET',
  'GOOGLE_SPREADSHEET_ID',
  'HOME_LAT',
  'HOME_LNG'
] as const;

async function testPostgresConnection(): Promise<{ ok: boolean; detail: string }> {
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) return { ok: false, detail: 'DATABASE_URL/DIRECT_URL ausente (usando repositório local/seed)' };
  const client = new PgClient({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 6000
  });
  try {
    await client.connect();
    const res = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'argus'"
    );
    return {
      ok: true,
      detail: `Conectado ao Supabase Postgres (schema 'argus' com ${res.rows[0]?.cnt ?? 0} tabelas/views)`
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    await client.end().catch(() => {});
  }
}

async function testGoogleSheetsConnection(): Promise<{ ok: boolean; detail: string }> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!email || !key || !spreadsheetId || spreadsheetId === 'argus-ledger-sheet-pending') {
    return { ok: false, detail: 'Credenciais ou GOOGLE_SPREADSHEET_ID pendentes' };
  }
  try {
    const auth = new google.auth.JWT({
      email,
      key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    return {
      ok: true,
      detail: `Planilha ativa: "${meta.data.properties?.title}" (${meta.data.sheets?.length ?? 0} abas)`
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function testPluggyConnection(): Promise<{ ok: boolean; detail: string }> {
  const clientId = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, detail: 'PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET ausentes' };
  }
  try {
    const sdk = new PluggySdkClient({ clientId, clientSecret });
    await sdk.createConnectToken();
    return { ok: true, detail: 'Autenticado na Pluggy Open Finance API com sucesso' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function testGeminiConnection(): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, detail: 'GEMINI_API_KEY não preenchida (usando heurística local + cache)' };
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash',
      {
        headers: {
          'X-goog-api-key': key
        }
      }
    );
    if (res.ok) return { ok: true, detail: 'Modelo gemini-3.8-flash / gemini-flash-latest acessível via Google AI Studio' };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function testTelegramConnection(): Promise<{ ok: boolean; detail: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, detail: 'TELEGRAM_BOT_TOKEN não preenchido (modo simulador/local pronto)' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    if (data.ok) return { ok: true, detail: `Bot conectado: @${data.result?.username}` };
    return { ok: false, detail: 'Token inválido na API do Telegram' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function testOsrmConnection(): Promise<{ ok: boolean; detail: string }> {
  const lat = Number(process.env.HOME_LAT || -23.561414);
  const lng = Number(process.env.HOME_LNG || -46.655881);
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng},${lat};${lng + 0.01},${lat + 0.01}?overview=false`;
    const res = await fetch(url);
    if (res.ok) return { ok: true, detail: `OSRM Router online para Casa (${lat}, ${lng})` };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function main() {
  console.log('======================================================================');
  console.log('👁️  ARGUS (moneta-argus) - Diagnóstico de Ambiente & Conectividade');
  console.log('======================================================================');

  for (const key of REQUIRED_KEYS) {
    const val = process.env[key];
    const isSet = Boolean(val && val.trim().length > 0);
    const preview = isSet
      ? key.includes('KEY') || key.includes('SECRET') || key.includes('TOKEN')
        ? '[CONFIGURADO - OCULTO]'
        : val
      : '[PENDENTE]';
    console.log(` • ${key.padEnd(28)}: ${isSet ? '✅' : '⚠️ '} ${preview}`);
  }

  if (process.argv.includes('--interactive') && input.isTTY) {
    const rl = readline.createInterface({ input, output });
    for (const key of REQUIRED_KEYS) {
      if (!process.env[key]) {
        const answer = await rl.question(`Informe valor para ${key} (Enter para manter vazio): `);
        if (answer.trim()) {
          process.env[key] = answer.trim();
        }
      }
    }
    rl.close();
  }

  console.log('\n----------------------------------------------------------------------');
  console.log('🔌 Testando Conectividade dos Provedores (Zero-Cost Stack):');
  console.log('----------------------------------------------------------------------');

  const [pgRes, sheetsRes, pluggyRes, geminiRes, tgRes, osrmRes] = await Promise.all([
    testPostgresConnection(),
    testGoogleSheetsConnection(),
    testPluggyConnection(),
    testGeminiConnection(),
    testTelegramConnection(),
    testOsrmConnection()
  ]);

  console.log(` • Supabase / Postgres (schema argus) : ${pgRes.ok ? '✅' : 'ℹ️ '} ${pgRes.detail}`);
  console.log(` • Google Sheets API (Argus Ledger)   : ${sheetsRes.ok ? '✅' : 'ℹ️ '} ${sheetsRes.detail}`);
  console.log(` • Pluggy Open Finance API            : ${pluggyRes.ok ? '✅' : 'ℹ️ '} ${pluggyRes.detail}`);
  console.log(` • Google Gemini 2.5 Flash API        : ${geminiRes.ok ? '✅' : 'ℹ️ '} ${geminiRes.detail}`);
  console.log(` • Telegram Bot (@MonetaArgusBot)     : ${tgRes.ok ? '✅' : 'ℹ️ '} ${tgRes.detail}`);
  console.log(` • OSRM Free Routing Engine           : ${osrmRes.ok ? '✅' : 'ℹ️ '} ${osrmRes.detail}`);
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('[Argus Env Check] Erro:', err);
  process.exit(1);
});
