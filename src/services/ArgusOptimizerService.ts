import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus } from '../lib/db';
import type {
  BaseUnit,
  LogisticsScenario,
  OptimizationVerdict,
  RecipeCostEvaluation,
  RouteLegGeometry
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
   * 3. Avalia o Duplo Custo de Receitas (Proporcional por Porção vs. Desembolso de Caixa em Embalagens Fechadas)
   */
  async evaluateRecipeCosts(
    recipeId?: string,
    requestedPortionsOverride?: number
  ): Promise<RecipeCostEvaluation[]> {
    const recipes = await queryArgus<{
      id: string;
      name: string;
      servings: number;
      instructions: string;
    }>(
      recipeId
        ? `SELECT id, name, servings, instructions FROM argus.recipes WHERE id = $1`
        : `SELECT id, name, servings, instructions FROM argus.recipes ORDER BY name ASC`,
      recipeId ? [recipeId] : []
    );

    const priceRows = await queryArgus<{
      canonical_product_id: string;
      product_name: string;
      base_unit: BaseUnit;
      standard_package_size: string;
      store_id: string;
      store_name: string;
      estimated_base_price: string;
      estimated_package_price: string;
    }>(`SELECT * FROM argus.v_current_product_prices`);

    const evaluations: RecipeCostEvaluation[] = [];

    for (const recipe of recipes) {
      const ingredients = await queryArgus<{
        canonical_product_id: string;
        quantity_in_base_unit: string;
        product_name: string;
        base_unit: BaseUnit;
        standard_package_size: string;
      }>(
        `SELECT
           ri.canonical_product_id,
           ri.quantity_in_base_unit,
           cp.name AS product_name,
           cp.base_unit,
           cp.standard_package_size
         FROM argus.recipe_ingredients ri
         JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
         WHERE ri.recipe_id = $1`,
        [recipe.id]
      );

      const requestedPortions = requestedPortionsOverride ?? recipe.servings;
      const scaleFactor = requestedPortions / recipe.servings;

      let proportionalTotalCost = 0;
      let cashOutlayTotalCost = 0;
      const storeTotals = new Map<string, number>();
      const breakdown: RecipeCostEvaluation['ingredientsBreakdown'] = [];

      for (const ing of ingredients) {
        const requiredBaseQty = Number(ing.quantity_in_base_unit) * scaleFactor;
        const stdPkgSize = Number(ing.standard_package_size);
        const packagesNeeded = Math.ceil(requiredBaseQty / stdPkgSize);

        const productStorePrices = priceRows
          .filter((p) => p.canonical_product_id === ing.canonical_product_id)
          .sort((a, b) => Number(a.estimated_base_price) - Number(b.estimated_base_price));

        const bestPriceRow = productStorePrices[0];
        const basePrice = bestPriceRow ? Number(bestPriceRow.estimated_base_price) : 0.02;
        const pkgPrice = bestPriceRow
          ? Number(bestPriceRow.estimated_package_price)
          : basePrice * stdPkgSize;
        const bestStoreName = bestPriceRow?.store_name ?? 'Média de Mercado';

        for (const pRow of productStorePrices) {
          const prev = storeTotals.get(pRow.store_name) ?? 0;
          storeTotals.set(
            pRow.store_name,
            prev + packagesNeeded * Number(pRow.estimated_package_price)
          );
        }

        const propCost = Number((requiredBaseQty * basePrice).toFixed(2));
        const cashCost = Number((packagesNeeded * pkgPrice).toFixed(2));

        proportionalTotalCost += propCost;
        cashOutlayTotalCost += cashCost;

        breakdown.push({
          productId: ing.canonical_product_id,
          productName: ing.product_name,
          baseUnit: ing.base_unit,
          requiredBaseQty: Number(requiredBaseQty.toFixed(1)),
          standardPackageSize: stdPkgSize,
          packagesNeeded,
          bestStoreName,
          proportionalCost: propCost,
          cashOutlayCost: cashCost
        });
      }

      let bestSingleStoreName = 'Atacadão';
      let minStoreTotal = Infinity;
      for (const [stName, tot] of storeTotals.entries()) {
        if (tot < minStoreTotal) {
          minStoreTotal = tot;
          bestSingleStoreName = stName;
        }
      }

      evaluations.push({
        recipeId: recipe.id,
        recipeName: recipe.name,
        servings: recipe.servings,
        requestedPortions,
        proportionalTotalCost: Number(proportionalTotalCost.toFixed(2)),
        proportionalCostPerPortion: Number((proportionalTotalCost / requestedPortions).toFixed(2)),
        cashOutlayTotalCost: Number(cashOutlayTotalCost.toFixed(2)),
        bestSingleStoreName,
        ingredientsBreakdown: breakdown
      });
    }

    return evaluations;
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
