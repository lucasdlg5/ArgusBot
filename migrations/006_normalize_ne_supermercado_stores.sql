-- =============================================================================
-- ARGUS (moneta-argus)
-- Migration: 006_normalize_ne_supermercado_stores.sql
-- Normaliza variantes de flyers/cupons (NE, CLUBE NE, NOVA ÉPOCA SUPERMERCADOS)
-- consolidando todos os registros não-Mercado Souza sob o nome principal
-- "NE SUPERMERCADO", preservando apenas os 2 mercados reais na base.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS argus.store_aliases (
  alias_normalized TEXT PRIMARY KEY,
  raw_alias TEXT NOT NULL,
  canonical_store_id UUID NOT NULL REFERENCES argus.stores(id) ON DELETE CASCADE,
  match_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_argus_store_aliases_store_id
  ON argus.store_aliases(canonical_store_id);

DO $$
DECLARE
  v_souza_id UUID;
  v_ne_id UUID;
  v_best_ne_address TEXT;
  r_store RECORD;
  v_clean_trading TEXT;
  v_clean_raw TEXT;
  v_reason TEXT;
BEGIN
  -- 1. Identifica o registro principal do MERCADO SOUZA (se existir)
  SELECT s.id
  INTO v_souza_id
  FROM argus.stores s
  WHERE UPPER(
    TRANSLATE(COALESCE(s.trading_name, '') || ' ' || COALESCE(s.raw_name, ''),
      'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
      'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')
  ) ~ '(^|[^A-Z0-9])SOUZA([^A-Z0-9]|$)'
  ORDER BY
    CASE WHEN s.cnpj NOT LIKE '99.%' AND s.cnpj NOT LIKE '00.%' THEN 0 ELSE 1 END,
    (
      (SELECT COUNT(*) FROM argus.receipts rc WHERE rc.store_id = s.id) +
      (SELECT COUNT(*) FROM argus.collected_prices cp WHERE cp.store_id = s.id)
    ) DESC,
    s.created_at ASC
  LIMIT 1;

  IF v_souza_id IS NOT NULL THEN
    -- Consolida eventuais duplicatas de Mercado Souza
    FOR r_store IN
      SELECT s.id, s.raw_name, s.trading_name
      FROM argus.stores s
      WHERE s.id <> v_souza_id
        AND UPPER(
          TRANSLATE(COALESCE(s.trading_name, '') || ' ' || COALESCE(s.raw_name, ''),
            'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
            'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')
        ) ~ '(^|[^A-Z0-9])SOUZA([^A-Z0-9]|$)'
    LOOP
      v_clean_trading := TRIM(REGEXP_REPLACE(UPPER(TRANSLATE(COALESCE(r_store.trading_name, ''),
        'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
        'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')), '[^A-Z0-9]+', ' ', 'g'));
      IF v_clean_trading <> '' THEN
        INSERT INTO argus.store_aliases (alias_normalized, raw_alias, canonical_store_id, match_reason)
        VALUES (v_clean_trading, r_store.trading_name, v_souza_id, 'MERCADO_SOUZA')
        ON CONFLICT (alias_normalized) DO UPDATE SET canonical_store_id = v_souza_id;
      END IF;

      UPDATE argus.receipts SET store_id = v_souza_id WHERE store_id = r_store.id;
      UPDATE argus.collected_prices
         SET store_id = v_souza_id, store_name_detected = 'MERCADO SOUZA'
       WHERE store_id = r_store.id;
      DELETE FROM argus.stores WHERE id = r_store.id;
    END LOOP;

    UPDATE argus.stores
       SET trading_name = 'MERCADO SOUZA'
     WHERE id = v_souza_id;

    UPDATE argus.collected_prices
       SET store_name_detected = 'MERCADO SOUZA'
     WHERE store_id = v_souza_id;

    INSERT INTO argus.store_aliases (alias_normalized, raw_alias, canonical_store_id, match_reason)
    VALUES
      ('MERCADO SOUZA', 'MERCADO SOUZA', v_souza_id, 'MERCADO_SOUZA'),
      ('SUPERMERCADO SOUZA', 'SUPERMERCADO SOUZA', v_souza_id, 'MERCADO_SOUZA')
    ON CONFLICT (alias_normalized) DO UPDATE SET canonical_store_id = v_souza_id;
  END IF;

  -- 2. Seleciona o registro sobrevivente principal para NE SUPERMERCADO
  --    dentre todos os registros que NÃO são Mercado Souza
  SELECT s.id
  INTO v_ne_id
  FROM argus.stores s
  WHERE (v_souza_id IS NULL OR s.id <> v_souza_id)
  ORDER BY
    CASE WHEN s.cnpj NOT LIKE '99.%' AND s.cnpj NOT LIKE '00.%' THEN 0 ELSE 1 END,
    CASE WHEN UPPER(s.trading_name) = 'NE SUPERMERCADO' THEN 0 ELSE 1 END,
    (
      (SELECT COUNT(*) FROM argus.receipts rc WHERE rc.store_id = s.id) +
      (SELECT COUNT(*) FROM argus.collected_prices cp WHERE cp.store_id = s.id)
    ) DESC,
    s.created_at ASC
  LIMIT 1;

  IF v_ne_id IS NOT NULL THEN
    -- Preserva melhor endereço real se o registro sobrevivente estiver com placeholder genérico
    SELECT s.address
    INTO v_best_ne_address
    FROM argus.stores s
    WHERE (v_souza_id IS NULL OR s.id <> v_souza_id)
      AND COALESCE(s.address, '') <> ''
      AND s.address NOT ILIKE '%pendente%'
      AND s.address NOT ILIKE '%não informado%'
      AND s.address NOT ILIKE '%nao informado%'
      AND s.address NOT ILIKE '%recuperado%'
    ORDER BY LENGTH(s.address) DESC, s.created_at ASC
    LIMIT 1;

    -- Analisa e mescla TODAS as variantes não-Souza para NE SUPERMERCADO
    FOR r_store IN
      SELECT s.id, s.raw_name, s.trading_name
      FROM argus.stores s
      WHERE (v_souza_id IS NULL OR s.id <> v_souza_id)
    LOOP
      v_clean_trading := TRIM(REGEXP_REPLACE(UPPER(TRANSLATE(COALESCE(r_store.trading_name, ''),
        'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
        'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')), '[^A-Z0-9]+', ' ', 'g'));
      v_clean_raw := TRIM(REGEXP_REPLACE(UPPER(TRANSLATE(COALESCE(r_store.raw_name, ''),
        'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
        'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')), '[^A-Z0-9]+', ' ', 'g'));

      IF v_clean_trading ~ 'CLUBE' THEN
        v_reason := 'CLUBE_FIDELIDADE_NE';
      ELSIF v_clean_trading ~ 'NOVA EPOCA' OR v_clean_raw ~ 'NOVA EPOCA' THEN
        v_reason := 'RAZAO_SOCIAL_NOVA_EPOCA';
      ELSIF v_clean_trading ~ '(^| )NE( |$)' THEN
        v_reason := 'SIGLA_NE';
      ELSE
        v_reason := 'REGISTRO_NAO_SOUZA_ATUAL';
      END IF;

      IF v_clean_trading <> '' THEN
        INSERT INTO argus.store_aliases (alias_normalized, raw_alias, canonical_store_id, match_reason)
        VALUES (v_clean_trading, r_store.trading_name, v_ne_id, v_reason)
        ON CONFLICT (alias_normalized) DO UPDATE
          SET canonical_store_id = v_ne_id, match_reason = EXCLUDED.match_reason;
      END IF;

      IF v_clean_raw <> '' AND v_clean_raw <> v_clean_trading THEN
        INSERT INTO argus.store_aliases (alias_normalized, raw_alias, canonical_store_id, match_reason)
        VALUES (v_clean_raw, r_store.raw_name, v_ne_id, v_reason)
        ON CONFLICT (alias_normalized) DO UPDATE
          SET canonical_store_id = v_ne_id, match_reason = EXCLUDED.match_reason;
      END IF;

      IF r_store.id <> v_ne_id THEN
        UPDATE argus.receipts SET store_id = v_ne_id WHERE store_id = r_store.id;
        UPDATE argus.collected_prices
           SET store_id = v_ne_id, store_name_detected = 'NE SUPERMERCADO'
         WHERE store_id = r_store.id;
        DELETE FROM argus.stores WHERE id = r_store.id;
      END IF;
    END LOOP;

    UPDATE argus.stores
       SET trading_name = 'NE SUPERMERCADO',
           raw_name = 'NE SUPERMERCADO',
           address = COALESCE(v_best_ne_address, address)
     WHERE id = v_ne_id;

    -- Garante aliases canônicos conhecidos para futuras leituras de flyers/gôndolas
    INSERT INTO argus.store_aliases (alias_normalized, raw_alias, canonical_store_id, match_reason)
    VALUES
      ('NE', 'NE', v_ne_id, 'SIGLA_NE'),
      ('N E', 'N.E.', v_ne_id, 'SIGLA_NE'),
      ('CLUBE NE', 'CLUBE NE', v_ne_id, 'CLUBE_FIDELIDADE_NE'),
      ('NOVA EPOCA', 'NOVA ÉPOCA', v_ne_id, 'RAZAO_SOCIAL_NOVA_EPOCA'),
      ('NOVA EPOCA SUPERMERCADOS', 'NOVA ÉPOCA SUPERMERCADOS', v_ne_id, 'RAZAO_SOCIAL_NOVA_EPOCA'),
      ('NOVA EPOCA SUPERMERCADO', 'NOVA ÉPOCA SUPERMERCADO', v_ne_id, 'RAZAO_SOCIAL_NOVA_EPOCA'),
      ('SUPERMERCADO NOVA EPOCA', 'SUPERMERCADO NOVA ÉPOCA', v_ne_id, 'RAZAO_SOCIAL_NOVA_EPOCA'),
      ('NE SUPERMERCADO', 'NE SUPERMERCADO', v_ne_id, 'SIGLA_NE'),
      ('NE SUPERMERCADOS', 'NE SUPERMERCADOS', v_ne_id, 'SIGLA_NE'),
      ('SUPERMERCADO NE', 'SUPERMERCADO NE', v_ne_id, 'SIGLA_NE')
    ON CONFLICT (alias_normalized) DO UPDATE SET canonical_store_id = v_ne_id;

    -- Normaliza collected_prices restantes que não são Mercado Souza
    UPDATE argus.collected_prices
       SET store_id = v_ne_id,
           store_name_detected = 'NE SUPERMERCADO'
     WHERE store_id = v_ne_id
        OR (
          (v_souza_id IS NULL OR store_id IS DISTINCT FROM v_souza_id)
          AND COALESCE(store_name_detected, '') <> ''
          AND store_name_detected NOT ILIKE '%souza%'
          AND store_name_detected NOT ILIKE '%não identificada%'
          AND store_name_detected NOT ILIKE '%nao identificada%'
          AND store_name_detected NOT ILIKE '%pendente%'
        );

    -- Normaliza o histórico da fila de mídia (mantendo placeholders pendentes intactos)
    UPDATE argus.media_processing_queue
       SET store_name_detected = CASE
         WHEN store_name_detected ILIKE '%souza%' THEN 'MERCADO SOUZA'
         ELSE 'NE SUPERMERCADO'
       END
     WHERE COALESCE(store_name_detected, '') <> ''
       AND store_name_detected NOT ILIKE '%não identificada%'
       AND store_name_detected NOT ILIKE '%nao identificada%'
       AND store_name_detected NOT ILIKE '%pendente%'
       AND store_name_detected NOT ILIKE '%em fila%';
  END IF;
END $$;

COMMIT;
