import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { Client as PgClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const MONETA_ENV_PATH =
  process.env.MONETA_SYNC_ENV_PATH ||
  path.resolve(process.cwd(), '..', 'MonetaSync', 'apps', 'backend', '.env');
const MONETA_SA_JSON_PATH =
  process.env.MONETA_SYNC_SA_PATH || '';
const ARGUS_ENV_PATH = path.resolve(process.cwd(), '.env');
const MIGRATION_SQL_PATH = path.resolve(process.cwd(), 'migrations', '001_init_argus_schema.sql');

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const map: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    map[key] = val;
  }
  return map;
}

function writeArgusEnv(values: Record<string, string>) {
  const lines = [
    '# =============================================================================',
    '# ARGUS (moneta-argus) - O Olho Fiscal do Ecossistema Moneta',
    '# Provisionado automaticamente com isolamento total do MonetaSync',
    '# =============================================================================',
    `NODE_ENV=${values.NODE_ENV || 'development'}`,
    `PORT=${values.PORT || '3000'}`,
    `LOG_LEVEL=${values.LOG_LEVEL || 'info'}`,
    '',
    '# 1. Telegram Bot (@MonetaArgusBot - O Olho Fiscal)',
    `TELEGRAM_BOT_TOKEN=${values.TELEGRAM_BOT_TOKEN || ''}`,
    `TELEGRAM_DEFAULT_CHAT_ID=${values.TELEGRAM_DEFAULT_CHAT_ID || ''}`,
    '',
    '# 2. Google Gemini API (Google AI Studio Free Tier - gemini-2.5-flash)',
    `GEMINI_API_KEY=${values.GEMINI_API_KEY || ''}`,
    '',
    '# 3. Supabase (Schema Isolado: argus)',
    `SUPABASE_URL=${values.SUPABASE_URL || ''}`,
    `SUPABASE_SERVICE_ROLE_KEY=${values.SUPABASE_SERVICE_ROLE_KEY || ''}`,
    `DATABASE_URL="${values.DATABASE_URL || ''}"`,
    `DIRECT_URL="${values.DIRECT_URL || ''}"`,
    '',
    '# 4. Open Finance (Pluggy API)',
    `PLUGGY_CLIENT_ID=${values.PLUGGY_CLIENT_ID || ''}`,
    `PLUGGY_CLIENT_SECRET=${values.PLUGGY_CLIENT_SECRET || ''}`,
    `PLUGGY_ITEM_IDS=${values.PLUGGY_ITEM_IDS || ''}`,
    '',
    '# 5. Google Sheets ("Argus - Controle de Mercado & Receitas")',
    `GOOGLE_SERVICE_ACCOUNT_EMAIL=${values.GOOGLE_SERVICE_ACCOUNT_EMAIL || ''}`,
    `GOOGLE_PRIVATE_KEY="${(values.GOOGLE_PRIVATE_KEY || '').replace(/\r?\n/g, '\\n')}"`,
    `GOOGLE_SPREADSHEET_ID=${values.GOOGLE_SPREADSHEET_ID || ''}`,
    `USER_SHARE_EMAIL=${values.USER_SHARE_EMAIL || ''}`,
    '',
    '# 6. Logística e Roteirização OSRM (Gasolina vs. Uber)',
    `HOME_LAT=${values.HOME_LAT || '-23.561414'}`,
    `HOME_LNG=${values.HOME_LNG || '-46.655881'}`,
    `HOME_ADDRESS="${values.HOME_ADDRESS || 'Av. Paulista, 1578 - Bela Vista, São Paulo - SP'}"`,
    `CAR_KM_PER_LITER=${values.CAR_KM_PER_LITER || '10.5'}`,
    `GAS_PRICE_PER_LITER=${values.GAS_PRICE_PER_LITER || '5.89'}`,
    `UBER_BASE_FARE=${values.UBER_BASE_FARE || '3.50'}`,
    `UBER_RATE_PER_KM=${values.UBER_RATE_PER_KM || '1.65'}`,
    `UBER_RATE_PER_MIN=${values.UBER_RATE_PER_MIN || '0.28'}`,
    `UBER_MIN_TRIP_FARE=${values.UBER_MIN_TRIP_FARE || '8.90'}`,
    `MIN_SAVINGS_HURDLE=${values.MIN_SAVINGS_HURDLE || '25.00'}`,
    ''
  ];
  fs.writeFileSync(ARGUS_ENV_PATH, lines.join('\n'), 'utf8');
}

