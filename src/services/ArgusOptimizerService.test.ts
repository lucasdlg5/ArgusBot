import { describe, it, expect } from 'vitest';
import { ArgusOptimizerService } from './ArgusOptimizerService';

describe('ArgusOptimizerService — Motor de Receitas e Logística (Carro vs. Uber)', () => {
  const optimizer = new ArgusOptimizerService();

  it('deve aplicar corretamente a tarifa mínima por trecho do Uber e a fórmula paramétrica', () => {
    const shortTrip = optimizer.calculateUberLegFare(1.2, 4);
    expect(shortTrip).toBeGreaterThanOrEqual(8.9);

    const longerTrip = optimizer.calculateUberLegFare(12, 25);
    // 3.50 + 12*1.65 + 25*0.28 = 3.50 + 19.80 + 7.00 = 30.30
    expect(longerTrip).toBeCloseTo(30.3, 2);
  });

  it('deve avaliar o Duplo Custo de Receitas (Proporcional vs. Desembolso de Caixa)', async () => {
    const evaluations = await optimizer.evaluateRecipeCosts();
    expect(evaluations.length).toBeGreaterThanOrEqual(2);

    const strogonoff = evaluations.find((r) => r.recipeName.includes('Strogonoff'));
    expect(strogonoff).toBeDefined();
    expect(strogonoff!.proportionalCostPerPortion).toBeGreaterThan(0);
    expect(strogonoff!.cashOutlayTotalCost).toBeGreaterThan(strogonoff!.proportionalTotalCost);
  });

  it('deve simular rota OSRM Mercado Único vs. Compra Dividida respeitando MIN_SAVINGS_HURDLE = R$ 25,00', async () => {
    const verdict = await optimizer.optimizeShoppingTrip();
    expect(verdict.minSavingsHurdle).toBe(25);
    expect(verdict.singleStoreBest.totalDistanceKm).toBeGreaterThan(0);
    expect(verdict.splitStoreBest.routeLegs.length).toBe(3); // Casa -> M1 -> M2 -> Casa
    expect(verdict.argusVerdictText).toContain('VEREDITO ARGUS');
  });

  it('deve comparar historicamente o custo da mesma receita entre Mercado Souza e NE Supermercado', async () => {
    const evaluations = await optimizer.evaluateRecipeCosts();
    const strogonoff = evaluations.find((r) => r.recipeName.includes('Strogonoff'));
    expect(strogonoff).toBeDefined();

    const cmp = strogonoff!.historicalStoreComparison;
    expect(cmp).toBeDefined();
    expect(cmp!.mercadoSouza.storeName).toBe('Mercado Souza');
    expect(cmp!.neSupermercado.storeName).toBe('NE Supermercado');
    expect(cmp!.mercadoSouza.totalObservationsCount).toBeGreaterThan(0);
    expect(cmp!.neSupermercado.totalObservationsCount).toBeGreaterThan(0);
    expect(cmp!.items.length).toBe(strogonoff!.ingredientsBreakdown.length);
    expect(cmp!.timeline.length).toBe(6);

    for (let i = 1; i < cmp!.timeline.length; i++) {
      expect(cmp!.timeline[i].sortKey > cmp!.timeline[i - 1].sortKey).toBe(true);
    }
    for (const pt of cmp!.timeline) {
      expect(pt.mercadoSouzaCash).toBeGreaterThan(0);
      expect(pt.neSupermercadoCash).toBeGreaterThan(0);
      expect(pt.mercadoSouzaProportional).toBeGreaterThan(0);
      expect(pt.neSupermercadoProportional).toBeGreaterThan(0);
    }

    const expectedDelta = Math.abs(
      cmp!.mercadoSouza.weightedCashCost - cmp!.neSupermercado.weightedCashCost
    );
    expect(cmp!.savingsWeightedCash).toBeCloseTo(expectedDelta, 1);

    if (expectedDelta > 0.05) {
      const expectedWinner =
        cmp!.mercadoSouza.weightedCashCost < cmp!.neSupermercado.weightedCashCost
          ? 'MERCADO_SOUZA'
          : 'NE_SUPERMERCADO';
      expect(cmp!.winnerWeightedCash).toBe(expectedWinner);
    }
  });
});
