-- =============================================================================
-- ARGUS (moneta-argus) - O Olho Fiscal do Ecossistema Moneta
-- Migration: 001_init_argus_schema.sql
-- Isolamento total no schema `argus` para não conflitar com o banco do MonetaSync
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS argus;

-- 1. STORES (Mercados e Estabelecimentos)
CREATE TABLE IF NOT EXISTS argus.stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj VARCHAR(18) UNIQUE NOT NULL,
  raw_name TEXT NOT NULL,
  trading_name TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude NUMERIC(10, 7) NOT NULL,
  longitude NUMERIC(10, 7) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. CANONICAL PRODUCTS (Catálogo Normalizado por Unidade Base: g, ml, un)
CREATE TABLE IF NOT EXISTS argus.canonical_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'Carnes',
      'Laticínios',
      'Hortifruti',
      'Mercearia',
      'Limpeza',
      'Higiene',
      'Bebidas',
      'Besteiras/Impulso',
      'Combustível'
    )
  ),
  base_unit TEXT NOT NULL CHECK (base_unit IN ('g', 'ml', 'un')),
  standard_package_size NUMERIC(10, 3) NOT NULL,
  is_essential BOOLEAN NOT NULL DEFAULT TRUE
);

-- 3. PRODUCT ALIASES (Cache de Normalização & Detector de Reduflação)
CREATE TABLE IF NOT EXISTS argus.product_aliases (
  raw_description TEXT PRIMARY KEY,
  ean VARCHAR(20),
  canonical_product_id UUID NOT NULL REFERENCES argus.canonical_products(id) ON DELETE CASCADE,
  package_multiplier NUMERIC(10, 3) NOT NULL DEFAULT 1,
  last_seen_package_size NUMERIC(10, 3) NOT NULL
);

-- 4. RECEIPTS (Cupons Fiscais NFC-e / SAT-CF-e & Conciliação Open Finance)
CREATE TABLE IF NOT EXISTS argus.receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES argus.stores(id) ON DELETE RESTRICT,
  purchase_date TIMESTAMPTZ NOT NULL,
  total_amount NUMERIC(10, 2) NOT NULL,
  discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL CHECK (
    payment_method IN ('PIX', 'CREDIT_CARD', 'DEBIT', 'VR_VA', 'CASH')
  ),
  access_key VARCHAR(44) UNIQUE NOT NULL,
  open_finance_tx_id TEXT UNIQUE,
  reconciled BOOLEAN NOT NULL DEFAULT FALSE
);

-- 5. RECEIPT ITEMS (Itens dos Cupons com Preço Normalizado por g/ml/un)
CREATE TABLE IF NOT EXISTS argus.receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES argus.receipts(id) ON DELETE CASCADE,
  canonical_product_id UUID NOT NULL REFERENCES argus.canonical_products(id) ON DELETE RESTRICT,
  raw_description TEXT NOT NULL,
  quantity NUMERIC(10, 3) NOT NULL,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('KG', 'UN', 'LT')),
  unit_price NUMERIC(10, 4) NOT NULL,
  total_price NUMERIC(10, 2) NOT NULL,
  normalized_price_per_base_unit NUMERIC(10, 6) NOT NULL
);

-- 6. RECIPES & RECIPE INGREDIENTS (Motor de Custo de Receitas / Marmitas)
CREATE TABLE IF NOT EXISTS argus.recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  servings INTEGER NOT NULL CHECK (servings > 0),
  instructions TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS argus.recipe_ingredients (
  recipe_id UUID NOT NULL REFERENCES argus.recipes(id) ON DELETE CASCADE,
  canonical_product_id UUID NOT NULL REFERENCES argus.canonical_products(id) ON DELETE RESTRICT,
  quantity_in_base_unit NUMERIC(10, 3) NOT NULL,
  PRIMARY KEY (recipe_id, canonical_product_id)
);

