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
  MOCK_COLLECTED_PRICES,
  getMockCurrentProductPrices,
  getMockStoreCategoryHeatmap,
  getMockPersonalInflationAndShrinkflation,
  getMockTrueSpendingBreakdown,
  getMockPriceEvolutionSeries
} from './mock-db';

const globalForArgusDb = globalThis as unknown as {
  __argusPgPool?: Pool;
  __argusUseMock?: boolean;
  __argusVerifiedConnection?: boolean;
};

let pgPool: Pool | null = globalForArgusDb.__argusPgPool ?? null;
let useMock = globalForArgusDb.__argusUseMock ?? false;
let verifiedConnection = globalForArgusDb.__argusVerifiedConnection ?? false;
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
      cnpj: s.cnpj,
      raw_name: s.raw_name,
      trading_name: s.trading_name,
      address: s.address,
      latitude: String(s.latitude),
      longitude: String(s.longitude)
    })) as unknown as T[];
  }

  // 7. canonical_products (INSERT/UPSERT + SELECT)
  if (/INSERT\s+INTO\s+argus\.canonical_products/i.test(norm)) {
    const name = String(params?.[0] ?? '').trim();
    const category = (params?.[1] ?? 'Mercearia') as (typeof MOCK_PRODUCTS)[number]['category'];
    const baseUnit = (params?.[2] ?? 'g') as (typeof MOCK_PRODUCTS)[number]['base_unit'];
    const stdPkg = Number(params?.[3] ?? 1000) || 1000;
    const isEssential = params?.[4] !== undefined ? Boolean(params[4]) : true;

    const existing = MOCK_PRODUCTS.find(
      (p) => p.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      return [{ id: existing.id }] as unknown as T[];
    }

    const newId = `prod-custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    MOCK_PRODUCTS.push({
      id: newId,
      name,
      category,
      base_unit: baseUnit,
      standard_package_size: stdPkg,
      is_essential: isEssential,
      raw_alias: name.toUpperCase(),
      seen_package_size: stdPkg,
      unit_type: baseUnit === 'ml' ? 'LT' : baseUnit === 'un' ? 'UN' : 'KG',
      has_price_observations: false,
      prices: {
        neSupermercado: [0, 0, 0],
        mercadoSouza: [0, 0, 0]
      }
    });
    return [{ id: newId }] as unknown as T[];
  }

  if (/FROM\s+argus\.canonical_products/i.test(norm)) {
    let prods = MOCK_PRODUCTS;
    if (/is_essential\s*=\s*TRUE/i.test(norm)) {
      prods = prods.filter((p) => p.is_essential);
    }
    if (/category\s*<>\s*'Combustível'/i.test(norm)) {
      prods = prods.filter((p) => p.category !== 'Combustível');
    }
    if (/LOWER\(name\)\s*=\s*LOWER\(\$1\)/i.test(norm) && params?.[0]) {
      const target = String(params[0]).toLowerCase();
      prods = prods.filter((p) => p.name.toLowerCase() === target);
    } else if (/name\s+ILIKE\s+\$1/i.test(norm) && params?.[0]) {
      const needle = String(params[0]).replace(/%/g, '').toLowerCase();
      prods = prods.filter((p) => p.name.toLowerCase().includes(needle));
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

  // 8. recipes (INSERT/UPSERT + DELETE + SELECT)
  if (/INSERT\s+INTO\s+argus\.recipes/i.test(norm)) {
    const name = String(params?.[0] ?? '').trim();
    const servings = Math.max(1, Math.round(Number(params?.[1] ?? 4)));
    const instructions = String(params?.[2] ?? '').trim();

    const existing = MOCK_RECIPES.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.name = name;
      existing.servings = servings;
      existing.instructions = instructions;
      return [{ id: existing.id }] as unknown as T[];
    }
    const newId = `recipe-custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    MOCK_RECIPES.push({ id: newId, name, servings, instructions });
    return [{ id: newId }] as unknown as T[];
  }

  if (/DELETE\s+FROM\s+argus\.recipes/i.test(norm)) {
    const recipeId = String(params?.[0] ?? '');
    const idx = MOCK_RECIPES.findIndex((r) => r.id === recipeId);
    if (idx >= 0) {
      MOCK_RECIPES.splice(idx, 1);
    }
    for (let i = MOCK_RECIPE_INGREDIENTS.length - 1; i >= 0; i--) {
      if (MOCK_RECIPE_INGREDIENTS[i].recipe_id === recipeId) {
        MOCK_RECIPE_INGREDIENTS.splice(i, 1);
      }
    }
    return [] as unknown as T[];
  }

  if (/FROM\s+argus\.recipes/i.test(norm)) {
    let list = [...MOCK_RECIPES];
    if (/WHERE\s+id\s*=\s*\$1/i.test(norm) && params?.[0]) {
      list = list.filter((r) => r.id === params[0]);
    } else if (/WHERE\s+name\s+ILIKE\s+\$1/i.test(norm) && params?.[0]) {
      const needle = String(params[0]).replace(/%/g, '').toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(needle));
    }
    list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return list.map((r) => ({
      id: r.id,
      name: r.name,
      yield_portions: r.servings,
      servings: r.servings,
      instructions: r.instructions
    })) as unknown as T[];
  }

  // 9. recipe_ingredients (DELETE + INSERT + SELECT)
  if (/DELETE\s+FROM\s+argus\.recipe_ingredients/i.test(norm)) {
    const recipeId = String(params?.[0] ?? '');
    for (let i = MOCK_RECIPE_INGREDIENTS.length - 1; i >= 0; i--) {
      if (MOCK_RECIPE_INGREDIENTS[i].recipe_id === recipeId) {
        MOCK_RECIPE_INGREDIENTS.splice(i, 1);
      }
    }
    return [] as unknown as T[];
  }

  if (/INSERT\s+INTO\s+argus\.recipe_ingredients/i.test(norm)) {
    const recipeId = String(params?.[0] ?? '');
    const canonicalProductId = String(params?.[1] ?? '');
    const qty = Number(params?.[2] ?? 0);
    const existing = MOCK_RECIPE_INGREDIENTS.find(
      (i) => i.recipe_id === recipeId && i.canonical_product_id === canonicalProductId
    );
    if (existing) {
      existing.quantity_in_base_unit = qty;
    } else {
      MOCK_RECIPE_INGREDIENTS.push({
        recipe_id: recipeId,
        canonical_product_id: canonicalProductId,
        quantity_in_base_unit: qty
      });
    }
    return [] as unknown as T[];
  }

  if (/FROM\s+argus\.recipe_ingredients\s+ri\s+JOIN\s+argus\.canonical_products\s+cp/i.test(norm)) {
    const recipeId = params?.[0];
    const ings = MOCK_RECIPE_INGREDIENTS.filter((i) => !recipeId || i.recipe_id === recipeId);
    const prodMap = new Map(MOCK_PRODUCTS.map((p) => [p.id, p]));
    return ings.map((i) => {
      const p = prodMap.get(i.canonical_product_id);
      return {
        id: p?.id ?? i.canonical_product_id,
        canonical_product_id: p?.id ?? i.canonical_product_id,
        name: p?.name ?? '',
        product_name: p?.name ?? '',
        category: p?.category ?? 'Mercearia',
        base_unit: p?.base_unit ?? 'g',
        standard_package_size: String(p?.standard_package_size ?? 1000),
        quantity_in_base_unit: String(i.quantity_in_base_unit)
      };
    }) as unknown as T[];
  }

  // 10. receipts join stores
  if (/FROM\s+argus\.receipts\s+r\s+JOIN\s+argus\.stores/i.test(norm)) {
    const storeMap = new Map(MOCK_STORES.map((s) => [s.id, s]));
    return MOCK_RECEIPTS.map((r) => {
      const store = storeMap.get(r.store_id);
      return {
        id: r.id,
        store_id: r.store_id,
        store_name: store?.trading_name ?? r.store_name,
        store_address: store?.address ?? '',
        purchase_date: r.purchase_date,
        total_amount: String(r.total_amount),
        discount_amount: String(r.discount_amount ?? 0),
        payment_method: r.payment_method,
        access_key: r.access_key,
        open_finance_tx_id: r.open_finance_tx_id,
        reconciled: r.reconciled
      };
    }) as unknown as T[];
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

  // 13. historical item observations across receipt_items + collected_prices
  if (/AS\s+observed_at/i.test(norm) && /FROM\s+argus\.receipt_items/i.test(norm)) {
    const prodMap = new Map(MOCK_PRODUCTS.map((p) => [p.id, p]));
    const recMap = new Map(MOCK_RECEIPTS.map((r) => [r.id, r]));
    const nowIso = new Date().toISOString();
    return MOCK_RECEIPT_ITEMS.map((it) => {
      const rec = recMap.get(it.receipt_id);
      const prod = prodMap.get(it.canonical_product_id);
      const stdPkg = Number(prod?.standard_package_size ?? 1);
      const basePrice = Number(it.normalized_price_per_base_unit);
      return {
        canonical_product_id: it.canonical_product_id,
        store_name: rec?.store_name ?? 'NE SUPERMERCADO',
        observed_at: rec?.purchase_date ?? nowIso,
        base_price: basePrice,
        package_price: Number((basePrice * stdPkg).toFixed(2)),
        source_type: 'CUPOM_FISCAL'
      };
    }) as unknown as T[];
  }

  // 14. receipt_items list
  if (/FROM\s+argus\.receipt_items/i.test(norm)) {
    const prodMap = new Map(MOCK_PRODUCTS.map((p) => [p.id, p]));
    const recMap = new Map(MOCK_RECEIPTS.map((r) => [r.id, r]));
    const storeMap = new Map(MOCK_STORES.map((s) => [s.id, s]));
    const nowIso = new Date().toISOString();
    return MOCK_RECEIPT_ITEMS.slice(0, 500).map((it) => {
      const rec = recMap.get(it.receipt_id);
      const store = rec ? storeMap.get(rec.store_id) : undefined;
      const prod = prodMap.get(it.canonical_product_id);
      return {
        id: it.id,
        receipt_id: it.receipt_id,
        store_id: rec?.store_id ?? null,
        store_name: store?.trading_name ?? rec?.store_name ?? 'Mercado',
        store_address: store?.address ?? 'Local não informado',
        purchase_date: rec?.purchase_date ?? nowIso,
        payment_method: rec?.payment_method ?? 'PIX',
        raw_description: it.raw_description,
        canonical_product_id: it.canonical_product_id,
        canonical_product_name: prod?.name ?? it.raw_description,
        product_name: prod?.name ?? it.raw_description,
        category: prod?.category ?? 'Mercearia',
        is_essential: prod?.is_essential ?? true,
        standard_package_size: String(prod?.standard_package_size ?? 1),
        quantity: String(it.quantity),
        unit_type: it.unit_type,
        unit_price: String(it.unit_price),
        total_price: String(it.total_price),
        normalized_price_per_base_unit: String(it.normalized_price_per_base_unit),
        base_unit: prod?.base_unit ?? 'g'
      };
    }) as unknown as T[];
  }

  // 15. collected_prices (observações históricas de flyers e fotos)
  if (/FROM\s+argus\.collected_prices/i.test(norm)) {
    if (/AS\s+observed_at/i.test(norm)) {
      return MOCK_COLLECTED_PRICES.map((c) => ({
        canonical_product_id: c.canonical_product_id,
        store_name: c.store_name,
        observed_at: c.collected_at,
        base_price: c.normalized_price_per_base_unit,
        package_price: c.package_price,
        source_type: c.source_type
      })) as unknown as T[];
    }
    const prodMap = new Map(MOCK_PRODUCTS.map((p) => [p.id, p]));
    const storeMap = new Map(MOCK_STORES.map((s) => [s.id, s]));
    return MOCK_COLLECTED_PRICES.map((c) => {
      const prod = prodMap.get(c.canonical_product_id);
      const store = storeMap.get(c.store_id);
      return {
        id: c.id,
        source_kind: c.source_type,
        store_id: c.store_id,
        store_name: store?.trading_name ?? c.store_name,
        store_neighborhood: store?.address ?? 'Jacareí - SP',
        raw_product_description: `${prod?.raw_alias ?? 'ITEM'} (${c.source_type === 'MARKET_FLYER' ? 'FOLHETO' : 'GONDOLA'})`,
        canonical_product_id: c.canonical_product_id,
        canonical_product_name: prod?.name ?? 'Produto',
        category: prod?.category ?? 'Mercearia',
        is_essential: prod?.is_essential ?? true,
        unit_type: prod?.unit_type ?? 'UN',
        base_unit: prod?.base_unit ?? 'un',
        package_size_in_base_unit: prod?.standard_package_size ?? 1,
        standard_package_size: prod?.standard_package_size ?? 1,
        price: c.package_price,
        promo_or_club_price: null,
        normalized_price_per_base_unit: c.normalized_price_per_base_unit,
        confidence_score: 94,
        missing_info_flags: [],
        collected_at: c.collected_at
      };
    }) as unknown as T[];
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
      globalForArgusDb.__argusUseMock = true;
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
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
    globalForArgusDb.__argusPgPool = pgPool;
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

  const pool = getArgusPool();
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await pool.query<T>(text, params);
      verifiedConnection = true;
      globalForArgusDb.__argusVerifiedConnection = true;
      return res.rows;
    } catch (err) {
      const msg = (err as Error)?.message || '';
      const isPoolExhausted =
        msg.includes('EMAXCONNSESSION') ||
        msg.toLowerCase().includes('max clients reached') ||
        msg.toLowerCase().includes('too many clients');

      if (isPoolExhausted && attempt < maxAttempts) {
        await new Promise((res) => setTimeout(res, 200 * attempt));
        continue;
      }

      if (!verifiedConnection && !isPoolExhausted) {
        logger.warn({ err }, '[Argus DB] Banco offline — ativando repositório em memória/mock');
        useMock = true;
        globalForArgusDb.__argusUseMock = true;
        return executeMockQuery<T>(text, params);
      }
      throw err;
    }
  }
  return [];
}

