-- =============================================================================
-- MIGRATION 004: Coleta Visual de Preços (Vídeos de Corredor, Fotos de Gôndola e
-- Panfletos/Flyers) com Score de Confiabilidade e Fila Resiliente de Processamento
-- =============================================================================

BEGIN;

-- 1. Tabela de Controle de Mídias e Fila de Reprocessamento Automático
CREATE TABLE IF NOT EXISTS argus.media_processing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL,
  telegram_message_id BIGINT,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  media_kind VARCHAR(32) NOT NULL, -- 'RECEIPT_PHOTO', 'SHELF_PHOTO', 'MARKET_FLYER', 'AISLE_VIDEO'
  mime_type VARCHAR(64),
  user_caption TEXT,
  storage_bucket VARCHAR(64) NOT NULL DEFAULT 'FotosArgus',
  storage_path TEXT,
  original_size_bytes BIGINT,
  compressed_size_bytes BIGINT,
  media_sha256 VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'SUCCEEDED', 'QUEUED_RETRY', 'FAILED_PERMANENT', 'SKIPPED_DUPLICATE'
  attempts_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  store_name_detected TEXT,
  store_location_detected TEXT,
  overall_confidence_pct NUMERIC(5,2),
  confidence_warnings TEXT[] NOT NULL DEFAULT '{}',
  items_extracted_count INT NOT NULL DEFAULT 0,
  result_summary JSONB,
  raw_ai_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

ALTER TABLE argus.media_processing_queue
  ADD COLUMN IF NOT EXISTS raw_ai_response JSONB;

CREATE INDEX IF NOT EXISTS idx_argus_media_queue_status_retry
  ON argus.media_processing_queue (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_argus_media_queue_sha256
  ON argus.media_processing_queue (media_sha256)
  WHERE media_sha256 IS NOT NULL;

-- 2. Tabela de Preços Coletados (Gôndolas, Vídeos de Corredor e Panfletos/Flyers)
CREATE TABLE IF NOT EXISTS argus.collected_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_job_id UUID REFERENCES argus.media_processing_queue(id) ON DELETE CASCADE,
  store_id UUID REFERENCES argus.stores(id) ON DELETE SET NULL,
  canonical_product_id UUID REFERENCES argus.canonical_products(id) ON DELETE SET NULL,
  source_type VARCHAR(32) NOT NULL, -- 'AISLE_VIDEO', 'SHELF_PHOTO', 'MARKET_FLYER'
  store_name_detected TEXT NOT NULL,
  store_location_detected TEXT,
  raw_product_description TEXT NOT NULL,
  canonical_product_name TEXT NOT NULL,
  category VARCHAR(64) NOT NULL DEFAULT 'Mercearia',
  unit_type VARCHAR(16) NOT NULL DEFAULT 'UN',
  base_unit VARCHAR(16) NOT NULL DEFAULT 'un',
  package_size_in_base_unit NUMERIC(12,3) NOT NULL DEFAULT 1,
  collected_price NUMERIC(12,2) NOT NULL,
  promo_club_price NUMERIC(12,2),
  normalized_price_per_base_unit NUMERIC(12,6) NOT NULL,
  confidence_score_pct NUMERIC(5,2) NOT NULL,
  missing_info_flags TEXT[] NOT NULL DEFAULT '{}',
  confidence_explanation TEXT NOT NULL,
  video_timestamp_sec NUMERIC(8,2),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_argus_collected_prices_product
  ON argus.collected_prices (canonical_product_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_argus_collected_prices_store
  ON argus.collected_prices (store_id, collected_at DESC);

-- 3. Atualiza a View Analítica de Preços Atuais (`argus.v_current_product_prices`)
-- para unificar tanto os preços de Cupons Fiscais (`receipt_items`) quanto os
-- Preços Coletados em Gôndolas/Vídeos/Flyers (`collected_prices`).
CREATE OR REPLACE VIEW argus.v_current_product_prices AS
WITH unified_observations AS (
  -- Observações de Cupons Fiscais (confiabilidade 100%)
  SELECT
    ri.canonical_product_id,
    r.store_id,
    r.purchase_date AS observed_at,
    ri.normalized_price_per_base_unit
  FROM argus.receipt_items ri
  JOIN argus.receipts r ON r.id = ri.receipt_id
  WHERE ri.normalized_price_per_base_unit > 0

  UNION ALL

  -- Observações de Gôndolas, Vídeos e Panfletos (quando vinculadas a uma loja)
  SELECT
    cp_obs.canonical_product_id,
    cp_obs.store_id,
    cp_obs.collected_at AS observed_at,
    cp_obs.normalized_price_per_base_unit
  FROM argus.collected_prices cp_obs
  WHERE cp_obs.canonical_product_id IS NOT NULL
    AND cp_obs.store_id IS NOT NULL
    AND cp_obs.normalized_price_per_base_unit > 0
),
ranked_prices AS (
  SELECT
    uo.canonical_product_id,
    cp.name AS product_name,
    cp.category,
    cp.base_unit,
    cp.standard_package_size,
    cp.is_essential,
    uo.store_id,
    s.trading_name AS store_name,
    uo.observed_at AS purchase_date,
    uo.normalized_price_per_base_unit,
    ROW_NUMBER() OVER (
      PARTITION BY uo.canonical_product_id, uo.store_id
      ORDER BY uo.observed_at DESC
    ) AS rn,
    COUNT(*) OVER (
      PARTITION BY uo.canonical_product_id, uo.store_id
    ) AS observations_count,
    MIN(uo.normalized_price_per_base_unit * cp.standard_package_size) OVER (
      PARTITION BY uo.canonical_product_id
    ) AS min_historical_price,
    MAX(uo.normalized_price_per_base_unit * cp.standard_package_size) OVER (
      PARTITION BY uo.canonical_product_id
    ) AS max_historical_price
  FROM unified_observations uo
  JOIN argus.canonical_products cp ON cp.id = uo.canonical_product_id
  JOIN argus.stores s ON s.id = uo.store_id
),
weighted_calc AS (
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
    MAX(CASE WHEN rn = 1 THEN purchase_date END) AS last_seen_at,
    MAX(observations_count) AS observations_count,
    MIN(min_historical_price) AS min_historical_price,
    MAX(max_historical_price) AS max_historical_price
  FROM ranked_prices
  WHERE rn <= 4
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
  ROUND(min_historical_price, 2) AS min_historical_price,
  ROUND(max_historical_price, 2) AS max_historical_price,
  GREATEST(0, EXTRACT(DAY FROM (NOW() - last_seen_at))::INT) AS days_since_last_seen,
  last_seen_at,
  observations_count
FROM weighted_calc;

COMMIT;
