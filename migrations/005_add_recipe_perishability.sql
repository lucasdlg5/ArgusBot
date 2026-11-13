-- =============================================================================
-- ARGUS (moneta-argus)
-- Migration: 005_add_recipe_perishability.sql
-- Adiciona metadados de perecibilidade (cadeia fria) para roteirização de
-- compras de receitas (não perecíveis primeiro, perecíveis/congelados por último)
-- =============================================================================

ALTER TABLE argus.canonical_products
  ADD COLUMN IF NOT EXISTS perishability_tier TEXT
    CHECK (perishability_tier IN ('NON_PERISHABLE', 'SEMI_PERISHABLE', 'REFRIGERATED', 'FROZEN_OR_DELICATE'));

ALTER TABLE argus.canonical_products
  ADD COLUMN IF NOT EXISTS perishability_rank INTEGER
    CHECK (perishability_rank BETWEEN 1 AND 4);

ALTER TABLE argus.canonical_products
  ADD COLUMN IF NOT EXISTS perishability_reason TEXT;

ALTER TABLE argus.recipes
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE argus.recipes
  ADD COLUMN IF NOT EXISTS prep_time_minutes INTEGER;

ALTER TABLE argus.recipes
  ADD COLUMN IF NOT EXISTS difficulty TEXT;

ALTER TABLE argus.recipes
  ADD COLUMN IF NOT EXISTS cuisine_tags TEXT[];

ALTER TABLE argus.recipes
  ADD COLUMN IF NOT EXISTS estimated_calories_per_portion INTEGER;

CREATE INDEX IF NOT EXISTS idx_argus_recipes_name ON argus.recipes(name);

