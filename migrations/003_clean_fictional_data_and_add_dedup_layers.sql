-- =============================================================================
-- MIGRATION 003: Limpeza de Dados Fictícios (Seed) e Camadas de Deduplicação de Cupons
-- Mantém apenas dados reais a partir de hoje (preservando argus.security_audit_logs)
-- e adiciona colunas de verificação multicamada em argus.receipts.
-- =============================================================================

BEGIN;

-- 1. Limpa todos os dados fictícios de seed (respeitando a ordem das Foreign Keys)
DELETE FROM argus.receipt_items;
DELETE FROM argus.receipts;
DELETE FROM argus.recipe_ingredients;
DELETE FROM argus.recipes;
DELETE FROM argus.product_aliases;
DELETE FROM argus.canonical_products;
DELETE FROM argus.stores;

-- 2. Adiciona colunas para as 4 camadas de verificação contra duplicidade em argus.receipts
ALTER TABLE argus.receipts
  ADD COLUMN IF NOT EXISTS has_official_access_key BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(64),
  ADD COLUMN IF NOT EXISTS image_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS normalized_image_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS content_fingerprint VARCHAR(64);

-- 3. Índices de busca rápida e unicidade para as camadas de deduplicação
CREATE INDEX IF NOT EXISTS idx_argus_receipts_image_sha256
  ON argus.receipts (image_sha256)
  WHERE image_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_argus_receipts_norm_image_sha256
  ON argus.receipts (normalized_image_sha256)
  WHERE normalized_image_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_argus_receipts_content_fingerprint
  ON argus.receipts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_argus_receipts_receipt_number
  ON argus.receipts (store_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

COMMIT;
