import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus } from '../lib/db';
import { classifyIngredientPerishability } from '../lib/perishability';
import { deriveRecipeMetadata } from '../lib/recipe-intelligence';
import { classifyStoreForCurrentSweep, CANONICAL_STORE_NE, CANONICAL_STORE_SOUZA } from '../lib/store-normalization';
import type {
  BaseUnit,
  LogisticsScenario,
  OptimizationVerdict,
  ProductCategory,
  RecipeCostEvaluation,
  RecipeStoreHistoryTotals,
  RecipeStorePairComparisonItem,
  RecipeStoreQuote,
  RecipeTimelineComparisonPoint,
  RecipeTwoStoreComparison,
  RouteLegGeometry,
  StoreIngredientHistorySummary,
  StoreIngredientPricePoint
} from '../types/argus';

export interface ShoppingListItemInput {
  canonicalProductId: string;
  requiredBaseQty: number;
}

export class ArgusOptimizerService {
  /**
   * 1. Geocodificação 100% gratuita via Nominatim (OpenStreetMap)
   */
  async geocodeAddressNominatim(
    address: string
  ): Promise<{ lat: number; lng: number; displayName: string } | null> {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
        address
      )}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'MonetaArgusBot/1.0 (Argus Vision BI Zero-Cost Stack)'
        }
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Array<{
        lat: string;
        lon: string;
        display_name: string;
      }>;
      if (!data.length) return null;
      return {
        lat: Number(data[0].lat),
        lng: Number(data[0].lon),
        displayName: data[0].display_name
      };
    } catch (err) {
      logger.warn({ err }, '[ArgusOptimizerService] Falha no Nominatim; mantendo coordenadas cadastradas');
      return null;
    }
  }

  /**
   * 2. Cálculo de rota de condução real via OSRM (`router.project-osrm.org`)
   * com fallback Haversine * fator viário (1.32x) caso o servidor público OSRM oscile.
   */
  async calculateOsrmLeg(
    from: { name: string; lat: number; lng: number },
    to: { name: string; lat: number; lng: number }
  ): Promise<RouteLegGeometry> {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(4500)
      });
      if (res.ok) {
        const json = (await res.json()) as {
          code?: string;
          routes?: Array<{
            distance: number;
            duration: number;
            geometry?: { coordinates: Array<[number, number]> };
          }>;
        };
        const route = json.routes?.[0];
        if (route) {
          const distanceKm = Number((route.distance / 1000).toFixed(2));
          const durationMin = Math.max(3, Math.round(route.duration / 60));
          const coordinates: Array<[number, number]> =
            route.geometry?.coordinates.map(([lon, lat]) => [lat, lon]) ?? [
              [from.lat, from.lng],
              [to.lat, to.lng]
            ];
          return {
            fromName: from.name,
            toName: to.name,
            distanceKm,
            durationMin,
            coordinates
          };
        }
      }
    } catch {
      // Fallback determinístico caso offline
    }

    // Cálculo Haversine com fator viário urbano de 1.32x
    const R = 6371;
    const dLat = ((to.lat - from.lat) * Math.PI) / 180;
    const dLng = ((to.lng - from.lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((from.lat * Math.PI) / 180) *
        Math.cos((to.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = Number(Math.max(0.8, R * c * 1.32).toFixed(2));
    const durationMin = Math.max(4, Math.round((distanceKm / 26) * 60));

    return {
      fromName: from.name,
      toName: to.name,
      distanceKm,
      durationMin,
      coordinates: [
        [from.lat, from.lng],
        [(from.lat + to.lat) / 2 + 0.002, (from.lng + to.lng) / 2 - 0.0015],
        [to.lat, to.lng]
      ]
    };
  }

  /**
   * Obtém o preço atual do litro de gasolina a partir de cupons da categoria 'Combustível' ou `.env`
   */
  async getLatestGasPricePerLiter(): Promise<number> {
    try {
      const rows = await queryArgus<{ estimated_package_price: string }>(
        `SELECT estimated_package_price
         FROM argus.v_current_product_prices
         WHERE category = 'Combustível'
         ORDER BY last_seen_at DESC
         LIMIT 1`
      );
      if (rows.length > 0 && Number(rows[0].estimated_package_price) > 0) {
        return Number(rows[0].estimated_package_price);
      }
    } catch {
      // fallback .env
    }
    return env.GAS_PRICE_PER_LITER;
  }

  /**
   * Calcula custo de um trecho de Uber aplicando a fórmula paramétrica com tarifa mínima por trecho
   */
  calculateUberLegFare(distanceKm: number, durationMin: number): number {
    const raw =
      env.UBER_BASE_FARE +
      distanceKm * env.UBER_RATE_PER_KM +
      durationMin * env.UBER_RATE_PER_MIN;
    return Number(Math.max(env.UBER_MIN_TRIP_FARE, raw).toFixed(2));
  }

  /**
   * 3. Avalia o Duplo Custo de Receitas (Proporcional por Porção vs. Desembolso de Caixa em Embalagens Fechadas),
   * compara o Menor Preço Possível (dividido entre mercados) vs. Melhor Mercado Único (com cobertura real),
   * e classifica todos os ingredientes na cadeia fria (não perecíveis 1º -> perecíveis/congelados por último).
   */
  async evaluateRecipeCosts(
    recipeId?: string,
    requestedPortionsOverride?: number
  ): Promise<RecipeCostEvaluation[]> {
    const [recipes, priceRows, stores, receiptHistoryRows, collectedHistoryRows] = await Promise.all([
      queryArgus<{
        id: string;
        name: string;
        servings: number;
        instructions: string;
      }>(
        recipeId
          ? `SELECT id, name, servings, instructions FROM argus.recipes WHERE id = $1`
          : `SELECT id, name, servings, instructions FROM argus.recipes ORDER BY name ASC`,
        recipeId ? [recipeId] : []
      ),
      queryArgus<{
        canonical_product_id: string;
        product_name: string;
        category: ProductCategory;
        base_unit: BaseUnit;
        standard_package_size: string;
        store_id: string;
        store_name: string;
        estimated_base_price: string;
        estimated_package_price: string;
      }>(`SELECT * FROM argus.v_current_product_prices`),
      queryArgus<{
        id: string;
        trading_name: string;
        address?: string;
        latitude: string;
        longitude: string;
      }>(
        `SELECT id, trading_name, address, latitude, longitude FROM argus.stores ORDER BY trading_name ASC`
      ),
      queryArgus<{
        canonical_product_id: string;
        store_name: string;
        observed_at: string;
        base_price: number;
        package_price: number;
        source_type: string;
      }>(
        `SELECT
           ri.canonical_product_id,
           s.trading_name AS store_name,
           r.purchase_date::text AS observed_at,
           ri.normalized_price_per_base_unit::float8 AS base_price,
           (ri.normalized_price_per_base_unit * cp.standard_package_size)::float8 AS package_price,
           'CUPOM_FISCAL'::text AS source_type
         FROM argus.receipt_items ri
         JOIN argus.receipts r ON r.id = ri.receipt_id
         JOIN argus.stores s ON s.id = r.store_id
         JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
         WHERE ri.normalized_price_per_base_unit > 0
         ORDER BY r.purchase_date ASC`
      ).catch(() => []),
      queryArgus<{
        canonical_product_id: string;
        store_name: string;
        observed_at: string;
        base_price: number;
        package_price: number;
        source_type: string;
      }>(
        `SELECT
           cp_obs.canonical_product_id,
           COALESCE(s.trading_name, cp_obs.store_name_detected) AS store_name,
           cp_obs.collected_at::text AS observed_at,
           cp_obs.normalized_price_per_base_unit::float8 AS base_price,
           (cp_obs.normalized_price_per_base_unit * cp.standard_package_size)::float8 AS package_price,
           cp_obs.source_type::text AS source_type
         FROM argus.collected_prices cp_obs
         LEFT JOIN argus.stores s ON s.id = cp_obs.store_id
         JOIN argus.canonical_products cp ON cp.id = cp_obs.canonical_product_id
         WHERE cp_obs.canonical_product_id IS NOT NULL
           AND cp_obs.normalized_price_per_base_unit > 0
         ORDER BY cp_obs.collected_at ASC`
      ).catch(() => [])
    ]);

    // Agrupa observações históricas por (canonical_product_id :: CANONICAL_STORE)
    const historyByProductAndStore = new Map<string, StoreIngredientPricePoint[]>();
    const allObservations = [...receiptHistoryRows, ...collectedHistoryRows];
    for (const obs of allObservations) {
      const normalizedStore = classifyStoreForCurrentSweep(obs.store_name).canonicalName;
      if (normalizedStore !== CANONICAL_STORE_SOUZA && normalizedStore !== CANONICAL_STORE_NE) {
        continue;
      }
      const key = `${obs.canonical_product_id}::${normalizedStore}`;
      const list = historyByProductAndStore.get(key) ?? [];
      list.push({
        observedAt: new Date(obs.observed_at).toISOString(),
        packagePrice: Number(Number(obs.package_price).toFixed(2)),
        basePrice: Number(Number(obs.base_price).toFixed(6)),
        sourceType: String(obs.source_type || 'CUPOM_FISCAL')
      });
      historyByProductAndStore.set(key, list);
    }
    for (const list of historyByProductAndStore.values()) {
      list.sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
    }

    const evaluations: RecipeCostEvaluation[] = [];

    for (const recipe of recipes) {
      const ingredients = await queryArgus<{
        canonical_product_id: string;
        quantity_in_base_unit: string;
        product_name: string;
        category: ProductCategory;
        base_unit: BaseUnit;
        standard_package_size: string;
      }>(
        `SELECT
           ri.canonical_product_id,
           ri.quantity_in_base_unit,
           cp.name AS product_name,
           cp.category,
           cp.base_unit,
           cp.standard_package_size
         FROM argus.recipe_ingredients ri
         JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
         WHERE ri.recipe_id = $1`,
        [recipe.id]
      );

      const requestedPortions = requestedPortionsOverride ?? recipe.servings;
      const scaleFactor = requestedPortions / Math.max(1, recipe.servings);

      let proportionalTotalCost = 0;
      let cashOutlayTotalCost = 0;
      let priceCoverageCount = 0;
      const breakdown: RecipeCostEvaluation['ingredientsBreakdown'] = [];
      const splitStoresUsed = new Set<string>();

      const storeBuckets = new Map<
        string,
        {
          storeId: string;
          storeName: string;
          address: string;
          lat: number;
          lng: number;
          totalCashCost: number;
          totalProportionalCost: number;
          matchedIngredientsCount: number;
          missingIngredients: string[];
          estimatedMissingCost: number;
          items: RecipeStoreQuote['items'];
        }
      >();

      for (const st of stores) {
        storeBuckets.set(st.id, {
          storeId: st.id,
          storeName: st.trading_name,
          address: st.address || st.trading_name,
          lat: Number(st.latitude),
          lng: Number(st.longitude),
          totalCashCost: 0,
          totalProportionalCost: 0,
          matchedIngredientsCount: 0,
          missingIngredients: [],
          estimatedMissingCost: 0,
          items: []
        });
      }

      for (const ing of ingredients) {
        const requiredBaseQty = Number(ing.quantity_in_base_unit) * scaleFactor;
        const stdPkgSize = Math.max(1, Number(ing.standard_package_size));
        const packagesNeeded = Math.max(1, Math.ceil(requiredBaseQty / stdPkgSize));
        const perish = classifyIngredientPerishability(ing.product_name, ing.category);

        const productStorePrices = priceRows
          .filter((p) => p.canonical_product_id === ing.canonical_product_id)
          .sort((a, b) => Number(a.estimated_base_price) - Number(b.estimated_base_price));

        const hasAnyRealPrice = productStorePrices.length > 0;
        if (hasAnyRealPrice) {
          priceCoverageCount += 1;
        }

        const fallbackBasePrice =
          ing.base_unit === 'un' ? 0.85 : ing.category === 'Carnes' ? 0.032 : 0.015;
        const bestPriceRow = productStorePrices[0];
        const bestBasePrice = bestPriceRow
          ? Number(bestPriceRow.estimated_base_price)
          : fallbackBasePrice;
        const bestPkgPrice = bestPriceRow
          ? Number(bestPriceRow.estimated_package_price)
          : Number((fallbackBasePrice * stdPkgSize).toFixed(2));
        const bestStoreId = bestPriceRow?.store_id;
        const bestStoreName = bestPriceRow?.store_name ?? 'Sem leitura no banco (Estimado)';

        if (bestStoreId) {
          splitStoresUsed.add(bestStoreId);
        }

        const avgBasePrice = hasAnyRealPrice
          ? productStorePrices.reduce((s, r) => s + Number(r.estimated_base_price), 0) /
            productStorePrices.length
          : fallbackBasePrice;
        const avgPkgPrice = hasAnyRealPrice
          ? productStorePrices.reduce((s, r) => s + Number(r.estimated_package_price), 0) /
            productStorePrices.length
          : bestPkgPrice;

        // Atualiza cotação de cada loja individualmente
        for (const st of stores) {
          const bucket = storeBuckets.get(st.id)!;
          const storeRow = productStorePrices.find((p) => p.store_id === st.id);

          const stBasePrice = storeRow ? Number(storeRow.estimated_base_price) : avgBasePrice;
          const stPkgPrice = storeRow ? Number(storeRow.estimated_package_price) : avgPkgPrice;
          const stProp = Number((requiredBaseQty * stBasePrice).toFixed(2));
          const stCash = Number((packagesNeeded * stPkgPrice).toFixed(2));

          if (storeRow) {
            bucket.matchedIngredientsCount += 1;
          } else {
            bucket.missingIngredients.push(ing.product_name);
            bucket.estimatedMissingCost = Number((bucket.estimatedMissingCost + stCash).toFixed(2));
          }

          bucket.totalProportionalCost = Number((bucket.totalProportionalCost + stProp).toFixed(2));
          bucket.totalCashCost = Number((bucket.totalCashCost + stCash).toFixed(2));
          bucket.items.push({
            productId: ing.canonical_product_id,
            productName: ing.product_name,
            category: ing.category || 'Mercearia',
            packagesNeeded,
            packagePrice: Number(stPkgPrice.toFixed(2)),
            proportionalCost: stProp,
            cashOutlayCost: stCash,
            hasRealPrice: Boolean(storeRow),
            perishabilityTier: perish.tier,
            perishabilityRank: perish.rank
          });
        }

        const propCost = Number((requiredBaseQty * bestBasePrice).toFixed(2));
        const cashCost = Number((packagesNeeded * bestPkgPrice).toFixed(2));
        const totalBoughtQty = packagesNeeded * stdPkgSize;
        const surplusBaseQty = Math.max(0, Number((totalBoughtQty - requiredBaseQty).toFixed(1)));
        const surplusPct =
          totalBoughtQty > 0 ? Math.min(99, Math.round((surplusBaseQty / totalBoughtQty) * 100)) : 0;
        const leftoverValue = Math.max(0, Number((cashCost - propCost).toFixed(2)));

        proportionalTotalCost += propCost;
        cashOutlayTotalCost += cashCost;

        breakdown.push({
          productId: ing.canonical_product_id,
          productName: ing.product_name,
          category: ing.category || 'Mercearia',
          baseUnit: ing.base_unit,
          requiredBaseQty: Number(requiredBaseQty.toFixed(1)),
          standardPackageSize: stdPkgSize,
          packagesNeeded,
          surplusBaseQty,
          surplusPct,
          leftoverValue,
          bestStoreId,
          bestStoreName,
          bestUnitPrice: Number(bestBasePrice.toFixed(4)),
          bestPackagePrice: Number(bestPkgPrice.toFixed(2)),
          proportionalCost: propCost,
          cashOutlayCost: cashCost,
          hasRealPrice: hasAnyRealPrice,
          perishabilityTier: perish.tier,
          perishabilityRank: perish.rank,
          perishabilityLabel: perish.label,
          perishabilityReason: perish.reason
        });
      }

      // Ordena ingredientes na ordem ideal de compra: 1 (Não Perecível) -> 4 (Carnes/Congelados/Delicados)
      breakdown.sort((a, b) => a.perishabilityRank - b.perishabilityRank);

      const totalIngredientsCount = breakdown.length;
      const storeQuotes: RecipeStoreQuote[] = Array.from(storeBuckets.values())
        .map((b) => ({
          storeId: b.storeId,
          storeName: b.storeName,
          address: b.address,
          lat: b.lat,
          lng: b.lng,
          totalCashCost: Number(b.totalCashCost.toFixed(2)),
          totalProportionalCost: Number(b.totalProportionalCost.toFixed(2)),
          matchedIngredientsCount: b.matchedIngredientsCount,
          totalIngredientsCount,
          coveragePct:
            totalIngredientsCount > 0
              ? Number(((b.matchedIngredientsCount / totalIngredientsCount) * 100).toFixed(1))
              : 0,
          missingIngredients: b.missingIngredients,
          estimatedMissingCost: b.estimatedMissingCost,
          items: b.items.sort((a, b) => a.perishabilityRank - b.perishabilityRank)
        }))
        .sort((a, b) => {
          if (b.matchedIngredientsCount !== a.matchedIngredientsCount) {
            return b.matchedIngredientsCount - a.matchedIngredientsCount;
          }
          return a.totalCashCost - b.totalCashCost;
        });

      const bestSingle = storeQuotes[0] ?? null;
      const bestSingleStoreName = bestSingle?.storeName ?? CANONICAL_STORE_NE;
      const firstDry = breakdown.filter((i) => i.perishabilityRank === 1).map((i) => i.productName.split('(')[0].trim());
      const lastCold = breakdown.filter((i) => i.perishabilityRank >= 3).map((i) => i.productName.split('(')[0].trim());
      const coldChainSummary =
        firstDry.length > 0 && lastCold.length > 0
          ? `Pegue primeiro os não perecíveis (${firstDry.slice(0, 3).join(', ')}) e deixe refrigerados/carnes/congelados por último (${lastCold.slice(0, 3).join(', ')}) para manter o frescor.`
          : 'Ordene o trajeto priorizando itens de despensa antes de refrigerados, carnes e congelados.';

      const meta = deriveRecipeMetadata({
        name: recipe.name,
        servings: requestedPortions,
        instructions: recipe.instructions,
        ingredients: breakdown.map((b) => ({
          name: b.productName,
          category: b.category || 'Mercearia',
          baseUnit: b.baseUnit,
          requiredBaseQty: b.requiredBaseQty
        }))
      });
      const roundedCash = Number(cashOutlayTotalCost.toFixed(2));
      const roundedProp = Number(proportionalTotalCost.toFixed(2));
      const totalLeftoverPantryValue = Math.max(0, Number((roundedCash - roundedProp).toFixed(2)));
      const pantryUtilizationPct =
        roundedCash > 0 ? Math.min(100, Math.round((roundedProp / roundedCash) * 100)) : 100;

      const historicalStoreComparison = this.buildTwoStoreHistoricalComparison({
        breakdown,
        priceRows,
        historyByProductAndStore
      });

      evaluations.push({
        recipeId: recipe.id,
        recipeName: recipe.name,
        servings: recipe.servings,
        requestedPortions,
        instructions: recipe.instructions,
        instructionSteps: meta.instructionSteps,
        prepTimeMinutes: meta.prepTimeMinutes,
        difficulty: meta.difficulty,
        cuisineTags: meta.cuisineTags,
        estimatedCaloriesPerPortion: meta.estimatedCaloriesPerPortion,
        proportionalTotalCost: roundedProp,
        proportionalCostPerPortion: Number(
          (proportionalTotalCost / Math.max(1, requestedPortions)).toFixed(2)
        ),
        cashOutlayTotalCost: roundedCash,
        totalLeftoverPantryValue,
        pantryUtilizationPct,
        bestSingleStoreId: bestSingle?.storeId ?? null,
        bestSingleStoreName,
        bestSingleStoreAddress: bestSingle?.address ?? '',
        bestSingleStoreCashCost: bestSingle?.totalCashCost ?? roundedCash,
        bestSingleStoreProportionalCost: bestSingle?.totalProportionalCost ?? roundedProp,
        bestSingleStoreCoveragePct: bestSingle?.coveragePct ?? 0,
        lowestPossibleProportionalCost: roundedProp,
        lowestPossibleCashCost: roundedCash,
        lowestPossibleStoresCount: Math.max(1, splitStoresUsed.size),
        priceCoverageCount,
        totalIngredientsCount,
        coldChainSummary,
        storeQuotes,
        ingredientsBreakdown: breakdown,
        historicalStoreComparison
      });
    }

    return evaluations;
  }

  private buildTwoStoreHistoricalComparison(params: {
    breakdown: RecipeCostEvaluation['ingredientsBreakdown'];
    priceRows: Array<{
      canonical_product_id: string;
      store_name: string;
      estimated_base_price: string;
      estimated_package_price: string;
      last_seen_at?: string;
      observations_count?: string;
    }>;
    historyByProductAndStore: Map<string, StoreIngredientPricePoint[]>;
  }): RecipeTwoStoreComparison {
    const { breakdown, priceRows, historyByProductAndStore } = params;

    const buildStoreSummary = (
      storeLabel: string,
      canonicalKey: string,
      ing: RecipeCostEvaluation['ingredientsBreakdown'][number],
      fallbackBasePrice: number,
      fallbackPkgPrice: number
    ): StoreIngredientHistorySummary => {
      const points = historyByProductAndStore.get(`${ing.productId}::${canonicalKey}`) ?? [];
      const currentRow = priceRows.find(
        (r) =>
          r.canonical_product_id === ing.productId &&
          classifyStoreForCurrentSweep(r.store_name).canonicalName === canonicalKey
      );

      // Se existir linha em v_current_product_prices mas nenhuma observação direta, cria ponto sintético da leitura atual
      const effectivePoints: StoreIngredientPricePoint[] =
        points.length > 0
          ? points
          : currentRow
            ? [
                {
                  observedAt: currentRow.last_seen_at || new Date().toISOString(),
                  packagePrice: Number(Number(currentRow.estimated_package_price).toFixed(2)),
                  basePrice: Number(Number(currentRow.estimated_base_price).toFixed(6)),
                  sourceType: 'HISTORICO'
                }
              ]
            : [];

      const hasRealHistory = effectivePoints.length > 0;
      if (!hasRealHistory) {
        const estProp = Number((ing.requiredBaseQty * fallbackBasePrice).toFixed(2));
        const estCash = Number((ing.packagesNeeded * fallbackPkgPrice).toFixed(2));
        return {
          storeName: storeLabel,
          hasRealHistory: false,
          observationsCount: 0,
          latestPackagePrice: Number(fallbackPkgPrice.toFixed(2)),
          weightedPackagePrice: Number(fallbackPkgPrice.toFixed(2)),
          avgHistoricalPackagePrice: Number(fallbackPkgPrice.toFixed(2)),
          minHistoricalPackagePrice: Number(fallbackPkgPrice.toFixed(2)),
          maxHistoricalPackagePrice: Number(fallbackPkgPrice.toFixed(2)),
          latestProportionalCost: estProp,
          weightedProportionalCost: estProp,
          avgProportionalCost: estProp,
          minProportionalCost: estProp,
          maxProportionalCost: estProp,
          latestCashCost: estCash,
          weightedCashCost: estCash,
          avgCashCost: estCash,
          minCashCost: estCash,
          maxCashCost: estCash,
          lastSeenAt: null,
          pricePoints: []
        };
      }

      const latestPt = effectivePoints[effectivePoints.length - 1];
      const prevThree = effectivePoints.slice(Math.max(0, effectivePoints.length - 4), effectivePoints.length - 1);
      const prevAvgBase =
        prevThree.length > 0
          ? prevThree.reduce((sum, pt) => sum + pt.basePrice, 0) / prevThree.length
          : latestPt.basePrice;

      const weightedBase = currentRow
        ? Number(currentRow.estimated_base_price)
        : 0.7 * latestPt.basePrice + 0.3 * prevAvgBase;
      const weightedPkg = currentRow
        ? Number(currentRow.estimated_package_price)
        : weightedBase * ing.standardPackageSize;

      const avgBase = effectivePoints.reduce((s, p) => s + p.basePrice, 0) / effectivePoints.length;
      const avgPkg = effectivePoints.reduce((s, p) => s + p.packagePrice, 0) / effectivePoints.length;

      let minPt = effectivePoints[0];
      let maxPt = effectivePoints[0];
      for (const pt of effectivePoints) {
        if (pt.basePrice < minPt.basePrice) minPt = pt;
        if (pt.basePrice > maxPt.basePrice) maxPt = pt;
      }

      const calcProp = (base: number) => Number((ing.requiredBaseQty * base).toFixed(2));
      const calcCash = (pkg: number) => Number((ing.packagesNeeded * pkg).toFixed(2));

      return {
        storeName: storeLabel,
        hasRealHistory: true,
        observationsCount: effectivePoints.length,
        latestPackagePrice: Number(latestPt.packagePrice.toFixed(2)),
        weightedPackagePrice: Number(weightedPkg.toFixed(2)),
        avgHistoricalPackagePrice: Number(avgPkg.toFixed(2)),
        minHistoricalPackagePrice: Number(minPt.packagePrice.toFixed(2)),
        maxHistoricalPackagePrice: Number(maxPt.packagePrice.toFixed(2)),
        latestProportionalCost: calcProp(latestPt.basePrice),
        weightedProportionalCost: calcProp(weightedBase),
        avgProportionalCost: calcProp(avgBase),
        minProportionalCost: calcProp(minPt.basePrice),
        maxProportionalCost: calcProp(maxPt.basePrice),
        latestCashCost: calcCash(latestPt.packagePrice),
        weightedCashCost: calcCash(weightedPkg),
        avgCashCost: calcCash(avgPkg),
        minCashCost: calcCash(minPt.packagePrice),
        maxCashCost: calcCash(maxPt.packagePrice),
        lastSeenAt: latestPt.observedAt,
        pricePoints: effectivePoints
      };
    };

    const items: RecipeStorePairComparisonItem[] = breakdown.map((ing) => {
      const fallbackBase =
        ing.bestUnitPrice ??
        (ing.baseUnit === 'un' ? 0.85 : ing.category === 'Carnes' ? 0.032 : 0.015);
      const fallbackPkg = ing.bestPackagePrice ?? Number((fallbackBase * ing.standardPackageSize).toFixed(2));

      const souza = buildStoreSummary(
        'Mercado Souza',
        CANONICAL_STORE_SOUZA,
        ing,
        fallbackBase,
        fallbackPkg
      );
      const ne = buildStoreSummary(
        'NE Supermercado',
        CANONICAL_STORE_NE,
        ing,
        fallbackBase,
        fallbackPkg
      );

      let cheaperStoreWeighted: RecipeStorePairComparisonItem['cheaperStoreWeighted'] =
        'INSUFFICIENT_DATA';
      if (souza.hasRealHistory && ne.hasRealHistory) {
        if (Math.abs(souza.weightedCashCost - ne.weightedCashCost) <= 0.05) {
          cheaperStoreWeighted = 'TIE';
        } else if (souza.weightedCashCost < ne.weightedCashCost) {
          cheaperStoreWeighted = 'MERCADO_SOUZA';
        } else {
          cheaperStoreWeighted = 'NE_SUPERMERCADO';
        }
      }

      return {
        productId: ing.productId,
        productName: ing.productName,
        category: ing.category || 'Mercearia',
        baseUnit: ing.baseUnit,
        requiredBaseQty: ing.requiredBaseQty,
        standardPackageSize: ing.standardPackageSize,
        packagesNeeded: ing.packagesNeeded,
        mercadoSouza: souza,
        neSupermercado: ne,
        cheaperStoreWeighted,
        weightedCashDiff: Number((souza.weightedCashCost - ne.weightedCashCost).toFixed(2)),
        weightedProportionalDiff: Number(
          (souza.weightedProportionalCost - ne.weightedProportionalCost).toFixed(2)
        )
      };
    });

    const accumulateStore = (
      storeName: string,
      pick: (it: RecipeStorePairComparisonItem) => StoreIngredientHistorySummary
    ): RecipeStoreHistoryTotals => {
      let matched = 0;
      let totalObs = 0;
      let lastObservedAt: string | null = null;
      let weightedCash = 0;
      let weightedProp = 0;
      let avgCash = 0;
      let avgProp = 0;
      let minCash = 0;
      let minProp = 0;
      let maxCash = 0;
      let maxProp = 0;
      let latestCash = 0;
      let latestProp = 0;

      for (const it of items) {
        const s = pick(it);
        if (s.hasRealHistory) matched += 1;
        totalObs += s.observationsCount;
        if (s.lastSeenAt && (!lastObservedAt || s.lastSeenAt > lastObservedAt)) {
          lastObservedAt = s.lastSeenAt;
        }
        weightedCash += s.weightedCashCost;
        weightedProp += s.weightedProportionalCost;
        avgCash += s.avgCashCost;
        avgProp += s.avgProportionalCost;
        minCash += s.minCashCost;
        minProp += s.minProportionalCost;
        maxCash += s.maxCashCost;
        maxProp += s.maxProportionalCost;
        latestCash += s.latestCashCost;
        latestProp += s.latestProportionalCost;
      }

      const total = items.length;
      return {
        storeName,
        matchedIngredientsCount: matched,
        totalIngredientsCount: total,
        coveragePct: total > 0 ? Number(((matched / total) * 100).toFixed(1)) : 0,
        totalObservationsCount: totalObs,
        lastObservedAt,
        weightedCashCost: Number(weightedCash.toFixed(2)),
        weightedProportionalCost: Number(weightedProp.toFixed(2)),
        avgHistoricalCashCost: Number(avgCash.toFixed(2)),
        avgHistoricalProportionalCost: Number(avgProp.toFixed(2)),
        minHistoricalCashCost: Number(minCash.toFixed(2)),
        minHistoricalProportionalCost: Number(minProp.toFixed(2)),
        maxHistoricalCashCost: Number(maxCash.toFixed(2)),
        maxHistoricalProportionalCost: Number(maxProp.toFixed(2)),
        latestCashCost: Number(latestCash.toFixed(2)),
        latestProportionalCost: Number(latestProp.toFixed(2))
      };
    };

    const mercadoSouzaTotals = accumulateStore('Mercado Souza', (it) => it.mercadoSouza);
    const neSupermercadoTotals = accumulateStore('NE Supermercado', (it) => it.neSupermercado);

    const sharedItems = items.filter(
      (it) => it.mercadoSouza.hasRealHistory && it.neSupermercado.hasRealHistory
    );

    const commonOnly = {
      sharedIngredientsCount: sharedItems.length,
      mercadoSouzaWeightedCash: Number(
        sharedItems.reduce((s, it) => s + it.mercadoSouza.weightedCashCost, 0).toFixed(2)
      ),
      neSupermercadoWeightedCash: Number(
        sharedItems.reduce((s, it) => s + it.neSupermercado.weightedCashCost, 0).toFixed(2)
      ),
      mercadoSouzaWeightedProportional: Number(
        sharedItems.reduce((s, it) => s + it.mercadoSouza.weightedProportionalCost, 0).toFixed(2)
      ),
      neSupermercadoWeightedProportional: Number(
        sharedItems.reduce((s, it) => s + it.neSupermercado.weightedProportionalCost, 0).toFixed(2)
      ),
      mercadoSouzaAvgCash: Number(
        sharedItems.reduce((s, it) => s + it.mercadoSouza.avgCashCost, 0).toFixed(2)
      ),
      neSupermercadoAvgCash: Number(
        sharedItems.reduce((s, it) => s + it.neSupermercado.avgCashCost, 0).toFixed(2)
      ),
      mercadoSouzaMinCash: Number(
        sharedItems.reduce((s, it) => s + it.mercadoSouza.minCashCost, 0).toFixed(2)
      ),
      neSupermercadoMinCash: Number(
        sharedItems.reduce((s, it) => s + it.neSupermercado.minCashCost, 0).toFixed(2)
      )
    };

    const cashDiff = Number(
      (mercadoSouzaTotals.weightedCashCost - neSupermercadoTotals.weightedCashCost).toFixed(2)
    );
    const winnerWeightedCash: RecipeTwoStoreComparison['winnerWeightedCash'] =
      Math.abs(cashDiff) <= 0.05
        ? 'TIE'
        : cashDiff > 0
          ? 'NE_SUPERMERCADO'
          : 'MERCADO_SOUZA';
    const savingsWeightedCash = Number(Math.abs(cashDiff).toFixed(2));
    const maxCash = Math.max(
      mercadoSouzaTotals.weightedCashCost,
      neSupermercadoTotals.weightedCashCost
    );
    const savingsWeightedPct =
      maxCash > 0 ? Number(((savingsWeightedCash / maxCash) * 100).toFixed(1)) : 0;

    const propDiff = Number(
      (
        mercadoSouzaTotals.weightedProportionalCost -
        neSupermercadoTotals.weightedProportionalCost
      ).toFixed(2)
    );
    const winnerWeightedProportional: RecipeTwoStoreComparison['winnerWeightedProportional'] =
      Math.abs(propDiff) <= 0.05
        ? 'TIE'
        : propDiff > 0
          ? 'NE_SUPERMERCADO'
          : 'MERCADO_SOUZA';
    const savingsWeightedProportional = Number(Math.abs(propDiff).toFixed(2));

    // Constrói linha do tempo histórica dos últimos 6 meses (Jan..Dez/AA) para ambos os mercados
    const allDates: string[] = [];
    for (const it of items) {
      for (const pt of it.mercadoSouza.pricePoints) allDates.push(pt.observedAt);
      for (const pt of it.neSupermercado.pricePoints) allDates.push(pt.observedAt);
    }

    const ptMonths = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const anchorDate =
      allDates.length > 0
        ? new Date(
            Math.max(
              Date.now(),
              ...allDates.map((d) => new Date(d).getTime()).filter((t) => !Number.isNaN(t))
            )
          )
        : new Date();
    const anchorYear = anchorDate.getUTCFullYear();
    const anchorMonth = anchorDate.getUTCMonth(); // 0..11

    const rollingSixMonthsKeys: string[] = [];
    for (let offset = 5; offset >= 0; offset--) {
      const dt = new Date(Date.UTC(anchorYear, anchorMonth - offset, 15));
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      rollingSixMonthsKeys.push(`${y}-${m}`);
    }

    const toMonthKey = (iso: string) => iso.slice(0, 7);
    const toMonthLabel = (ymKey: string) => {
      const [yStr, mStr] = ymKey.split('-');
      const mIdx = Math.max(0, Math.min(11, Number(mStr) - 1));
      return `${ptMonths[mIdx]}/${yStr.slice(-2)}`;
    };

    const hasObsInRollingSix = allDates.some((d) => {
      const mk = toMonthKey(d);
      return mk >= rollingSixMonthsKeys[0] && mk <= rollingSixMonthsKeys[rollingSixMonthsKeys.length - 1];
    });

    const periodKeys = hasObsInRollingSix
      ? rollingSixMonthsKeys
      : Array.from(new Set(allDates.map(toMonthKey))).sort().slice(-6);

    const timeline: RecipeTimelineComparisonPoint[] = periodKeys.map((pKey) => {
      let souzaCash = 0;
      let neCash = 0;
      let souzaProp = 0;
      let neProp = 0;
      let souzaRealItems = 0;
      let neRealItems = 0;

      for (const it of items) {
        const souzaPts = it.mercadoSouza.pricePoints.filter((p) => toMonthKey(p.observedAt) <= pKey);
        if (souzaPts.length > 0) {
          const latest = souzaPts[souzaPts.length - 1];
          souzaCash += it.packagesNeeded * latest.packagePrice;
          souzaProp += it.requiredBaseQty * latest.basePrice;
          souzaRealItems += 1;
        } else {
          const first = it.mercadoSouza.pricePoints[0];
          souzaCash += first ? it.packagesNeeded * first.packagePrice : it.mercadoSouza.weightedCashCost;
          souzaProp += first
            ? it.requiredBaseQty * first.basePrice
            : it.mercadoSouza.weightedProportionalCost;
        }

        const nePts = it.neSupermercado.pricePoints.filter((p) => toMonthKey(p.observedAt) <= pKey);
        if (nePts.length > 0) {
          const latest = nePts[nePts.length - 1];
          neCash += it.packagesNeeded * latest.packagePrice;
          neProp += it.requiredBaseQty * latest.basePrice;
          neRealItems += 1;
        } else {
          const first = it.neSupermercado.pricePoints[0];
          neCash += first
            ? it.packagesNeeded * first.packagePrice
            : it.neSupermercado.weightedCashCost;
          neProp += first
            ? it.requiredBaseQty * first.basePrice
            : it.neSupermercado.weightedProportionalCost;
        }
      }

      return {
        periodLabel: toMonthLabel(pKey),
        sortKey: pKey,
        mercadoSouzaCash: Number(souzaCash.toFixed(2)),
        neSupermercadoCash: Number(neCash.toFixed(2)),
        mercadoSouzaProportional: Number(souzaProp.toFixed(2)),
        neSupermercadoProportional: Number(neProp.toFixed(2)),
        mercadoSouzaRealItems: souzaRealItems,
        neSupermercadoRealItems: neRealItems
      };
    });

    return {
      mercadoSouza: mercadoSouzaTotals,
      neSupermercado: neSupermercadoTotals,
      commonOnly,
      winnerWeightedCash,
      savingsWeightedCash,
      savingsWeightedPct,
      winnerWeightedProportional,
      savingsWeightedProportional,
      items,
      timeline
    };
  }

  /**
   * 4. Simulador Logístico Completo: Mercado Único (`Casa -> M1 -> Casa`) vs. Compra Dividida (`Casa -> M1 -> M2 -> Casa`)
   * Compara Gasolina vs. Uber e aplica a trava `MIN_SAVINGS_HURDLE = R$ 25,00`.
   */
  async optimizeShoppingTrip(customItems?: ShoppingListItemInput[]): Promise<OptimizationVerdict> {
    const stores = await queryArgus<{
      id: string;
      trading_name: string;
      latitude: string;
      longitude: string;
    }>(`SELECT id, trading_name, latitude, longitude FROM argus.stores ORDER BY trading_name ASC`);

    if (stores.length === 0) {
      const emptyScenario: LogisticsScenario = {
        mode: 'SINGLE_STORE',
        title: 'Aguardando 1º Cupom Fiscal Real',
        storesVisited: [],
        productsCost: 0,
        totalDistanceKm: 0,
        totalDurationMin: 0,
        gasCost: 0,
        uberCost: 0,
        totalWithGas: 0,
        totalWithUber: 0,
        routeLegs: []
      };
      return {
        singleStoreBest: emptyScenario,
        splitStoreBest: { ...emptyScenario, mode: 'SPLIT_STORES' },
        otherSingleStores: [],
        grossProductSavings: 0,
        netSavingsWithGas: 0,
        netSavingsWithUber: 0,
        minSavingsHurdle: env.MIN_SAVINGS_HURDLE,
        recommendSplitWithGas: false,
        recommendSplitWithUber: false,
        recommendedTransportMode: 'CAR_GAS',
        argusVerdictText:
          '👁️ VEREDITO ARGUS: Nenhum mercado real cadastrado ainda. Envie a foto do seu primeiro cupom fiscal para habilitar a simulação logística de rotas!'
      };
    }

    const priceRows = await queryArgus<{
      canonical_product_id: string;
      product_name: string;
      standard_package_size: string;
      store_id: string;
      store_name: string;
      estimated_package_price: string;
    }>(`SELECT * FROM argus.v_current_product_prices WHERE category <> 'Combustível'`);

    // Se nenhuma cesta customizada foi passada, monta a cesta mensal padrão das receitas + itens essenciais
    let basket: ShoppingListItemInput[] = customItems ?? [];
    if (basket.length === 0) {
      const essentialProducts = await queryArgus<{
        id: string;
        standard_package_size: string;
        category: string;
      }>(
        `SELECT id, standard_package_size, category
         FROM argus.canonical_products
         WHERE is_essential = TRUE AND category <> 'Combustível'
         ORDER BY name ASC`
      );
      basket = essentialProducts.map((p) => ({
        canonicalProductId: p.id,
        // Cesta mensal realista (ex: 2 a 4 embalagens de cada item essencial para abastecer o mês)
        requiredBaseQty:
          Number(p.standard_package_size) *
          (p.category === 'Carnes' || p.category === 'Laticínios' ? 3 : 2)
      }));
    }

    const gasPricePerLiter = await this.getLatestGasPricePerLiter();
    const homeNode = {
      name: 'Minha Casa',
      lat: env.HOME_LAT,
      lng: env.HOME_LNG
    };

    // Avalia cada Mercado Único: Casa -> M1 -> Casa
    const singleScenarios: LogisticsScenario[] = [];

    for (const store of stores) {
      const storeNode = {
        name: store.trading_name,
        lat: Number(store.latitude),
        lng: Number(store.longitude)
      };

      let productsCost = 0;
      const storeItems: LogisticsScenario['storesVisited'][0]['items'] = [];

      for (const basketItem of basket) {
        const pRow =
          priceRows.find(
            (r) =>
              r.canonical_product_id === basketItem.canonicalProductId &&
              r.store_id === store.id
          ) ??
          priceRows.find((r) => r.canonical_product_id === basketItem.canonicalProductId);

        if (!pRow) continue;

        const stdPkg = Number(pRow.standard_package_size);
        const packages = Math.max(1, Math.ceil(basketItem.requiredBaseQty / stdPkg));
        const pkgPrice = Number(pRow.estimated_package_price);
        const lineTotal = Number((packages * pkgPrice).toFixed(2));
        productsCost += lineTotal;

        storeItems.push({
          productId: basketItem.canonicalProductId,
          productName: pRow.product_name,
          packages,
          packagePrice: pkgPrice,
          lineTotal
        });
      }

      const legOut = await this.calculateOsrmLeg(homeNode, storeNode);
      const legBack = await this.calculateOsrmLeg(storeNode, homeNode);
      const totalDistanceKm = Number((legOut.distanceKm + legBack.distanceKm).toFixed(2));
      const totalDurationMin = legOut.durationMin + legBack.durationMin;

      const gasCost = Number(((totalDistanceKm / env.CAR_KM_PER_LITER) * gasPricePerLiter).toFixed(2));
      const uberCost = Number(
        (
          this.calculateUberLegFare(legOut.distanceKm, legOut.durationMin) +
          this.calculateUberLegFare(legBack.distanceKm, legBack.durationMin)
        ).toFixed(2)
      );

      singleScenarios.push({
        mode: 'SINGLE_STORE',
        title: `Mercado Único: ${store.trading_name}`,
        storesVisited: [
          {
            storeId: store.id,
            storeName: store.trading_name,
            lat: storeNode.lat,
            lng: storeNode.lng,
            itemsCount: storeItems.length,
            subtotalProducts: Number(productsCost.toFixed(2)),
            items: storeItems
          }
        ],
        productsCost: Number(productsCost.toFixed(2)),
        totalDistanceKm,
        totalDurationMin,
        gasCost,
        uberCost,
        totalWithGas: Number((productsCost + gasCost).toFixed(2)),
        totalWithUber: Number((productsCost + uberCost).toFixed(2)),
        routeLegs: [legOut, legBack]
      });
    }

    singleScenarios.sort((a, b) => a.totalWithGas - b.totalWithGas);
    const singleStoreBest = singleScenarios[0];
    const otherSingleStores = singleScenarios.slice(1);

    // Avalia Compra Dividida (Arbitragem entre os 2 melhores mercados por item): Casa -> M1 -> M2 -> Casa
    const topTwoStores = stores.slice(0, 2);
    const splitMap = new Map<
      string,
      {
        store: (typeof stores)[0];
        items: LogisticsScenario['storesVisited'][0]['items'];
        subtotal: number;
      }
    >();

    for (const st of stores) {
      splitMap.set(st.id, { store: st, items: [], subtotal: 0 });
    }

    let splitProductsCost = 0;

    for (const basketItem of basket) {
      const candidates = priceRows
        .filter((r) => r.canonical_product_id === basketItem.canonicalProductId)
        .sort((a, b) => Number(a.estimated_package_price) - Number(b.estimated_package_price));

      const best = candidates[0];
      if (!best) continue;

      const stdPkg = Number(best.standard_package_size);
      const packages = Math.max(1, Math.ceil(basketItem.requiredBaseQty / stdPkg));
      const pkgPrice = Number(best.estimated_package_price);
      const lineTotal = Number((packages * pkgPrice).toFixed(2));
      splitProductsCost += lineTotal;

      const bucket = splitMap.get(best.store_id);
      if (bucket) {
        bucket.subtotal = Number((bucket.subtotal + lineTotal).toFixed(2));
        bucket.items.push({
          productId: basketItem.canonicalProductId,
          productName: best.product_name,
          packages,
          packagePrice: pkgPrice,
          lineTotal
        });
      }
    }

    // Seleciona os 2 mercados com maior volume na compra dividida para o circuito Casa -> M1 -> M2 -> Casa
    const activeSplitStores = Array.from(splitMap.values())
      .filter((b) => b.items.length > 0)
      .sort((a, b) => b.subtotal - a.subtotal)
      .slice(0, 2);

    const m1 = activeSplitStores[0]?.store ?? topTwoStores[0];
    const m2 = activeSplitStores[1]?.store ?? topTwoStores[1] ?? topTwoStores[0];

    const m1Node = { name: m1.trading_name, lat: Number(m1.latitude), lng: Number(m1.longitude) };
    const m2Node = { name: m2.trading_name, lat: Number(m2.latitude), lng: Number(m2.longitude) };

    const leg1 = await this.calculateOsrmLeg(homeNode, m1Node);
    const leg2 = await this.calculateOsrmLeg(m1Node, m2Node);
    const leg3 = await this.calculateOsrmLeg(m2Node, homeNode);

    const splitDistKm = Number((leg1.distanceKm + leg2.distanceKm + leg3.distanceKm).toFixed(2));
    const splitDurMin = leg1.durationMin + leg2.durationMin + leg3.durationMin;
    const splitGasCost = Number(((splitDistKm / env.CAR_KM_PER_LITER) * gasPricePerLiter).toFixed(2));
    const splitUberCost = Number(
      (
        this.calculateUberLegFare(leg1.distanceKm, leg1.durationMin) +
        this.calculateUberLegFare(leg2.distanceKm, leg2.durationMin) +
        this.calculateUberLegFare(leg3.distanceKm, leg3.durationMin)
      ).toFixed(2)
    );

    const splitStoreBest: LogisticsScenario = {
      mode: 'SPLIT_STORES',
      title: `Compra Dividida (${m1.trading_name} + ${m2.trading_name})`,
      storesVisited: activeSplitStores.map((b) => ({
        storeId: b.store.id,
        storeName: b.store.trading_name,
        lat: Number(b.store.latitude),
        lng: Number(b.store.longitude),
        itemsCount: b.items.length,
        subtotalProducts: b.subtotal,
        items: b.items
      })),
      productsCost: Number(splitProductsCost.toFixed(2)),
      totalDistanceKm: splitDistKm,
      totalDurationMin: splitDurMin,
      gasCost: splitGasCost,
      uberCost: splitUberCost,
      totalWithGas: Number((splitProductsCost + splitGasCost).toFixed(2)),
      totalWithUber: Number((splitProductsCost + splitUberCost).toFixed(2)),
      routeLegs: [leg1, leg2, leg3]
    };

    const grossProductSavings = Number(
      (singleStoreBest.productsCost - splitStoreBest.productsCost).toFixed(2)
    );
    const netSavingsWithGas = Number(
      (singleStoreBest.totalWithGas - splitStoreBest.totalWithGas).toFixed(2)
    );
    const netSavingsWithUber = Number(
      (singleStoreBest.totalWithUber - splitStoreBest.totalWithUber).toFixed(2)
    );

    const hurdle = env.MIN_SAVINGS_HURDLE;
    const recommendSplitWithGas = netSavingsWithGas >= hurdle;
    const recommendSplitWithUber = netSavingsWithUber >= hurdle;
    const recommendedTransportMode =
      splitStoreBest.gasCost <= splitStoreBest.uberCost ? 'CAR_GAS' : 'UBER';

    const argusVerdictText = recommendSplitWithGas
      ? `👁️ VEREDITO ARGUS: A Compra Dividida (${m1.trading_name} + ${m2.trading_name}) indo de Carro gera uma economia líquida de R$ ${netSavingsWithGas.toFixed(
          2
        )} (superando a trava mínima de R$ ${hurdle.toFixed(
          2
        )}). De Uber, o trecho intermediário encarece a rota e reduz o ganho para R$ ${netSavingsWithUber.toFixed(
          2
        )}.`
      : `👁️ VEREDITO ARGUS: NÃO divida a compra! A economia líquida após combustível (R$ ${netSavingsWithGas.toFixed(
          2
        )}) fica abaixo da trava mínima de R$ ${hurdle.toFixed(
          2
        )}. Concentre 100% da compra no ${singleStoreBest.storesVisited[0]?.storeName}.`;

    return {
      singleStoreBest,
      splitStoreBest,
      otherSingleStores,
      grossProductSavings,
      netSavingsWithGas,
      netSavingsWithUber,
      minSavingsHurdle: hurdle,
      recommendSplitWithGas,
      recommendSplitWithUber,
      recommendedTransportMode,
      argusVerdictText
    };
  }
}