async function provisionArgusSpreadsheet(
  clientEmail: string,
  privateKey: string,
  shareEmail: string,
  existingSpreadsheetId?: string
): Promise<string> {
  if (!clientEmail || !privateKey) {
    console.warn('[Argus Setup] Service Account ausente. Pulando criação de planilha online.');
    return existingSpreadsheetId || '';
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Se já temos um ID próprio do Argus (diferente da planilha do Moneta), verifica se existe
  if (existingSpreadsheetId) {
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: existingSpreadsheetId });
      if (meta.data.properties?.title?.includes('Argus')) {
        console.log(`[Argus Setup] Planilha isolada do Argus já ativa: ${meta.data.properties?.title} (${existingSpreadsheetId})`);
        return existingSpreadsheetId;
      }
    } catch {
      // Se falhar, cria uma nova
    }
  }

  console.log('[Argus Setup] Criando nova Planilha Google isolada: "Argus - Controle de Mercado & Receitas"...');
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: 'Argus - Controle de Mercado & Receitas',
        locale: 'pt_BR'
      },
      sheets: [
        { properties: { title: 'Transacoes_OpenFinance' } },
        { properties: { title: 'Historico_Itens' } },
        { properties: { title: 'Comparativo_Mercados' } },
        { properties: { title: 'Receitas_Custos' } }
      ]
    }
  });

  const newSpreadsheetId = createRes.data.spreadsheetId!;
  console.log(`[Argus Setup] Nova Planilha criada com sucesso! ID: ${newSpreadsheetId}`);

  // Popula cabeçalhos das 4 abas
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: newSpreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: 'Transacoes_OpenFinance!A1:I1',
          values: [[
            'ID Transação',
            'Data',
            'Carteira',
            'Descrição Fatura',
            'Valor (R$)',
            'Categoria',
            'Conciliado com Cupom?',
            'ID Cupom Fiscal',
            'Sincronizado Em'
          ]]
        },
        {
          range: 'Historico_Itens!A1:J1',
          values: [[
            'Data Compra',
            'Mercado',
            'Descrição Nota',
            'Produto Canônico',
            'Categoria',
            'Essencial?',
            'Qtd',
            'Unidade',
            'Total Pago (R$)',
            'Preço Base (R$/g ou ml ou un)'
          ]]
        },
        {
          range: 'Comparativo_Mercados!A1:H1',
          values: [[
            'Produto Canônico',
            'Categoria',
            'Mercado',
            'Preço Estimado Pacote (R$)',
            'Mínimo Histórico (R$)',
            'Máximo Histórico (R$)',
            'Dias Desde Última Leitura',
            'Status Oportunidade'
          ]]
        },
        {
          range: 'Receitas_Custos!A1:G1',
          values: [[
            'Receita',
            'Rendimento (Porções)',
            'Custo Proporcional Total (R$)',
            'Custo por Porção/Marmita (R$)',
            'Desembolso de Caixa (Embalagens Fechadas R$)',
            'Melhor Mercado Único',
            'Atualizado Em'
          ]]
        }
      ]
    }
  });

  if (shareEmail) {
    try {
      await drive.permissions.create({
        fileId: newSpreadsheetId,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: shareEmail
        },
        fields: 'id'
      });
      console.log(`[Argus Setup] Planilha compartilhada como Editor com: ${shareEmail}`);
    } catch (shareErr) {
      console.warn('[Argus Setup] Aviso ao compartilhar planilha via Drive API:', (shareErr as Error).message);
    }
  }

  return newSpreadsheetId;
}

