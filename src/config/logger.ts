import pino from 'pino';
import { env } from './env';

/**
 * Logger estruturado do Argus (moneta-argus) com redaction herdada do MonetaSync
 * para garantir que tokens, chaves privadas e payloads bancários jamais apareçam nos logs.
 */
export const logger = pino({
  name: 'moneta-argus',
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.token',
      '*.accessToken',
      '*.clientSecret',
      '*.privateKey',
      '*.GEMINI_API_KEY',
      '*.TELEGRAM_BOT_TOKEN',
      '*.SUPABASE_SERVICE_ROLE_KEY',
      '*.GOOGLE_PRIVATE_KEY',
      '*.PLUGGY_CLIENT_SECRET'
    ],
    censor: '[REDACTED_BY_ARGUS]'
  }
});
