import { NextResponse } from 'next/server';
import { queryArgus } from '@/lib/db';
import { ArgusOptimizerService } from '@/services/ArgusOptimizerService';
import { ArgusReconciliationService } from '@/services/ArgusReconciliationService';
import { env } from '@/config/env';

export async function GET() {
  try {
    const optimizer = new ArgusOptimizerService();
    const reconciler = new ArgusReconciliationService();

    const [
      currentPricesRaw,
      heatmapRaw,
      inflationRaw,
      spendingBreakdownRaw,
      priceEvolutionRaw,
      recipesEvaluations,
      logisticsVerdict,
      reconciliationResult
    ] = await Promise.all([
      queryArgus(`SELECT * FROM argus.v_current_product_prices ORDER BY product_name, estimated_package_price ASC`),
      queryArgus(`SELECT * FROM argus.v_store_category_heatmap ORDER BY store_name, category`),
      queryArgus(`SELECT * FROM argus.v_personal_inflation_and_shrinkflation ORDER BY ref_month DESC, product_name ASC`),
      queryArgus(`SELECT * FROM argus.v_true_spending_breakdown ORDER BY ref_month DESC, total_spent DESC`),
      queryArgus(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', r.purchase_date), 'YYYY-MM') AS month_label,
           cp.name AS product_name,
           ROUND(AVG(ri.normalized_price_per_base_unit * cp.standard_package_size), 2) AS avg_package_price
         FROM argus.receipt_items ri
         JOIN argus.receipts r ON r.id = ri.receipt_id
         JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
         WHERE cp.name IN (
           'Peito de Frango Sem Osso (1kg)',
           'Patinho Bovino Moído (1kg)',
           'Arroz Agulhinha Tipo 1 (5kg)',
           'Azeite de Oliva Extra Virgem (500ml)',
           'Café Torrado e Moído Tradicional (500g)',
           'Leite Integral UHT (1L)'
         )
         GROUP BY DATE_TRUNC('month', r.purchase_date), cp.name
         ORDER BY DATE_TRUNC('month', r.purchase_date) ASC`
      ),
      optimizer.evaluateRecipeCosts(),
      optimizer.optimizeShoppingTrip(),
      reconciler.reconcileAndSyncSheets()
    ]);

    const currentPrices = currentPricesRaw.map((r) => ({
      ...r,
      standard_package_size: Number(r.standard_package_size),
      estimated_base_price: Number(r.estimated_base_price),
      estimated_package_price: Number(r.estimated_package_price),
      min_historical_price: Number(r.min_historical_price),
      max_historical_price: Number(r.max_historical_price),
      days_since_last_seen: Number(r.days_since_last_seen),
      observations_count: Number(r.observations_count)
    }));

    const heatmap = heatmapRaw.map((r) => ({
      ...r,
      products_tracked: Number(r.products_tracked),
      competitiveness_index: Number(r.competitiveness_index),
      basket_category_cost: Number(r.basket_category_cost),
      min_days_since_seen: Number(r.min_days_since_seen),
      max_days_since_seen: Number(r.max_days_since_seen)
    }));

    const inflation = inflationRaw.map((r) => ({
      ...r,
      standard_package_size: Number(r.standard_package_size),
      latest_seen_package_size: Number(r.latest_seen_package_size),
      avg_std_package_price: Number(r.avg_std_package_price),
      mom_inflation_pct: Number(r.mom_inflation_pct),
      shrinkflation_detected: Boolean(r.shrinkflation_detected),
      package_reduction_pct: Number(r.package_reduction_pct)
    }));

    const spendingBreakdown = spendingBreakdownRaw.map((r) => ({
      ref_month: String(r.ref_month),
      wallet_source: r.wallet_source as 'BANK_ACCOUNT' | 'VR_VA',
      payment_method: String(r.payment_method),
      category: String(r.category),
      is_essential: Boolean(r.is_essential),
      spending_pillar: String(r.spending_pillar),
      receipts_count: Number(r.receipts_count),
      reconciled_receipts_count: Number(r.reconciled_receipts_count),
      total_spent: Number(r.total_spent)
    }));

    // Pivota série temporal para o Recharts LineChart
    const monthsMap = new Map<string, Record<string, string | number>>();
    for (const row of priceEvolutionRaw) {
      const m = String(row.month_label);
      if (!monthsMap.has(m)) {
        monthsMap.set(m, { month: m });
      }
      monthsMap.get(m)![String(row.product_name)] = Number(row.avg_package_price);
    }
    const priceEvolutionSeries = Array.from(monthsMap.values());

    // Calcula KPIs do Módulo 1 (Raio-X Open Finance)
    const latestMonth = spendingBreakdown[0]?.ref_month;
    const latestMonthSpending = spendingBreakdown.filter((s) => s.ref_month === latestMonth);
    const totalMonthSpent = latestMonthSpending.reduce((acc, s) => acc + s.total_spent, 0);
    const vrVaMonthSpent = latestMonthSpending
      .filter((s) => s.wallet_source === 'VR_VA')
      .reduce((acc, s) => acc + s.total_spent, 0);
    const impulseMonthSpent = latestMonthSpending
      .filter((s) => s.spending_pillar === 'Besteiras/Impulso')
      .reduce((acc, s) => acc + s.total_spent, 0);

    return NextResponse.json({
      status: 'ok',
      homeLocation: {
        lat: env.HOME_LAT,
        lng: env.HOME_LNG,
        address: env.HOME_ADDRESS
      },
      kpis: {
        totalMonthSpent: Number(totalMonthSpent.toFixed(2)),
        potentialMonthlySavings: Number(
          (logisticsVerdict.grossProductSavings + impulseMonthSpent * 0.5).toFixed(2)
        ),
        vrVaBurnAmount: Number(vrVaMonthSpent.toFixed(2)),
        vrVaMonthlyBudget: 850.0,
        vrVaBurnRatePct: Number(((vrVaMonthSpent / 850.0) * 100).toFixed(1)),
        reconciliationRatePct: reconciliationResult.summary.reconciliationRatePct,
        scannedReceiptsCount: reconciliationResult.summary.scannedReceipts,
        pluggyTransactionsCount: reconciliationResult.summary.pluggyTransactions
      },
      currentPrices,
      heatmap,
      inflation,
      spendingBreakdown,
      priceEvolutionSeries,
      recipesEvaluations,
      logisticsVerdict,
      reconciliation: reconciliationResult.summary,
      openFinanceTransactions: reconciliationResult.openFinanceTransactions
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
