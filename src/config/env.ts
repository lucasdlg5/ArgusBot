import dns from 'node:dns';
import net from 'node:net';
import 'dotenv/config';
import { z } from 'zod';

// Evita travamentos de 5 minutos (TypeError: fetch failed) no Windows quando a rota IPv6 da operadora falha
try {
  dns.setDefaultResultOrder('ipv4first');
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(false);
  }
} catch {
  // Ignorado caso não suportado pelo runtime
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Telegram Bot (@MonetaArgusBot)
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_DEFAULT_CHAT_ID: z.string().default(''),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  TELEGRAM_ALLOWED_USERNAMES: z
    .string()
    .default('AsminnAeterna')
    .transform((v) =>
      v
        .split(',')
        .map((u) => u.replace(/^@/, '').trim().toLowerCase())
        .filter(Boolean)
    ),

  // Google Gemini (Zero-Cost Google AI Studio)
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),

  // Supabase / PostgreSQL (Schema isolado: argus) & Storage Bucket (FotosArgus)
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_STORAGE_BUCKET: z.string().default('FotosArgus'),
  DATABASE_URL: z.string().default(''),
  DIRECT_URL: z.string().default(''),

  // URL pública do Dashboard Web (quando hospedado em produção; vazio se ainda não hospedado)
  PUBLIC_DASHBOARD_URL: z.string().default(''),

  // Open Finance (Pluggy API - Herdado de MonetaSync)
  PLUGGY_CLIENT_ID: z.string().default(''),
  PLUGGY_CLIENT_SECRET: z.string().default(''),
  PLUGGY_ITEM_IDS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),

  // Google Sheets ("Argus - Controle de Mercado & Receitas")
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
  GOOGLE_PRIVATE_KEY: z
    .string()
    .default('')
    .transform((v) => v.replace(/\\n/g, '\n')),
  GOOGLE_SPREADSHEET_ID: z.string().default(''),
  USER_SHARE_EMAIL: z.string().default(''),

  // Coordenadas da Casa & Parâmetros Logísticos (Gasolina vs. Uber)
  HOME_LAT: z.coerce.number().default(-23.561414),
  HOME_LNG: z.coerce.number().default(-46.655881),
  HOME_ADDRESS: z.string().default('Av. Paulista, 1578 - Bela Vista, São Paulo - SP'),
  CAR_KM_PER_LITER: z.coerce.number().positive().default(10.5),
  GAS_PRICE_PER_LITER: z.coerce.number().positive().default(5.89),
  UBER_BASE_FARE: z.coerce.number().nonnegative().default(3.5),
  UBER_RATE_PER_KM: z.coerce.number().nonnegative().default(1.65),
  UBER_RATE_PER_MIN: z.coerce.number().nonnegative().default(0.28),
  UBER_MIN_TRIP_FARE: z.coerce.number().nonnegative().default(8.9),
  MIN_SAVINGS_HURDLE: z.coerce.number().nonnegative().default(25.0),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    '[Argus Env] Falha na validação de configuração:',
    parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  );
}

export const env = parsed.success ? parsed.data : envSchema.parse({});