export async function withArgusTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (useMock || !hasValidDatabaseConfig()) {
    // Stub de PoolClient em memória (apenas quando não há banco configurado)
    const mockClient = {
      query: async (queryText: string, params?: unknown[]) => {
        const rows = executeMockQuery(queryText, params);
        return { rows, rowCount: rows.length };
      },
      release: () => {}
    } as unknown as PoolClient;
    return fn(mockClient);
  }

  const pool = getArgusPool();
  const maxAttempts = 3;
  let client: PoolClient | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      client = await pool.connect();
      verifiedConnection = true;
      globalForArgusDb.__argusVerifiedConnection = true;
      break;
    } catch (connectErr) {
      const msg = (connectErr as Error)?.message || '';
      const isPoolExhausted =
        msg.includes('EMAXCONNSESSION') ||
        msg.toLowerCase().includes('max clients reached') ||
        msg.toLowerCase().includes('too many clients');

      if (isPoolExhausted && attempt < maxAttempts) {
        await new Promise((res) => setTimeout(res, 200 * attempt));
        continue;
      }

      if (!verifiedConnection && !isPoolExhausted) {
        logger.warn({ connectErr }, '[Argus DB] Conexão direta falhou no transaction — chaveando para mock em memória');
        useMock = true;
        globalForArgusDb.__argusUseMock = true;
        const mockClient = {
          query: async (queryText: string, params?: unknown[]) => {
            const rows = executeMockQuery(queryText, params);
            return { rows, rowCount: rows.length };
          },
          release: () => {}
        } as unknown as PoolClient;
        return fn(mockClient);
      }

      throw connectErr;
    }
  }

  if (!client) {
    throw new Error('Não foi possível obter conexão PostgreSQL do pool.');
  }

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, '[Argus DB] Transaction rollback');
    throw err;
  } finally {
    client.release();
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
