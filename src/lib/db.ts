import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  MOCK_STORES,
  MOCK_PRODUCTS,
  MOCK_RECIPES,
  MOCK_RECIPE_INGREDIENTS,
  MOCK_RECEIPTS,
  MOCK_RECEIPT_ITEMS,
  getMockCurrentProductPrices,
  getMockStoreCategoryHeatmap,
  getMockPersonalInflationAndShrinkflation,
  getMockTrueSpendingBreakdown,
  getMockPriceEvolutionSeries
} from './mock-db';

let pgPool: Pool | null = null;
let useMock = false;
let verifiedConnection = false;
let supabaseAdmin: SupabaseClient<any, 'argus'> | null = null;

function hasValidDatabaseConfig(): boolean {
  const conn = env.DIRECT_URL || env.DATABASE_URL;
  return Boolean(conn && conn.trim().length > 0 && !conn.includes('pending'));
}

export function executeMockQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): T[] {
  const norm = text.replace(/\s+/g, ' ').trim();

  // 1. v_current_product_prices
  if (/FROM\s+argus\.v_current_product_prices/i.test(norm)) {
    let list = getMockCurrentProductPrices();
    if (/WHERE\s+category\s*<>\s*'Combustível'/i.test(norm)) {
      list = list.filter((p) => p.category !== 'Combustível');
    }
    if (/product_name\s+ILIKE\s+\$1/i.test(norm) && params?.[0]) {
      const needle = String(params[0]).replace(/%/g, '').toLowerCase();
      list = list.filter((p) =>
        String(p.product_name ?? '')
          .toLowerCase()
          .includes(needle)
      );
    }
    if (/canonical_product_id\s*=\s*\$1\s+AND\s+store_id\s*=\s*\$2/i.test(norm) && params) {
      list = list.filter(
        (p) => p.canonical_product_id === params[0] && p.store_id === params[1]
      );
    } else if (/canonical_product_id\s*=\s*\$1/i.test(norm) && params) {
      list = list.filter((p) => p.canonical_product_id === params[0]);
    }
    if (/ORDER BY.*estimated_package_price ASC\s+LIMIT\s+(\d+)/i.test(norm)) {
      const limitMatch = norm.match(/LIMIT\s+(\d+)/i);
      const limit = limitMatch ? Number(limitMatch[1]) : 9;
      list.sort((a, b) => Number(a.estimated_package_price) - Number(b.estimated_package_price));
      list = list.slice(0, limit);
    }
    return list.map((item) => ({
      ...item,
      standard_package_size: String(item.standard_package_size),
      estimated_base_price: String(item.estimated_base_price),
      estimated_package_price: String(item.estimated_package_price),
      min_historical_price: String(item.min_historical_price),
      max_historical_price: String(item.max_historical_price),
      days_since_last_seen: String(item.days_since_last_seen),
      observations_count: String(item.observations_count)
    })) as unknown as T[];
  }

  // 2. v_store_category_heatmap
  if (/FROM\s+argus\.v_store_category_heatmap/i.test(norm)) {
    return getMockStoreCategoryHeatmap().map((h) => ({
      ...h,
      products_tracked: String(h.products_tracked),
      competitiveness_index: String(h.competitiveness_index),
      basket_category_cost: String(h.basket_category_cost),
      min_days_since_seen: String(h.min_days_since_seen),
      max_days_since_seen: String(h.max_days_since_seen)
    })) as unknown as T[];
  }

  // 3. v_personal_inflation_and_shrinkflation
  if (/FROM\s+argus\.v_personal_inflation_and_shrinkflation/i.test(norm)) {
    return getMockPersonalInflationAndShrinkflation().map((inf) => ({
      ...inf,
      standard_package_size: String(inf.standard_package_size),
      latest_seen_package_size: String(inf.latest_seen_package_size),
      avg_std_package_price: String(inf.avg_std_package_price),
      mom_inflation_pct: String(inf.mom_inflation_pct),
      package_reduction_pct: String(inf.package_reduction_pct)
    })) as unknown as T[];
  }

  // 4. v_true_spending_breakdown
  if (/FROM\s+argus\.v_true_spending_breakdown/i.test(norm)) {
    return getMockTrueSpendingBreakdown().map((b) => ({
      ...b,
      receipts_count: String(b.receipts_count),
      reconciled_receipts_count: String(b.reconciled_receipts_count),
      total_spent: String(b.total_spent)
    })) as unknown as T[];
  }

  // 5. price evolution / receipt items monthly
  if (
    /FROM\s+argus\.receipt_items\s+ri\s+JOIN\s+argus\.receipts/i.test(norm) &&
    /GROUP BY/i.test(norm)
  ) {
    return getMockPriceEvolutionSeries().map((s) => ({
      ...s,
      avg_package_price: String(s.avg_package_price)
    })) as unknown as T[];
  }

  // 6. stores
  if (/FROM\s+argus\.stores/i.test(norm)) {
    if (/WHERE\s+cnpj\s*=\s*\$1/i.test(norm) && params) {
      const match = MOCK_STORES.find(
        (s) => s.cnpj === params[0] || s.raw_name === params[1] || s.trading_name === params[1]
      );
      return match ? ([match] as unknown as T[]) : ([MOCK_STORES[0]] as unknown as T[]);
    }
    return MOCK_STORES.map((s) => ({
      id: s.id,
      trading_name: s.trading_name,
      latitude: String(s.latitude),
      longitude: String(s.longitude)
    })) as unknown as T[];
  }

  // 7. canonical_products
  if (/FROM\s+argus\.canonical_products/i.test(norm)) {
    let prods = MOCK_PRODUCTS;
    if (/is_essential\s*=\s*TRUE/i.test(norm)) {
      prods = prods.filter((p) => p.is_essential);
    }
    if (/category\s*<>\s*'Combustível'/i.test(norm)) {
      prods = prods.filter((p) => p.category !== 'Combustível');
    }
    return prods.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      base_unit: p.base_unit,
      standard_package_size: String(p.standard_package_size),
      is_essential: p.is_essential
    })) as unknown as T[];
  }

  // 8. recipes
  if (/FROM\s+argus\.recipes/i.test(norm)) {
    return MOCK_RECIPES.map((r) => ({
      id: r.id,
      name: r.name,
      yield_portions: r.servings,
      servings: r.servings,
      instructions: r.instructions
    })) as unknown as T[];
  }

  // 9. recipe_ingredients
  if (/FROM\s+argus\.recipe_ingredients\s+ri\s+JOIN\s+argus\.canonical_products\s+cp/i.test(norm)) {
    const recipeId = params?.[0];
    const ings = MOCK_RECIPE_INGREDIENTS.filter((i) => !recipeId || i.recipe_id === recipeId);
    const prodMap = new Map(MOCK_PRODUCTS.map((p) => [p.id, p]));
    return ings.map((i) => {
      const p = prodMap.get(i.canonical_product_id);
      return {
        id: p?.id ?? i.canonical_product_id,
        name: p?.name ?? '',
        category: p?.category ?? 'Mercearia',
        base_unit: p?.base_unit ?? 'g',
        standard_package_size: String(p?.standard_package_size ?? 1000),
        quantity_in_base_unit: String(i.quantity_in_base_unit)
      };
    }) as unknown as T[];
  }

  // 10. receipts join stores
  if (/FROM\s+argus\.receipts\s+r\s+JOIN\s+argus\.stores/i.test(norm)) {
    return MOCK_RECEIPTS.map((r) => ({
      id: r.id,
      store_id: r.store_id,
      store_name: r.store_name,
      purchase_date: r.purchase_date,
      total_amount: String(r.total_amount),
      payment_method: r.payment_method,
      access_key: r.access_key,
      open_finance_tx_id: r.open_finance_tx_id,
      reconciled: r.reconciled
    })) as unknown as T[];
  }

  // 11. update receipts (reconciliation)
  if (/UPDATE\s+argus\.receipts\s+SET\s+reconciled\s*=\s*TRUE/i.test(norm)) {
    const txId = String(params?.[0] ?? '');
    const receiptId = String(params?.[1] ?? '');
    const rec = MOCK_RECEIPTS.find((r) => r.id === receiptId);
    if (rec) {
      rec.reconciled = true;
      rec.open_finance_tx_id = txId;
    }
    return [] as unknown as T[];
  }

  // 12. product_aliases
  if (/FROM\s+argus\.product_aliases/i.test(norm)) {
    const rawDesc = String(params?.[0] ?? '');
    const prod = MOCK_PRODUCTS.find(
      (p) => p.raw_alias === rawDesc || rawDesc.toLowerCase().includes(p.name.toLowerCase())
    );
    if (prod) {
      return [
        {
          canonical_product_id: prod.id,
          package_multiplier: '1',
          last_seen_package_size: String(prod.seen_package_size),
          name: prod.name,
          category: prod.category,
          base_unit: prod.base_unit,
          standard_package_size: String(prod.standard_package_size),
          is_essential: prod.is_essential
        }
      ] as unknown as T[];
    }
    return [] as unknown as T[];
  }

  // 13. receipt_items list
  if (/FROM\s+argus\.receipt_items/i.test(norm)) {
    const prodMap = new Map(MOCK_PRODUCTS.map((p) => [p.id, p]));
    const recMap = new Map(MOCK_RECEIPTS.map((r) => [r.id, r]));
    const nowIso = new Date().toISOString();
    return MOCK_RECEIPT_ITEMS.slice(0, 500).map((it) => {
      const rec = recMap.get(it.receipt_id);
      const prod = prodMap.get(it.canonical_product_id);
      return {
        purchase_date: rec?.purchase_date ?? nowIso,
        store_name: rec?.store_name ?? 'Mercado',
        product_name: prod?.name ?? it.raw_description,
        category: prod?.category ?? 'Mercearia',
        quantity: String(it.quantity),
        unit_type: it.unit_type,
        unit_price: String(it.unit_price),
        total_price: String(it.total_price),
        normalized_price_per_base_unit: String(it.normalized_price_per_base_unit),
        base_unit: prod?.base_unit ?? 'g'
      };
    }) as unknown as T[];
  }

  // 14. collected_prices
  if (/FROM\s+argus\.collected_prices/i.test(norm)) {
    return [] as unknown as T[];
  }

  // 15. media_processing_queue
  if (/FROM\s+argus\.media_processing_queue/i.test(norm)) {
    return [] as unknown as T[];
  }

  // 16. Inserts with RETURNING id
  if (/INSERT INTO/i.test(norm)) {
    return [{ id: 'mock-gen-' + Math.random().toString(36).substring(2, 9) }] as unknown as T[];
  }

  return [] as unknown as T[];
}