async function applyArgusSchemaMigration(dbUrl: string) {
  if (!dbUrl) {
    console.warn('[Argus Setup] DATABASE_URL não configurada; migração será aplicada quando disponível.');
    return;
  }

  const sql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  const client = new PgClient({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('[Argus Setup] Conectado ao PostgreSQL/Supabase. Aplicando schema isolado `argus`...');
    await client.query(sql);
    console.log('[Argus Setup] Schema `argus` e 4 Views Analíticas de BI aplicadas com sucesso!');
  } catch (err) {
    console.warn('[Argus Setup] Aviso ao aplicar migration no PostgreSQL remoto:', (err as Error).message);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log('======================================================================');
  console.log('👁️  ARGUS (moneta-argus) - Provisionamento Isolado de Recursos');
  console.log('======================================================================');

  const monetaEnv = parseEnvFile(MONETA_ENV_PATH);
  const argusEnv = parseEnvFile(ARGUS_ENV_PATH);

  let saEmail = argusEnv.GOOGLE_SERVICE_ACCOUNT_EMAIL || monetaEnv.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  let saKey = argusEnv.GOOGLE_PRIVATE_KEY || monetaEnv.GOOGLE_PRIVATE_KEY || '';

  if ((!saEmail || !saKey) && fs.existsSync(MONETA_SA_JSON_PATH)) {
    const saJson = JSON.parse(fs.readFileSync(MONETA_SA_JSON_PATH, 'utf8'));
    saEmail = saJson.client_email || saEmail;
    saKey = saJson.private_key || saKey;
  }

  const dbUrl = argusEnv.DIRECT_URL || argusEnv.DATABASE_URL || monetaEnv.DIRECT_URL || monetaEnv.DATABASE_URL || '';
  const poolerUrl = argusEnv.DATABASE_URL || monetaEnv.DATABASE_URL || dbUrl;

  // Extrai project ref do Supabase se possível para montar SUPABASE_URL
  let supabaseUrl = argusEnv.SUPABASE_URL || '';
  if (!supabaseUrl && dbUrl) {
    const match = dbUrl.match(/postgres\.([a-z0-9]+):/i) || dbUrl.match(/db\.([a-z0-9]+)\.supabase\.co/i);
    if (match?.[1]) {
      supabaseUrl = `https://${match[1]}.supabase.co`;
    }
  }

  const shareEmail = argusEnv.USER_SHARE_EMAIL || '';

  // IMPORTANTE: Nunca reutiliza o GOOGLE_SPREADSHEET_ID do MonetaSync!
  const currentArgusSheetId =
    argusEnv.GOOGLE_SPREADSHEET_ID &&
    argusEnv.GOOGLE_SPREADSHEET_ID !== monetaEnv.GOOGLE_SPREADSHEET_ID
      ? argusEnv.GOOGLE_SPREADSHEET_ID
      : '';

  let newSheetId = currentArgusSheetId;
  try {
    newSheetId = await provisionArgusSpreadsheet(saEmail, saKey, shareEmail, currentArgusSheetId);
  } catch (err) {
    console.warn('[Argus Setup] Não foi possível criar planilha online agora (usando fallback):', (err as Error).message);
  }

  const mergedEnv: Record<string, string> = {
    ...argusEnv,
    SUPABASE_URL: supabaseUrl,
    DATABASE_URL: poolerUrl,
    DIRECT_URL: dbUrl,
    PLUGGY_CLIENT_ID: argusEnv.PLUGGY_CLIENT_ID || monetaEnv.PLUGGY_CLIENT_ID || '',
    PLUGGY_CLIENT_SECRET: argusEnv.PLUGGY_CLIENT_SECRET || monetaEnv.PLUGGY_CLIENT_SECRET || '',
    PLUGGY_ITEM_IDS: argusEnv.PLUGGY_ITEM_IDS || monetaEnv.PLUGGY_ITEM_IDS || '',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: saEmail,
    GOOGLE_PRIVATE_KEY: saKey,
    GOOGLE_SPREADSHEET_ID: newSheetId || 'argus-ledger-sheet-pending',
    USER_SHARE_EMAIL: shareEmail
  };

  writeArgusEnv(mergedEnv);
  console.log('[Argus Setup] Arquivo `.env` do `moneta-argus` atualizado com segurança.');

  await applyArgusSchemaMigration(dbUrl || poolerUrl);
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('[Argus Setup] Erro fatal:', err);
  process.exit(1);
});
