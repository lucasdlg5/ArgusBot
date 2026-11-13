import { describe, it, expect } from 'vitest';
import { ArgusCatalogBiService } from './ArgusCatalogBiService';

describe('ArgusCatalogBiService — Catálogo de Produtos & B.I. por Mercado', () => {
  it('consolida produtos escaneados com data, local e marca além de métricas individuais de B.I. por mercado', async () => {
    const service = new ArgusCatalogBiService();
    const result = await service.getCatalogAndStoreBi(new Date('2026-11-13T12:00:00Z'));

    expect(result.scannedProducts.length).toBeGreaterThan(0);
    for (const item of result.scannedProducts.slice(0, 10)) {
      expect(item.observedAt).toBeTruthy();
      expect(item.storeName.length).toBeGreaterThan(0);
      expect(item.storeLocation.length).toBeGreaterThan(0);
      expect(item.brandName.length).toBeGreaterThan(0);
      expect(item.normalizedPackagePrice).toBeGreaterThanOrEqual(0);
    }

    expect(result.storesBi.length).toBeGreaterThan(0);
    const topStore = result.storesBi[0];
    expect(topStore.tradingName.length).toBeGreaterThan(0);
    expect(topStore.totalSpentAllTime).toBeGreaterThan(0);
    expect(topStore.dailySpendRateHistorical).toBeGreaterThan(0);
    expect(topStore.monthlySeries).toHaveLength(6);
    expect(topStore.weekdaySeries).toHaveLength(7);
    expect(topStore.mostConsumedProduct).not.toBeNull();
    expect(topStore.topProducts.length).toBeGreaterThan(0);
  });
});
