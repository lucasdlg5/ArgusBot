// =============================================================================
// ARGUS (moneta-argus) - Contratos de Domínio, BI, Logística e Open Finance
// =============================================================================

export type ProductCategory =
  | 'Carnes'
  | 'Laticínios'
  | 'Hortifruti'
  | 'Mercearia'
  | 'Limpeza'
  | 'Higiene'
  | 'Bebidas'
  | 'Besteiras/Impulso'
  | 'Combustível';

export type BaseUnit = 'g' | 'ml' | 'un';
export type ReceiptUnitType = 'KG' | 'UN' | 'LT';
export type PaymentMethod = 'PIX' | 'CREDIT_CARD' | 'DEBIT' | 'VR_VA' | 'CASH';

export interface ArgusStore {
  id: string;
  cnpj: string;
  raw_name: string;
  trading_name: string;
  address: string;
  latitude: number;
  longitude: number;
  created_at: string;
}

export interface CanonicalProduct {
  id: string;
  name: string;
  category: ProductCategory;
  base_unit: BaseUnit;
  standard_package_size: number;
  is_essential: boolean;
}

export interface ProductAlias {
  raw_description: string;
  ean?: string | null;
  canonical_product_id: string;
  package_multiplier: number;
  last_seen_package_size: number;
}

export interface ArgusReceipt {
  id: string;
  store_id: string;
  purchase_date: string;
  total_amount: number;
  discount_amount: number;
  payment_method: PaymentMethod;
  access_key: string;
  open_finance_tx_id?: string | null;
  reconciled: boolean;
}

export interface ArgusReceiptItem {
  id: string;
  receipt_id: string;
  canonical_product_id: string;
  raw_description: string;
  quantity: number;
  unit_type: ReceiptUnitType;
  unit_price: number;
  total_price: number;
  normalized_price_per_base_unit: number;
}

export interface ArgusRecipe {
  id: string;
  name: string;
  servings: number;
  instructions: string;
  ingredients: ArgusRecipeIngredient[];
}

export interface ArgusRecipeIngredient {
  recipe_id: string;
  canonical_product_id: string;
  quantity_in_base_unit: number;
}

// =============================================================================
// VIEWS ANALÍTICAS DO ARGUS VISION BI
// =============================================================================

export interface CurrentProductPriceView {
  canonical_product_id: string;
  product_name: string;
  category: ProductCategory;
  base_unit: BaseUnit;
  standard_package_size: number;
  is_essential: boolean;
  store_id: string;
  store_name: string;
  estimated_base_price: number;
  estimated_package_price: number;
  min_historical_price: number;
  max_historical_price: number;
  days_since_last_seen: number;
  last_seen_at: string;
  observations_count: number;
}

export interface StoreCategoryHeatmapView {
  store_id: string;
  store_name: string;
  category: ProductCategory;
  products_tracked: number;
  competitiveness_index: number; // 100 = média, <100 = mais barato
  basket_category_cost: number;
  min_days_since_seen: number;
  max_days_since_seen: number;
  freshness_tier: '< 15 dias' | '15-30 dias' | '> 30 dias';
}

export interface PersonalInflationAndShrinkflationView {
  canonical_product_id: string;
  product_name: string;
  category: ProductCategory;
  base_unit: BaseUnit;
  standard_package_size: number;
  latest_seen_package_size: number;
  ref_month: string;
  avg_std_package_price: number;
  mom_inflation_pct: number;
  shrinkflation_detected: boolean;
  package_reduction_pct: number;
}

export interface TrueSpendingBreakdownView {
  ref_month: string;
  wallet_source: 'BANK_ACCOUNT' | 'VR_VA';
  payment_method: PaymentMethod;
  category: ProductCategory;
  is_essential: boolean;
  spending_pillar:
    | 'Alimentação Essencial'
    | 'Limpeza & Higiene'
    | 'Besteiras/Impulso'
    | 'Combustível & Logística';
  receipts_count: number;
  reconciled_receipts_count: number;
  total_spent: number;
}

// =============================================================================
// OPEN FINANCE & CONCILIAÇÃO (Herdado de MonetaSync)
// =============================================================================

export interface OpenFinanceTransaction {
  id: string;
  accountId: string;
  accountName: string;
  description: string;
  amount: number;
  transactionDate: string;
  category: string;
  walletType: 'BANK_ACCOUNT' | 'VR_VA';
  reconciledReceiptId?: string | null;
}

export interface ReconciliationSummary {
  scannedReceipts: number;
  pluggyTransactions: number;
  newlyMatched: number;
  totalReconciled: number;
  reconciliationRatePct: number;
  vrVaSyncedCount: number;
  sheetsSyncedRows: number;
  matches: Array<{
    receiptId: string;
    storeName: string;
    receiptAmount: number;
    pluggyTxId: string;
    pluggyDescription: string;
    pluggyAmount: number;
    timeDiffHours: number;
  }>;
}

