import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../config/logger';

let pgPool: Pool | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supabaseAdmin: SupabaseClient<any, any, any> | null = null;

/**
 * Pool PostgreSQL direto apontando para o Supabase (com search_path = argus, public).
 * Garante isolamento total das tabelas do MonetaSync (que ficam em public).
 */
export function getArgusPool(): Pool {
  if (!pgPool) {
    const isRenderEnv = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
    // No Render (sem IPv6 de saída), prioriza DATABASE_URL (Supavisor Pooler IPv4) antes de DIRECT_URL
    const connectionString = isRenderEnv
      ? env.DATABASE_URL || env.DIRECT_URL
      : env.DIRECT_URL || env.DATABASE_URL;
    pgPool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000
    });
  }
  return pgPool;
}

export async function queryArgus<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = getArgusPool();
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function withArgusTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getArgusPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[Argus DB] Transaction rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cliente Supabase JS oficial configurado no schema `argus` quando SUPABASE_SERVICE_ROLE_KEY estiver presente.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabaseArgusClient(): SupabaseClient<any, any, any> | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  if (!supabaseAdmin) {
    supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: 'argus' },
      auth: { persistSession: false }
    });
  }
  return supabaseAdmin;
}
