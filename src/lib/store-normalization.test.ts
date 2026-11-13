import { describe, it, expect } from 'vitest';
import {
  CANONICAL_STORE_NE,
  CANONICAL_STORE_SOUZA,
  classifyAndNormalizeStoreName,
  classifyStoreForCurrentSweep
} from './store-normalization';
import { ArgusStoreNormalizationService } from '../services/ArgusStoreNormalizationService';
import { ArgusReceiptProcessor } from '../services/ArgusReceiptProcessor';

describe('store-normalization — Consolidação NE Supermercado vs. Mercado Souza', () => {
  it('normaliza variantes de flyers e cupons do NE (NE, CLUBE NE, NOVA ÉPOCA SUPERMERCADOS) para NE SUPERMERCADO', () => {
    expect(classifyAndNormalizeStoreName('NE').canonicalName).toBe(CANONICAL_STORE_NE);
    expect(classifyAndNormalizeStoreName('N.E.').canonicalName).toBe(CANONICAL_STORE_NE);
    expect(classifyAndNormalizeStoreName('CLUBE NE').canonicalName).toBe(CANONICAL_STORE_NE);
    expect(classifyAndNormalizeStoreName('Clube NE').matchedRule).toBe('CLUBE_FIDELIDADE_NE');
    expect(classifyAndNormalizeStoreName('NOVA ÉPOCA SUPERMERCADOS').canonicalName).toBe(
      CANONICAL_STORE_NE
    );
    expect(classifyAndNormalizeStoreName('Supermercado Nova Epoca').matchedRule).toBe(
      'RAZAO_SOCIAL_NOVA_EPOCA'
    );

    expect(classifyAndNormalizeStoreName('MERCADO SOUZA').canonicalName).toBe(
      CANONICAL_STORE_SOUZA
    );
    expect(classifyAndNormalizeStoreName('Supermercado Souza').canonicalName).toBe(
      CANONICAL_STORE_SOUZA
    );

    // Outras redes futuras permanecem preservadas na ingestão normal
    expect(classifyAndNormalizeStoreName('Atacadão Cambuci').canonicalName).toBe(
      'Atacadão Cambuci'
    );
    // Na varredura da base atual, qualquer registro não-Souza vira NE SUPERMERCADO
    expect(classifyStoreForCurrentSweep('Qualquer Outro Nome Flyer').canonicalName).toBe(
      CANONICAL_STORE_NE
    );
  });

  it('gera o mesmo CNPJ sintético determinístico para variantes de NE em ArgusReceiptProcessor', () => {
    const proc = new ArgusReceiptProcessor();
    const r1 = proc.finalizeReceiptIdentifiers({
      storeCnpj: '',
      storeRawName: 'CLUBE NE',
      storeTradingName: 'CLUBE NE',
      storeAddress: 'Jacareí',
      purchaseDate: new Date().toISOString(),
      totalAmount: 50,
      discountAmount: 0,
      paymentMethod: 'PIX',
      accessKey: '',
      items: [
        {
          rawDescription: 'ARROZ 5KG',
          quantity: 1,
          unitType: 'UN',
          unitPrice: 25,
          totalPrice: 25
        }
      ],
      extractionMethod: 'GEMINI_VISION_2_5_FLASH'
    });
    const r2 = proc.finalizeReceiptIdentifiers({
      storeCnpj: '',
      storeRawName: 'NOVA ÉPOCA SUPERMERCADOS',
      storeTradingName: 'NOVA ÉPOCA SUPERMERCADOS',
      storeAddress: 'Jacareí',
      purchaseDate: new Date().toISOString(),
      totalAmount: 50,
      discountAmount: 0,
      paymentMethod: 'PIX',
      accessKey: '',
      items: [
        {
          rawDescription: 'FEIJAO 1KG',
          quantity: 1,
          unitType: 'UN',
          unitPrice: 8,
          totalPrice: 8
        }
      ],
      extractionMethod: 'GEMINI_VISION_2_5_FLASH'
    });

    expect(r1.storeTradingName).toBe(CANONICAL_STORE_NE);
    expect(r2.storeTradingName).toBe(CANONICAL_STORE_NE);
    expect(r1.storeCnpj).toBe(r2.storeCnpj);
  });

  it('consolida snapshot de 4 variantes para apenas 2 mercados (NE SUPERMERCADO e MERCADO SOUZA) recalculando heatmap', () => {
    const svc = new ArgusStoreNormalizationService();
    const mockSnap = {
      currentPrices: [
        {
          canonical_product_id: 'p1',
          product_name: 'ACEM FRIBOI KG',
          category: 'Carnes',
          base_unit: 'g',
          standard_package_size: 1000,
          store_id: 'id-ne',
          store_name: 'NE',
          estimated_base_price: 0.03999,
          estimated_package_price: 39.99,
          min_historical_price: 39.99,
          max_historical_price: 39.99,
          days_since_last_seen: 0,
          last_seen_at: '2026-11-12T05:26:00.000Z',
          observations_count: 1
        },
        {
          canonical_product_id: 'p1',
          product_name: 'ACEM FRIBOI KG',
          category: 'Carnes',
          base_unit: 'g',
          standard_package_size: 1000,
          store_id: 'id-clube',
          store_name: 'CLUBE NE',
          estimated_base_price: 0.03799,
          estimated_package_price: 37.99,
          min_historical_price: 37.99,
          max_historical_price: 37.99,
          days_since_last_seen: 0,
          last_seen_at: '2026-11-12T06:00:00.000Z',
          observations_count: 1
        },
        {
          canonical_product_id: 'p2',
          product_name: 'ARROZ 5KG',
          category: 'Mercearia',
          base_unit: 'g',
          standard_package_size: 5000,
          store_id: 'id-nova-epoca',
          store_name: 'NOVA ÉPOCA SUPERMERCADOS',
          estimated_base_price: 0.005,
          estimated_package_price: 25,
          min_historical_price: 25,
          max_historical_price: 25,
          days_since_last_seen: 0,
          last_seen_at: '2026-11-12T06:02:00.000Z',
          observations_count: 2
        },
        {
          canonical_product_id: 'p2',
          product_name: 'ARROZ 5KG',
          category: 'Mercearia',
          base_unit: 'g',
          standard_package_size: 5000,
          store_id: 'id-souza',
          store_name: 'MERCADO SOUZA',
          estimated_base_price: 0.0054,
          estimated_package_price: 27,
          min_historical_price: 27,
          max_historical_price: 27,
          days_since_last_seen: 1,
          last_seen_at: '2026-11-11T10:00:00.000Z',
          observations_count: 1
        }
      ],
      heatmap: [],
      logisticsVerdict: {
        singleStoreBest: {
          mode: 'SINGLE_STORE',
          title: 'Mercado Único: CLUBE NE',
          storesVisited: [{ storeId: 'id-clube', storeName: 'CLUBE NE', itemsCount: 1, subtotalProducts: 37.99, items: [] }]
        },
        splitStoreBest: {
          mode: 'SPLIT_STORES',
          title: 'Compra Dividida (NOVA ÉPOCA SUPERMERCADOS + CLUBE NE)',
          storesVisited: [
            { storeId: 'id-nova-epoca', storeName: 'NOVA ÉPOCA SUPERMERCADOS', itemsCount: 1, subtotalProducts: 25, items: [] },
            { storeId: 'id-clube', storeName: 'CLUBE NE', itemsCount: 1, subtotalProducts: 37.99, items: [] }
          ]
        },
        argusVerdictText: 'Concentre 100% no CLUBE NE.'
      }
    };

    const { normalized, report } = svc.normalizeDashboardSnapshotPayload(mockSnap);
    expect(report.storesBefore).toEqual([
      'CLUBE NE',
      'MERCADO SOUZA',
      'NE',
      'NOVA ÉPOCA SUPERMERCADOS'
    ]);
    expect(report.storesAfter).toEqual(['MERCADO SOUZA', 'NE SUPERMERCADO']);
    expect(report.currentPricesAfter).toBe(3); // p1 mesclado em NE SUPERMERCADO + p2 em NE e Souza
    expect(new Set(normalized.heatmap.map((h: any) => h.store_name))).toEqual(
      new Set(['MERCADO SOUZA', 'NE SUPERMERCADO'])
    );
    expect(normalized.logisticsVerdict.splitStoreBest.storesVisited).toHaveLength(1);
    expect(normalized.logisticsVerdict.splitStoreBest.storesVisited[0].storeName).toBe(
      'NE SUPERMERCADO'
    );
  });
});