-- Índices para performance analítica
CREATE INDEX IF NOT EXISTS idx_argus_receipts_store_date ON argus.receipts(store_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_argus_receipt_items_product ON argus.receipt_items(canonical_product_id);
CREATE INDEX IF NOT EXISTS idx_argus_receipt_items_receipt ON argus.receipt_items(receipt_id);

-- =============================================================================
-- VIEWS ANALÍTICAS PARA O ARGUS VISION BI
-- =============================================================================

-- VIEW 1: v_current_product_prices
-- Preço estimado atual em cada mercado com decaimento temporal:
-- 70% último preço + 30% média dos 3 anteriores, além de min, max e dias desde a última leitura.
CREATE OR REPLACE VIEW argus.v_current_product_prices AS
WITH ranked_observations AS (
  SELECT
    ri.canonical_product_id,
    cp.name AS product_name,
    cp.category,
    cp.base_unit,
    cp.standard_package_size,
    cp.is_essential,
    r.store_id,
    s.trading_name AS store_name,
    r.purchase_date,
    ri.normalized_price_per_base_unit,
    (ri.normalized_price_per_base_unit * cp.standard_package_size) AS standard_package_price,
    ROW_NUMBER() OVER (
      PARTITION BY ri.canonical_product_id, r.store_id
      ORDER BY r.purchase_date DESC, ri.id DESC
    ) AS rn
  FROM argus.receipt_items ri
  JOIN argus.receipts r ON r.id = ri.receipt_id
  JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
  JOIN argus.stores s ON s.id = r.store_id
),
aggregated AS (
  SELECT
    canonical_product_id,
    product_name,
    category,
    base_unit,
    standard_package_size,
    is_essential,
    store_id,
    store_name,
    MAX(CASE WHEN rn = 1 THEN normalized_price_per_base_unit END) AS latest_base_price,
    AVG(CASE WHEN rn BETWEEN 2 AND 4 THEN normalized_price_per_base_unit END) AS prev3_avg_base_price,
    MIN(normalized_price_per_base_unit) AS min_historical_base_price,
    MAX(normalized_price_per_base_unit) AS max_historical_base_price,
    MAX(purchase_date) AS last_seen_at,
    COUNT(*) AS observations_count
  FROM ranked_observations
  GROUP BY
    canonical_product_id,
    product_name,
    category,
    base_unit,
    standard_package_size,
    is_essential,
    store_id,
    store_name
)
SELECT
  canonical_product_id,
  product_name,
  category,
  base_unit,
  standard_package_size,
  is_essential,
  store_id,
  store_name,
  ROUND(
    COALESCE(
      0.70 * latest_base_price + 0.30 * COALESCE(prev3_avg_base_price, latest_base_price),
      latest_base_price
    ),
    6
  ) AS estimated_base_price,
  ROUND(
    COALESCE(
      0.70 * latest_base_price + 0.30 * COALESCE(prev3_avg_base_price, latest_base_price),
      latest_base_price
    ) * standard_package_size,
    2
  ) AS estimated_package_price,
  ROUND(min_historical_base_price * standard_package_size, 2) AS min_historical_price,
  ROUND(max_historical_base_price * standard_package_size, 2) AS max_historical_price,
  EXTRACT(DAY FROM (NOW() - last_seen_at))::INT AS days_since_last_seen,
  last_seen_at,
  observations_count
FROM aggregated;

-- VIEW 2: v_store_category_heatmap
-- Índice de competitividade de cada categoria por mercado (100 = média de mercado, < 100 = mais barato)
CREATE OR REPLACE VIEW argus.v_store_category_heatmap AS
WITH product_market_bench AS (
  SELECT
    v.*,
    AVG(v.estimated_package_price) OVER (PARTITION BY v.canonical_product_id) AS market_avg_package_price
  FROM argus.v_current_product_prices v
)
SELECT
  store_id,
  store_name,
  category,
  COUNT(DISTINCT canonical_product_id) AS products_tracked,
  ROUND(AVG(
    CASE
      WHEN market_avg_package_price > 0 THEN (estimated_package_price / market_avg_package_price) * 100.0
      ELSE 100.0
    END
  ), 1) AS competitiveness_index,
  ROUND(SUM(estimated_package_price), 2) AS basket_category_cost,
  MIN(days_since_last_seen) AS min_days_since_seen,
  MAX(days_since_last_seen) AS max_days_since_seen,
  CASE
    WHEN AVG(days_since_last_seen) < 15 THEN '< 15 dias'
    WHEN AVG(days_since_last_seen) <= 30 THEN '15-30 dias'
    ELSE '> 30 dias'
  END AS freshness_tier
FROM product_market_bench
GROUP BY store_id, store_name, category;

-- VIEW 3: v_personal_inflation_and_shrinkflation
-- Inflação mensal da cesta pessoal e detecção de Reduflação (Shrinkflation)
CREATE OR REPLACE VIEW argus.v_personal_inflation_and_shrinkflation AS
WITH monthly_prices AS (
  SELECT
    ri.canonical_product_id,
    cp.name AS product_name,
    cp.category,
    cp.base_unit,
    cp.standard_package_size,
    DATE_TRUNC('month', r.purchase_date) AS ref_month,
    AVG(ri.normalized_price_per_base_unit) AS avg_base_price,
    AVG(ri.normalized_price_per_base_unit * cp.standard_package_size) AS avg_std_package_price
  FROM argus.receipt_items ri
  JOIN argus.receipts r ON r.id = ri.receipt_id
  JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
  GROUP BY
    ri.canonical_product_id,
    cp.name,
    cp.category,
    cp.base_unit,
    cp.standard_package_size,
    DATE_TRUNC('month', r.purchase_date)
),
with_lags AS (
  SELECT
    mp.*,
    LAG(mp.avg_base_price) OVER (
      PARTITION BY mp.canonical_product_id
      ORDER BY mp.ref_month
    ) AS prev_month_base_price
  FROM monthly_prices mp
),
alias_shrink AS (
  SELECT
    pa.canonical_product_id,
    MIN(pa.last_seen_package_size) AS min_seen_package_size,
    MAX(pa.last_seen_package_size) AS max_seen_package_size
  FROM argus.product_aliases pa
  GROUP BY pa.canonical_product_id
)
SELECT
  wl.canonical_product_id,
  wl.product_name,
  wl.category,
  wl.base_unit,
  wl.standard_package_size,
  COALESCE(ash.min_seen_package_size, wl.standard_package_size) AS latest_seen_package_size,
  wl.ref_month,
  ROUND(wl.avg_std_package_price, 2) AS avg_std_package_price,
  ROUND(
    CASE
      WHEN wl.prev_month_base_price > 0
      THEN ((wl.avg_base_price - wl.prev_month_base_price) / wl.prev_month_base_price) * 100.0
      ELSE 0.0
    END,
    2
  ) AS mom_inflation_pct,
  (
    COALESCE(ash.min_seen_package_size, wl.standard_package_size) < wl.standard_package_size
    AND COALESCE(wl.avg_base_price, 0) >= COALESCE(wl.prev_month_base_price, 0)
  ) AS shrinkflation_detected,
  ROUND(
    CASE
      WHEN COALESCE(ash.min_seen_package_size, wl.standard_package_size) < wl.standard_package_size
      THEN ((wl.standard_package_size - ash.min_seen_package_size) / wl.standard_package_size) * 100.0
      ELSE 0.0
    END,
    1
  ) AS package_reduction_pct
FROM with_lags wl
LEFT JOIN alias_shrink ash ON ash.canonical_product_id = wl.canonical_product_id;

-- VIEW 4: v_true_spending_breakdown
-- Cruza transações e cupons para revelar Alimentação Essencial vs. Limpeza/Higiene vs. Besteiras/Impulso
-- separado por Conta Bancária (PIX/CREDIT_CARD/DEBIT/CASH) vs. VR/VA.
CREATE OR REPLACE VIEW argus.v_true_spending_breakdown AS
SELECT
  DATE_TRUNC('month', r.purchase_date) AS ref_month,
  CASE
    WHEN r.payment_method = 'VR_VA' THEN 'VR_VA'
    ELSE 'BANK_ACCOUNT'
  END AS wallet_source,
  r.payment_method,
  cp.category,
  cp.is_essential,
  CASE
    WHEN cp.category IN ('Besteiras/Impulso') OR cp.is_essential = FALSE THEN 'Besteiras/Impulso'
    WHEN cp.category IN ('Limpeza', 'Higiene') THEN 'Limpeza & Higiene'
    WHEN cp.category = 'Combustível' THEN 'Combustível & Logística'
    ELSE 'Alimentação Essencial'
  END AS spending_pillar,
  COUNT(DISTINCT r.id) AS receipts_count,
  COUNT(DISTINCT CASE WHEN r.reconciled THEN r.id END) AS reconciled_receipts_count,
  ROUND(SUM(ri.total_price), 2) AS total_spent
FROM argus.receipt_items ri
JOIN argus.receipts r ON r.id = ri.receipt_id
JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
GROUP BY
  DATE_TRUNC('month', r.purchase_date),
  CASE WHEN r.payment_method = 'VR_VA' THEN 'VR_VA' ELSE 'BANK_ACCOUNT' END,
  r.payment_method,
  cp.category,
  cp.is_essential;
