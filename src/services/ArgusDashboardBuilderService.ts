import fs from 'node:fs/promises';
import path from 'node:path';
import { queryArgus } from '../lib/db';
import { ArgusOptimizerService } from './ArgusOptimizerService';
import { ArgusRecipeService } from './ArgusRecipeService';
import { ArgusReconciliationService } from './ArgusReconciliationService';
import { ArgusStoreNormalizationService } from './ArgusStoreNormalizationService';
import { env } from '../config/env';
import { logger } from '../config/logger';

export class ArgusDashboardBuilderService {
  /**
   * Constrói o payload completo do Argus Vision BI a partir do schema `argus` no Supabase PostgreSQL.
   */
  async buildDashboardPayload(options?: { runFullReconciliation?: boolean }) {
    await new ArgusStoreNormalizationService().ensureInitialNeMigrationApplied();

    const optimizer = new ArgusOptimizerService();
    const recipeService = new ArgusRecipeService();
    const reconciler = new ArgusReconciliationService();

    const [
      currentPricesRaw,
      heatmapRaw,
      inflationRaw,
      spendingBreakdownRaw,
      priceEvolutionRaw,
      recipesEvaluations,
      logisticsVerdict,
      reconciliationResult,
      collectedPricesRaw,
      queueSummaryRaw
    ] = await Promise.all([
      queryArgus(
        `SELECT * FROM argus.v_current_product_prices ORDER BY product_name, estimated_package_price ASC`
      ),
      queryArgus(`SELECT * FROM argus.v_store_category_heatmap ORDER BY store_name, category`),
      queryArgus(
        `SELECT * FROM argus.v_personal_inflation_and_shrinkflation ORDER BY ref_month DESC, product_name ASC`
      ),
      queryArgus(
        `SELECT * FROM argus.v_true_spending_breakdown ORDER BY ref_month DESC, total_spent DESC`
      ),
      queryArgus(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', r.purchase_date), 'YYYY-MM') AS month_label,
           cp.name AS product_name,
           ROUND(AVG(ri.normalized_price_per_base_unit * cp.standard_package_size), 2) AS avg_package_price
         FROM argus.receipt_items ri
         JOIN argus.receipts r ON r.id = ri.receipt_id
         JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
         GROUP BY DATE_TRUNC('month', r.purchase_date), cp.name
         ORDER BY DATE_TRUNC('month', r.purchase_date) ASC`
      ),
      recipeService.evaluateRecipesWithRoutes(),
      optimizer.optimizeShoppingTrip(),
      options?.runFullReconciliation !== false
        ? reconciler.reconcileAndSyncSheets()
        : reconciler.reconcileAndSyncSheets(),
      queryArgus(
        `SELECT
           id,
           source_type AS source_kind,
           COALESCE(store_name_detected, 'MERCADO') AS store_name,
           store_location_detected AS store_neighborhood,
           raw_product_description,
           collected_price::float8 AS price,
           promo_club_price::float8 AS promo_or_club_price,
           unit_type,
           confidence_score_pct::float8 AS confidence_score,
           missing_info_flags,
           collected_at::text AS collected_at
         FROM argus.collected_prices
         ORDER BY collected_at DESC
         LIMIT 60`
      ).catch(() => []),
      queryArgus(
        `SELECT status, count(*)::int AS total
         FROM argus.media_processing_queue
         GROUP BY status`
      ).catch(() => [])
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

    const monthsMap = new Map<string, Record<string, string | number>>();
    for (const row of priceEvolutionRaw) {
      const m = String(row.month_label);
      if (!monthsMap.has(m)) {
        monthsMap.set(m, { month: m });
      }
      monthsMap.get(m)![String(row.product_name)] = Number(row.avg_package_price);
    }
    const priceEvolutionSeries = Array.from(monthsMap.values());

    const latestMonth = spendingBreakdown[0]?.ref_month;
    const latestMonthSpending = spendingBreakdown.filter((s) => s.ref_month === latestMonth);
    const totalMonthSpent = latestMonthSpending.reduce((acc, s) => acc + s.total_spent, 0);
    const vrVaMonthSpent = latestMonthSpending
      .filter((s) => s.wallet_source === 'VR_VA')
      .reduce((acc, s) => acc + s.total_spent, 0);
    const impulseMonthSpent = latestMonthSpending
      .filter((s) => s.spending_pillar === 'Besteiras/Impulso')
      .reduce((acc, s) => acc + s.total_spent, 0);

    return {
      status: 'ok',
      generatedAt: new Date().toISOString(),
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
        pluggyTransactionsCount: reconciliationResult.summary.pluggyTransactions,
        collectedPricesCount: collectedPricesRaw.length
      },
      currentPrices,
      heatmap,
      inflation,
      spendingBreakdown,
      priceEvolutionSeries,
      recipesEvaluations,
      logisticsVerdict,
      reconciliation: reconciliationResult.summary,
      openFinanceTransactions: reconciliationResult.openFinanceTransactions,
      collectedPrices: collectedPricesRaw,
      queueSummary: queueSummaryRaw
    };
  }

  /**
   * Salva o snapshot estático local (`public/data/dashboard-snapshot.json`) E publica
   * no Supabase Storage (`FotosArgus/public-bi/dashboard-live.json`) para que o GitHub Pages
   * consuma os dados atualizados em tempo real sem expor extratos bancários pessoais (PII/Pix)!
   */
  async publishDashboardSnapshot(): Promise<{
    localPath: string;
    supabasePublicUrl: string | null;
  }> {
    const payload = await this.buildDashboardPayload();

    // Sanitização OpSec/LGPD para Snapshot Público (GitHub Pages):
    // Remove descrições nominais de Pix/Extrato bancário pessoal (mantém apenas métricas agregadas e preços de mercado)
    const sanitizedPublicPayload = {
      ...payload,
      homeLocation: {
        lat: -23.305,
        lng: -45.965,
        address: 'Jacareí / São Paulo - SP (Coordenadas Protegidas OpSec)'
      },
      openFinanceTransactions: payload.openFinanceTransactions
        .filter((tx) => tx.reconciledReceiptId !== null)
        .map((tx) => ({
          ...tx,
          accountId: 'redacted',
          description: 'Transação Conciliada de Supermercado (Protegido OpSec)'
        }))
    };

    const jsonString = JSON.stringify(sanitizedPublicPayload, null, 2);

    const dataDir = path.join(process.cwd(), 'public', 'data');
    await fs.mkdir(dataDir, { recursive: true });
    const localPath = path.join(dataDir, 'dashboard-snapshot.json');
    await fs.writeFile(localPath, jsonString, 'utf8');

    let supabasePublicUrl: string | null = null;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const baseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
        const bucket = env.SUPABASE_STORAGE_BUCKET || 'FotosArgus';
        const objectPath = 'public-bi/dashboard-live.json';

        // Garante que o bucket aceite leitura pública do JSON de BI ou faz upload direto via REST
        const uploadUrl = `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`;
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            'Content-Type': 'application/json; charset=utf-8',
            'x-upsert': 'true',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          },
          body: jsonString
        });

        if (res.ok) {
          supabasePublicUrl = `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${objectPath}`;
          logger.info(
            { supabasePublicUrl },
            '[ArgusDashboardBuilder] Snapshot de BI atualizado no Supabase Storage para o GitHub Pages'
          );
        } else {
          const errTxt = await res.text().catch(() => '');
          logger.warn(
            { status: res.status, errTxt },
            '[ArgusDashboardBuilder] Aviso ao publicar dashboard-live.json no Supabase Storage'
          );
        }
      } catch (err) {
        logger.warn(
          { err },
          '[ArgusDashboardBuilder] Falha de rede ao publicar dashboard-live.json no Supabase Storage'
        );
      }
    }

    return { localPath, supabasePublicUrl };
  }
}