// =============================================================================
// LOGÍSTICA, RECEITAS & OTIMIZADOR (GASOLINA vs. UBER)
// =============================================================================

export type PerishabilityTier =
  | 'NON_PERISHABLE'
  | 'SEMI_PERISHABLE'
  | 'REFRIGERATED'
  | 'FROZEN_OR_DELICATE';

export interface PerishabilityClassification {
  tier: PerishabilityTier;
  rank: 1 | 2 | 3 | 4; // 1 = comprar primeiro (não perecível), 4 = comprar por último (carnes/congelados/delicados)
  label: string;
  shoppingOrderHint: string;
  reason: string;
}

export type RecipeDifficulty = 'Fácil' | 'Média' | 'Elaborada';

export interface RecipeIngredientBreakdownItem {
  productId: string;
  productName: string;
  category?: ProductCategory;
  baseUnit: BaseUnit;
  requiredBaseQty: number;
  standardPackageSize: number;
  packagesNeeded: number;
  surplusBaseQty: number;
  surplusPct: number;
  leftoverValue: number;
  bestStoreId?: string;
  bestStoreName: string;
  bestUnitPrice?: number;
  bestPackagePrice?: number;
  proportionalCost: number;
  cashOutlayCost: number;
  hasRealPrice?: boolean;
  perishabilityTier: PerishabilityTier;
  perishabilityRank: 1 | 2 | 3 | 4;
  perishabilityLabel: string;
  perishabilityReason: string;
}

export interface SimilarRecipeSuggestion {
  recipeId: string;
  recipeName: string;
  sharedIngredients: string[];
  sharedCount: number;
  similarityPct: number;
  lowestPossibleCashCost: number;
  proportionalCostPerPortion: number;
  servings: number;
  prepTimeMinutes: number;
  difficulty: RecipeDifficulty;
  additionalOutlayEstimate: number;
}

export interface RecipeStoreQuote {
  storeId: string;
  storeName: string;
  address: string;
  lat: number;
  lng: number;
  totalCashCost: number;
  totalProportionalCost: number;
  matchedIngredientsCount: number;
  totalIngredientsCount: number;
  coveragePct: number;
  missingIngredients: string[];
  estimatedMissingCost: number;
  items: Array<{
    productId: string;
    productName: string;
    category: ProductCategory;
    packagesNeeded: number;
    packagePrice: number;
    proportionalCost: number;
    cashOutlayCost: number;
    hasRealPrice: boolean;
    perishabilityTier: PerishabilityTier;
    perishabilityRank: 1 | 2 | 3 | 4;
  }>;
}

export interface RecipeRouteStop {
  stopOrder: number;
  storeId: string;
  storeName: string;
  address: string;
  lat: number;
  lng: number;
  maxPerishabilityRank: 1 | 2 | 3 | 4;
  avgPerishabilityRank: number;
  coldChainStageLabel: string;
  coldChainReason: string;
  subtotalCashCost: number;
  subtotalProportionalCost: number;
  items: Array<{
    productId: string;
    productName: string;
    category: ProductCategory;
    baseUnit: BaseUnit;
    requiredBaseQty: number;
    packagesNeeded: number;
    packagePrice: number;
    cashOutlayCost: number;
    proportionalCost: number;
    perishabilityTier: PerishabilityTier;
    perishabilityRank: 1 | 2 | 3 | 4;
    perishabilityLabel: string;
    perishabilityReason: string;
    hasRealPrice: boolean;
  }>;
}

export interface RecipeRouteAnalysis {
  singleStoreBestId: string | null;
  singleStoreBestName: string;
  singleStoreScenario: LogisticsScenario | null;
  splitStoreScenario: LogisticsScenario | null;
  splitStoreOrder: RecipeRouteStop[];
  isMultiStoreSplitRecommended: boolean;
  splitSavingsAmount: number;
  netSplitSavingsWithGas: number;
  recommendedPurchaseOption: 'SINGLE_STORE' | 'SPLIT_STORES';
  coldChainProtectedMinutes: number;
  coldChainScore: number;
  coldChainSummary: string;
}

export interface StoreIngredientPricePoint {
  observedAt: string;
  packagePrice: number;
  basePrice: number;
  sourceType: string;
}

