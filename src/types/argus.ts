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

export interface RecipeCostEvaluation {
  recipeId: string;
  recipeName: string;
  servings: number;
  requestedPortions: number;
  proportionalTotalCost: number;
  proportionalCostPerPortion: number;
  cashOutlayTotalCost: number;
  bestSingleStoreName: string;
  ingredientsBreakdown: Array<{
    productId: string;
    productName: string;
    baseUnit: BaseUnit;
    requiredBaseQty: number;
    standardPackageSize: number;
    packagesNeeded: number;
    bestStoreName: string;
    proportionalCost: number;
    cashOutlayCost: number;
  }>;
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