export function getArgusPool(): Pool {
  if (!pgPool) {
    if (!hasValidDatabaseConfig()) {
      useMock = true;
    }
    const isRenderEnv = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
    // No Render (sem IPv6 de saída), prioriza DATABASE_URL (Supavisor Pooler IPv4) antes de DIRECT_URL
    const rawConn = isRenderEnv
      ? env.DATABASE_URL || env.DIRECT_URL
      : env.DIRECT_URL || env.DATABASE_URL;
    const connectionString =
      (rawConn || '').replace(/^["']|["']$/g, '').trim() || 'postgresql://localhost:5432/mock';
    pgPool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000
    });
  }
  return pgPool;
}

export async function queryArgus<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  if (useMock || !hasValidDatabaseConfig()) {
    return executeMockQuery<T>(text, params);
  }

  try {
    const pool = getArgusPool();
    const res = await pool.query<T>(text, params);
    verifiedConnection = true;
    return res.rows;
  } catch (err) {
    if (!verifiedConnection) {
      logger.warn({ err }, '[Argus DB] Banco offline — ativando repositório em memória/mock');
      useMock = true;
      return executeMockQuery<T>(text, params);
    }
    throw err;
  }
}

export async function withArgusTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (useMock || !hasValidDatabaseConfig()) {
    // Stub de PoolClient em memória
    const mockClient = {
      query: async (queryText: string, params?: unknown[]) => {
        const rows = executeMockQuery(queryText, params);
        return { rows, rowCount: rows.length };
      },
      release: () => {}
    } as unknown as PoolClient;
    return fn(mockClient);
  }

  try {
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
  } catch (connectErr) {
    logger.warn({ connectErr }, '[Argus DB] Conexão direta falhou no transaction — chaveando para mock em memória');
    useMock = true;
    const mockClient = {
      query: async (queryText: string, params?: unknown[]) => {
        const rows = executeMockQuery(queryText, params);
        return { rows, rowCount: rows.length };
      },
      release: () => {}
    } as unknown as PoolClient;
    return fn(mockClient);
  }
}

export function getSupabaseArgusClient(): SupabaseClient<any, 'argus'> | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  if (!supabaseAdmin) {
    supabaseAdmin = createClient<any, 'argus'>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: 'argus' },
      auth: { persistSession: false }
    });
  }
  return supabaseAdmin;
}