export interface StoreIngredientHistorySummary {
  storeName: string;
  hasRealHistory: boolean;
  observationsCount: number;
  latestPackagePrice: number;
  weightedPackagePrice: number;
  avgHistoricalPackagePrice: number;
  minHistoricalPackagePrice: number;
  maxHistoricalPackagePrice: number;
  latestProportionalCost: number;
  weightedProportionalCost: number;
  avgProportionalCost: number;
  minProportionalCost: number;
  maxProportionalCost: number;
  latestCashCost: number;
  weightedCashCost: number;
  avgCashCost: number;
  minCashCost: number;
  maxCashCost: number;
  lastSeenAt: string | null;
  pricePoints: StoreIngredientPricePoint[];
}

export interface RecipeStorePairComparisonItem {
  productId: string;
  productName: string;
  category: ProductCategory;
  baseUnit: BaseUnit;
  requiredBaseQty: number;
  standardPackageSize: number;
  packagesNeeded: number;
  mercadoSouza: StoreIngredientHistorySummary;
  neSupermercado: StoreIngredientHistorySummary;
  cheaperStoreWeighted: 'MERCADO_SOUZA' | 'NE_SUPERMERCADO' | 'TIE' | 'INSUFFICIENT_DATA';
  weightedCashDiff: number; // positivo = NE mais barato; negativo = Mercado Souza mais barato
  weightedProportionalDiff: number;
}

export interface RecipeStoreHistoryTotals {
  storeName: string;
  matchedIngredientsCount: number;
  totalIngredientsCount: number;
  coveragePct: number;
  totalObservationsCount: number;
  lastObservedAt: string | null;
  weightedCashCost: number;
  weightedProportionalCost: number;
  avgHistoricalCashCost: number;
  avgHistoricalProportionalCost: number;
  minHistoricalCashCost: number;
  minHistoricalProportionalCost: number;
  maxHistoricalCashCost: number;
  maxHistoricalProportionalCost: number;
  latestCashCost: number;
  latestProportionalCost: number;
}

export interface RecipeTimelineComparisonPoint {
  periodLabel: string;
  sortKey: string;
  mercadoSouzaCash: number;
  neSupermercadoCash: number;
  mercadoSouzaProportional: number;
  neSupermercadoProportional: number;
  mercadoSouzaRealItems: number;
  neSupermercadoRealItems: number;
}

export interface RecipeTwoStoreComparison {
  mercadoSouza: RecipeStoreHistoryTotals;
  neSupermercado: RecipeStoreHistoryTotals;
  commonOnly: {
    sharedIngredientsCount: number;
    mercadoSouzaWeightedCash: number;
    neSupermercadoWeightedCash: number;
    mercadoSouzaWeightedProportional: number;
    neSupermercadoWeightedProportional: number;
    mercadoSouzaAvgCash: number;
    neSupermercadoAvgCash: number;
    mercadoSouzaMinCash: number;
    neSupermercadoMinCash: number;
  };
  winnerWeightedCash: 'MERCADO_SOUZA' | 'NE_SUPERMERCADO' | 'TIE';
  savingsWeightedCash: number;
  savingsWeightedPct: number;
  winnerWeightedProportional: 'MERCADO_SOUZA' | 'NE_SUPERMERCADO' | 'TIE';
  savingsWeightedProportional: number;
  items: RecipeStorePairComparisonItem[];
  timeline: RecipeTimelineComparisonPoint[];
}

export interface RecipeCostEvaluation {
  recipeId: string;
  recipeName: string;
  servings: number;
  requestedPortions: number;
  instructions: string;
  instructionSteps: string[];
  prepTimeMinutes: number;
  difficulty: RecipeDifficulty;
  cuisineTags: string[];
  estimatedCaloriesPerPortion: number;
  proportionalTotalCost: number;
  proportionalCostPerPortion: number;
  cashOutlayTotalCost: number;
  totalLeftoverPantryValue: number;
  pantryUtilizationPct: number;
  bestSingleStoreId: string | null;
  bestSingleStoreName: string;
  bestSingleStoreAddress: string;
  bestSingleStoreCashCost: number;
  bestSingleStoreProportionalCost: number;
  bestSingleStoreCoveragePct: number;
  lowestPossibleProportionalCost: number;
  lowestPossibleCashCost: number;
  lowestPossibleStoresCount: number;
  priceCoverageCount: number;
  totalIngredientsCount: number;
  coldChainSummary: string;
  storeQuotes: RecipeStoreQuote[];
  ingredientsBreakdown: RecipeIngredientBreakdownItem[];
  similarRecipes?: SimilarRecipeSuggestion[];
  routeAnalysis?: RecipeRouteAnalysis;
  historicalStoreComparison?: RecipeTwoStoreComparison;
}

export interface RouteLegGeometry {
  fromName: string;
  toName: string;
  distanceKm: number;
  durationMin: number;
  coordinates: Array<[number, number]>; // [lat, lng] para Leaflet
}

