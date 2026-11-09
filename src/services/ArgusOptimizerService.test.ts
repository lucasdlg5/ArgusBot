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
});