export interface LogisticsScenario {
  mode: 'SINGLE_STORE' | 'SPLIT_STORES';
  title: string;
  storesVisited: Array<{
    storeId: string;
    storeName: string;
    lat: number;
    lng: number;
    itemsCount: number;
    subtotalProducts: number;
    items: Array<{
      productId: string;
      productName: string;
      packages: number;
      packagePrice: number;
      lineTotal: number;
    }>;
  }>;
  productsCost: number;
  totalDistanceKm: number;
  totalDurationMin: number;
  gasCost: number;
  uberCost: number;
  totalWithGas: number;
  totalWithUber: number;
  routeLegs: RouteLegGeometry[];
}

export interface OptimizationVerdict {
  singleStoreBest: LogisticsScenario;
  splitStoreBest: LogisticsScenario;
  otherSingleStores: LogisticsScenario[];
  grossProductSavings: number;
  netSavingsWithGas: number;
  netSavingsWithUber: number;
  minSavingsHurdle: number;
  recommendSplitWithGas: boolean;
  recommendSplitWithUber: boolean;
  recommendedTransportMode: 'CAR_GAS' | 'UBER';
  argusVerdictText: string;
}

// =============================================================================
// CATÁLOGO DE PRODUTOS ESCANEADOS & B.I. INDIVIDUAL POR MERCADO
// =============================================================================

export type ScannedProductSourceKind =
  | 'RECEIPT_ITEM'
  | 'SHELF_PHOTO'
  | 'MARKET_FLYER'
  | 'AISLE_VIDEO';

export interface ScannedProductEntry {
  id: string;
  observedAt: string;
  sourceKind: ScannedProductSourceKind;
  storeId: string | null;
  storeName: string;
  storeLocation: string;
  rawDescription: string;
  brandName: string;
  canonicalProductId: string | null;
  canonicalProductName: string;
  category: ProductCategory | string;
  baseUnit: BaseUnit;
  standardPackageSize: number;
  isEssential: boolean;
  quantity: number;
  unitType: string;
  unitPrice: number;
  totalPrice: number;
  promoPrice: number | null;
  normalizedPricePerBaseUnit: number;
  normalizedPackagePrice: number;
  confidenceScorePct: number;
  paymentMethod: PaymentMethod | null;
  missingInfoFlags: string[];
}

export interface StoreBiProductStat {
  canonicalProductId: string;
  productName: string;
  category: string;
  baseUnit: BaseUnit;
  timesPurchased: number;
  totalQuantityInUnit: number;
  totalSpent: number;
  avgUnitPrice: number;
  avgNormalizedPackagePrice: number;
  lastPurchasedAt: string;
  topBrand: string;
}

export interface StoreBiMonthlyPoint {
  monthKey: string;
  monthLabel: string;
  totalSpent: number;
  receiptsCount: number;
  avgTicket: number;
}

export interface StoreBiWeekdayPoint {
  weekdayIndex: number;
  weekdayLabel: string;
  totalSpent: number;
  receiptsCount: number;
  avgSpentPerVisit: number;
}

export interface StoreBiCategoryPoint {
  category: string;
  totalSpent: number;
  sharePct: number;
  itemsCount: number;
  competitivenessIndex: number | null;
}

export interface StoreBiReceiptSummary {
  receiptId: string;
  purchaseDate: string;
  totalAmount: number;
  discountAmount: number;
  paymentMethod: PaymentMethod;
  reconciled: boolean;
  itemsCount: number;
}

export interface StoreBiDetail {
  storeId: string;
  tradingName: string;
  rawName: string;
  cnpj: string;
  address: string;
  latitude: number;
  longitude: number;
  totalSpentAllTime: number;
  totalDiscountAllTime: number;
  receiptsCount: number;
  itemsPurchasedCount: number;
  collectedPricesCount: number;
  avgTicket: number;
  currentMonthLabel: string;
  currentMonthSpent: number;
  currentMonthReceiptsCount: number;
  previousMonthSpent: number;
  momSpendDeltaPct: number | null;
  dailySpendRateHistorical: number;
  dailySpendRateCurrentMonth: number;
  activeSpanDays: number;
  avgDaysBetweenVisits: number | null;
  visitsPerWeek: number;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
  mostConsumedProduct: StoreBiProductStat | null;
  highestSpendProduct: StoreBiProductStat | null;
  topProducts: StoreBiProductStat[];
  monthlySeries: StoreBiMonthlyPoint[];
  weekdaySeries: StoreBiWeekdayPoint[];
  categoryBreakdown: StoreBiCategoryPoint[];
  paymentBreakdown: Array<{
    method: string;
    totalSpent: number;
    receiptsCount: number;
    sharePct: number;
  }>;
  recentReceipts: StoreBiReceiptSummary[];
  overallCompetitivenessIndex: number | null;
}
