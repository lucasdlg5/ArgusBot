import type { BaseUnit, PaymentMethod, ProductCategory, ReceiptUnitType } from '../types/argus';
import { CANONICAL_STORE_NE, CANONICAL_STORE_SOUZA } from './store-normalization';

export interface MockStore {
  id: string;
  cnpj: string;
  raw_name: string;
  trading_name: string;
  address: string;
  latitude: number;
  longitude: number;
  created_at: string;
}

export interface MockProduct {
  id: string;
  name: string;
  category: ProductCategory;
  base_unit: BaseUnit;
  standard_package_size: number;
  is_essential: boolean;
  raw_alias: string;
  seen_package_size: number;
  unit_type: ReceiptUnitType;
  has_price_observations?: boolean;
  prices: {
    neSupermercado: [number, number, number];
    mercadoSouza: [number, number, number];
  };
}

export interface MockReceipt {
  id: string;
  store_id: string;
  store_name: string;
  purchase_date: string;
  total_amount: number;
  discount_amount: number;
  payment_method: PaymentMethod;
  access_key: string;
  open_finance_tx_id: string | null;
  reconciled: boolean;
}

export interface MockReceiptItem {
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

export interface MockCollectedPrice {
  id: string;
  canonical_product_id: string;
  store_id: string;
  store_name: string;
  collected_at: string;
  normalized_price_per_base_unit: number;
  package_price: number;
  source_type: 'MARKET_FLYER' | 'SHELF_PHOTO';
}

export interface MockRecipe {
  id: string;
  name: string;
  servings: number;
  instructions: string;
}

export interface MockRecipeIngredient {
  recipe_id: string;
  canonical_product_id: string;
  quantity_in_base_unit: number;
}

// 2 Mercados Canônicos Normalizados (NE SUPERMERCADO vs. MERCADO SOUZA)
export const MOCK_STORES: MockStore[] = [
  {
    id: 'store-ne-supermercado',
    cnpj: '99.104.228/0001-32',
    raw_name: 'NOVA EPOCA SUPERMERCADOS LTDA',
    trading_name: CANONICAL_STORE_NE,
    address: 'Av. Siqueira Campos, 680 - Centro, Jacareí - SP',
    latitude: -23.3044,
    longitude: -45.9662,
    created_at: new Date(Date.now() - 90 * 86400000).toISOString()
  },
  {
    id: 'store-mercado-souza',
    cnpj: '99.284.719/0001-14',
    raw_name: 'MERCADO SOUZA LTDA',
    trading_name: CANONICAL_STORE_SOUZA,
    address: 'Rua Bernardino de Campos, 420 - Centro, Jacareí - SP',
    latitude: -23.3092,
    longitude: -45.9615,
    created_at: new Date(Date.now() - 90 * 86400000).toISOString()
  }
];

export const MOCK_PRODUCTS: MockProduct[] = [
  {
    id: 'prod-01',
    name: 'Peito de Frango Sem Osso (1kg)',
    category: 'Carnes',
    base_unit: 'g',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'FILE PEITO FRANGO SADIA 1KG',
    seen_package_size: 1000,
    unit_type: 'KG',
    prices: {
      neSupermercado: [20.9, 19.9, 18.49],
      mercadoSouza: [22.5, 21.9, 20.9]
    }
  },
  {
    id: 'prod-02',
    name: 'Patinho Bovino Moído (1kg)',
    category: 'Carnes',
    base_unit: 'g',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'CARNE BOV PATINHO MOIDO KG',
    seen_package_size: 1000,
    unit_type: 'KG',
    prices: {
      neSupermercado: [38.9, 39.5, 37.9],
      mercadoSouza: [41.9, 40.9, 39.8]
    }
  },
  {
    id: 'prod-03',
    name: 'Acém Bovino em Cubos (1kg)',
    category: 'Carnes',
    base_unit: 'g',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'CARNE BOV ACEM CUBOS KG',
    seen_package_size: 1000,
    unit_type: 'KG',
    prices: {
      neSupermercado: [31.9, 30.9, 29.99],
      mercadoSouza: [33.5, 32.9, 32.49]
    }
  },
  {
    id: 'prod-04',
    name: 'Ovos Brancos Grandes (Cartela 30 un)',
    category: 'Carnes',
    base_unit: 'un',
    standard_package_size: 30,
    is_essential: true,
    raw_alias: 'OVOS BRANCOS EXTRA C/30 UN',
    seen_package_size: 30,
    unit_type: 'UN',
    prices: {
      neSupermercado: [19.9, 18.9, 17.9],
      mercadoSouza: [20.9, 19.5, 18.5]
    }
  },
  {
    id: 'prod-05',
    name: 'Leite Integral UHT (1L)',
    category: 'Laticínios',
    base_unit: 'ml',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'LEITE UHT INTEGRAL ITALAC 1L',
    seen_package_size: 1000,
    unit_type: 'LT',
    prices: {
      neSupermercado: [5.69, 5.49, 5.19],
      mercadoSouza: [5.29, 4.99, 4.69]
    }
  },
  {
    id: 'prod-06',
    name: 'Creme de Leite UHT (200g)',
    category: 'Laticínios',
    base_unit: 'g',
    standard_package_size: 200,
    is_essential: true,
    raw_alias: 'CREME DE LEITE NESTLE TP 200G',
    seen_package_size: 200,
    unit_type: 'UN',
    prices: {
      neSupermercado: [3.99, 3.89, 3.69],
      mercadoSouza: [3.59, 3.49, 3.19]
    }
  },
  {
    id: 'prod-07',
    name: 'Manteiga Extra Sem Sal (200g)',
    category: 'Laticínios',
    base_unit: 'g',
    standard_package_size: 200,
    is_essential: true,
    raw_alias: 'MANTEIGA AVIACAO TABLETE 200G',
    seen_package_size: 200,
    unit_type: 'UN',
    prices: {
      neSupermercado: [12.49, 12.9, 13.29],
      mercadoSouza: [11.5, 11.9, 11.79]
    }
  },
  {
    id: 'prod-08',
    name: 'Arroz Agulhinha Tipo 1 (5kg)',
    category: 'Mercearia',
    base_unit: 'g',
    standard_package_size: 5000,
    is_essential: true,
    raw_alias: 'ARROZ T1 CAMIL PCT 5KG',
    seen_package_size: 5000,
    unit_type: 'UN',
    prices: {
      neSupermercado: [27.9, 26.5, 24.9],
      mercadoSouza: [29.5, 28.9, 27.9]
    }
  },
  {
    id: 'prod-09',
    name: 'Feijão Carioca Tipo 1 (1kg)',
    category: 'Mercearia',
    base_unit: 'g',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'FEIJAO CARIOCA CAMIL 1KG',
    seen_package_size: 1000,
    unit_type: 'UN',
    prices: {
      neSupermercado: [8.29, 7.89, 7.49],
      mercadoSouza: [7.69, 7.39, 6.89]
    }
  },
  {
    id: 'prod-10',
    name: 'Azeite de Oliva Extra Virgem (500ml)',
    category: 'Mercearia',
    base_unit: 'ml',
    standard_package_size: 500,
    is_essential: true,
    raw_alias: 'AZEITE PORTUGUES GALLO VD 500ML',
    seen_package_size: 500,
    unit_type: 'UN',
    prices: {
      neSupermercado: [41.9, 43.9, 45.9],
      mercadoSouza: [38.9, 40.9, 42.9]
    }
  },
  {
    id: 'prod-11',
    name: 'Café Torrado e Moído Tradicional (500g)',
    category: 'Mercearia',
    base_unit: 'g',
    standard_package_size: 500,
    is_essential: true,
    raw_alias: 'CAFE PILAO TRADICIONAL VACUO 500G',
    seen_package_size: 500,
    unit_type: 'UN',
    prices: {
      neSupermercado: [17.9, 19.5, 21.49],
      mercadoSouza: [18.9, 20.5, 22.49]
    }
  },
  {
    id: 'prod-12',
    name: 'Catchup Tradicional (400g)',
    category: 'Mercearia',
    base_unit: 'g',
    standard_package_size: 400,
    is_essential: true,
    raw_alias: 'CATCHUP HEINZ TRAD 397G',
    seen_package_size: 397,
    unit_type: 'UN',
    prices: {
      neSupermercado: [11.2, 11.49, 10.99],
      mercadoSouza: [10.49, 10.29, 9.79]
    }
  },
  {
    id: 'prod-13',
    name: 'Batata Monalisa Lavada (1kg)',
    category: 'Hortifruti',
    base_unit: 'g',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'BATATA MONALISA EXTRA KG',
    seen_package_size: 1000,
    unit_type: 'KG',
    prices: {
      neSupermercado: [6.99, 6.49, 5.99],
      mercadoSouza: [5.99, 5.49, 4.79]
    }
  },
  {
    id: 'prod-14',
    name: 'Cebola Nacional (1kg)',
    category: 'Hortifruti',
    base_unit: 'g',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'CEBOLA NACIONAL GRANEL KG',
    seen_package_size: 1000,
    unit_type: 'KG',
    prices: {
      neSupermercado: [5.99, 5.49, 5.29],
      mercadoSouza: [5.29, 4.89, 4.49]
    }
  },
  {
    id: 'prod-15',
    name: 'Champignon Fatiado em Conserva (100g)',
    category: 'Hortifruti',
    base_unit: 'g',
    standard_package_size: 100,
    is_essential: true,
    raw_alias: 'COGUMELO CHAMPIGNON HEMMER 100G',
    seen_package_size: 100,
    unit_type: 'UN',
    prices: {
      neSupermercado: [8.29, 7.99, 7.79],
      mercadoSouza: [7.49, 7.19, 6.79]
    }
  },
  {
    id: 'prod-16',
    name: 'Lava-Roupas em Pó Omo (Caixa 800g -> Reduflação 720g)',
    category: 'Limpeza',
    base_unit: 'g',
    standard_package_size: 800,
    is_essential: true,
    raw_alias: 'SABAO PO OMO LAVAGEM PERFEITA 720G',
    seen_package_size: 720,
    unit_type: 'UN',
    prices: {
      neSupermercado: [14.9, 14.9, 15.49],
      mercadoSouza: [13.9, 13.9, 14.29]
    }
  },
  {
    id: 'prod-17',
    name: 'Papel Higiênico Folha Dupla Neve (Leve 12 Pague 11 - 30m -> Reduflação 20m)',
    category: 'Higiene',
    base_unit: 'un',
    standard_package_size: 12,
    is_essential: true,
    raw_alias: 'PAPEL HIG NEVE FD COMPACTO 12X20M',
    seen_package_size: 10,
    unit_type: 'UN',
    prices: {
      neSupermercado: [21.9, 22.5, 22.9],
      mercadoSouza: [20.5, 20.9, 21.49]
    }
  },
  {
    id: 'prod-18',
    name: 'Barra de Chocolate Ao Leite Lacta (90g -> Reduflação 80g)',
    category: 'Besteiras/Impulso',
    base_unit: 'g',
    standard_package_size: 90,
    is_essential: false,
    raw_alias: 'CHOC BARRA LACTA AO LEITE 80G',
    seen_package_size: 80,
    unit_type: 'UN',
    prices: {
      neSupermercado: [6.49, 6.79, 6.99],
      mercadoSouza: [6.29, 6.59, 6.79]
    }
  },
  {
    id: 'prod-19',
    name: 'Pack Cerveja Puro Malte Long Neck (6x330ml)',
    category: 'Besteiras/Impulso',
    base_unit: 'ml',
    standard_package_size: 1980,
    is_essential: false,
    raw_alias: 'CERVEJA HEINEKEN LN PACK 6X330ML',
    seen_package_size: 1980,
    unit_type: 'UN',
    prices: {
      neSupermercado: [36.9, 35.9, 34.9],
      mercadoSouza: [37.9, 36.9, 35.9]
    }
  },
  {
    id: 'prod-20',
    name: 'Gasolina Comum Aditivada (1 Litro)',
    category: 'Combustível',
    base_unit: 'ml',
    standard_package_size: 1000,
    is_essential: true,
    raw_alias: 'GASOLINA COMUM BOMBA LT',
    seen_package_size: 1000,
    unit_type: 'LT',
    prices: {
      neSupermercado: [5.79, 5.85, 5.89],
      mercadoSouza: [5.85, 5.89, 5.95]
    }
  }
];

export const MOCK_RECIPES: MockRecipe[] = [
  {
    id: 'recipe-01',
    name: 'Strogonoff de Frango com Arroz Branco',
    servings: 6,
    instructions:
      '1. Doure a cebola na manteiga e azeite. 2. Sele o peito de frango em cubos. 3. Adicione catchup, champignon e finalize com creme de leite. 4. Sirva com arroz branco soltinho.'
  },
  {
    id: 'recipe-02',
    name: 'Frango Grelhado com Purê Cremoso de Batata',
    servings: 5,
    instructions:
      '1. Tempere os filés de peito de frango e grelhe no azeite. 2. Cozinhe as batatas Monalisa, amasse e bata no fogo com leite integral e manteiga até obter um purê aveludado.'
  },
  {
    id: 'recipe-03',
    name: 'Escondidinho de Patinho Moído com Purê de Batata',
    servings: 6,
    instructions:
      '1. Refogue a cebola no azeite e doure o patinho moído até secar bem. 2. Cozinhe as batatas, amasse e misture com manteiga e leite integral quente. 3. Monte camadas de carne e purê em refratário e leve ao forno para gratinar.'
  },
  {
    id: 'recipe-04',
    name: 'Arroz Carreteiro Econômico de Acém com Ovos',
    servings: 5,
    instructions:
      '1. Sele os cubos de acém com cebola no azeite até dourar. 2. Acrescente o arroz e água fervente para cozinhar em panela única. 3. Finalize com ovos fritos ou mexidos por cima para reforçar a proteína.'
  }
];

export const MOCK_RECIPE_INGREDIENTS: MockRecipeIngredient[] = [
  { recipe_id: 'recipe-01', canonical_product_id: 'prod-01', quantity_in_base_unit: 800 },
  { recipe_id: 'recipe-01', canonical_product_id: 'prod-06', quantity_in_base_unit: 400 },
  { recipe_id: 'recipe-01', canonical_product_id: 'prod-12', quantity_in_base_unit: 120 },
  { recipe_id: 'recipe-01', canonical_product_id: 'prod-15', quantity_in_base_unit: 100 },
  { recipe_id: 'recipe-01', canonical_product_id: 'prod-14', quantity_in_base_unit: 150 },
  { recipe_id: 'recipe-01', canonical_product_id: 'prod-07', quantity_in_base_unit: 30 },
  { recipe_id: 'recipe-01', canonical_product_id: 'prod-08', quantity_in_base_unit: 500 },

  { recipe_id: 'recipe-02', canonical_product_id: 'prod-01', quantity_in_base_unit: 750 },
  { recipe_id: 'recipe-02', canonical_product_id: 'prod-13', quantity_in_base_unit: 1000 },
  { recipe_id: 'recipe-02', canonical_product_id: 'prod-05', quantity_in_base_unit: 250 },
  { recipe_id: 'recipe-02', canonical_product_id: 'prod-07', quantity_in_base_unit: 50 },
  { recipe_id: 'recipe-02', canonical_product_id: 'prod-10', quantity_in_base_unit: 25 },
  { recipe_id: 'recipe-02', canonical_product_id: 'prod-14', quantity_in_base_unit: 100 },

  { recipe_id: 'recipe-03', canonical_product_id: 'prod-02', quantity_in_base_unit: 700 },
  { recipe_id: 'recipe-03', canonical_product_id: 'prod-13', quantity_in_base_unit: 1200 },
  { recipe_id: 'recipe-03', canonical_product_id: 'prod-05', quantity_in_base_unit: 250 },
  { recipe_id: 'recipe-03', canonical_product_id: 'prod-07', quantity_in_base_unit: 50 },
  { recipe_id: 'recipe-03', canonical_product_id: 'prod-14', quantity_in_base_unit: 150 },
  { recipe_id: 'recipe-03', canonical_product_id: 'prod-10', quantity_in_base_unit: 25 },

  { recipe_id: 'recipe-04', canonical_product_id: 'prod-03', quantity_in_base_unit: 700 },
  { recipe_id: 'recipe-04', canonical_product_id: 'prod-08', quantity_in_base_unit: 500 },
  { recipe_id: 'recipe-04', canonical_product_id: 'prod-04', quantity_in_base_unit: 5 },
  { recipe_id: 'recipe-04', canonical_product_id: 'prod-14', quantity_in_base_unit: 150 },
  { recipe_id: 'recipe-04', canonical_product_id: 'prod-10', quantity_in_base_unit: 25 }
];

// Gera os cupons e recibos históricos para NE SUPERMERCADO e MERCADO SOUZA
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

export const MOCK_RECEIPTS: MockReceipt[] = [
  {
    id: 'rec-01',
    store_id: 'store-ne-supermercado',
    store_name: CANONICAL_STORE_NE,
    purchase_date: daysAgo(58),
    total_amount: 322.45,
    discount_amount: 0,
    payment_method: 'PIX',
    access_key: '35260975315333000109650010000010011000010011',
    open_finance_tx_id: null,
    reconciled: true
  },
  {
    id: 'rec-02',
    store_id: 'store-mercado-souza',
    store_name: CANONICAL_STORE_SOUZA,
    purchase_date: daysAgo(52),
    total_amount: 318.9,
    discount_amount: 0,
    payment_method: 'VR_VA',
    access_key: '35260906057223000171650010000010021000010022',
    open_finance_tx_id: null,
    reconciled: true
  },
  {
    id: 'rec-04',
    store_id: 'store-ne-supermercado',
    store_name: CANONICAL_STORE_NE,
    purchase_date: daysAgo(27),
    total_amount: 326.1,
    discount_amount: 0,
    payment_method: 'VR_VA',
    access_key: '35261075315333000109650010000020011000020011',
    open_finance_tx_id: 'pluggy-tx-atacadao-04',
    reconciled: true
  },
  {
    id: 'rec-05',
    store_id: 'store-mercado-souza',
    store_name: CANONICAL_STORE_SOUZA,
    purchase_date: daysAgo(23),
    total_amount: 324.4,
    discount_amount: 0,
    payment_method: 'PIX',
    access_key: '35261006057223000171650010000020021000020022',
    open_finance_tx_id: null,
    reconciled: true
  },
  {
    id: 'rec-07',
    store_id: 'store-mercado-souza',
    store_name: CANONICAL_STORE_SOUZA,
    purchase_date: daysAgo(12),
    total_amount: 320.15,
    discount_amount: 0,
    payment_method: 'VR_VA',
    access_key: '35261106057223000171650010000030021000030022',
    open_finance_tx_id: 'pluggy-tx-assai-02',
    reconciled: true
  },
  {
    id: 'rec-09',
    store_id: 'store-ne-supermercado',
    store_name: CANONICAL_STORE_NE,
    purchase_date: daysAgo(5),
    total_amount: 319.85,
    discount_amount: 0,
    payment_method: 'PIX',
    access_key: '35261175315333000109650010000030011000030011',
    open_finance_tx_id: 'pluggy-tx-atacadao-01',
    reconciled: true
  }
];

// Itens dos cupons
export const MOCK_RECEIPT_ITEMS: MockReceiptItem[] = [];
let itemIdCounter = 1;

for (const rec of MOCK_RECEIPTS) {
  const storeKey: 'neSupermercado' | 'mercadoSouza' =
    rec.store_id === 'store-ne-supermercado' ? 'neSupermercado' : 'mercadoSouza';

  const periodIdx: 0 | 1 | 2 =
    rec.id === 'rec-01' || rec.id === 'rec-02'
      ? 0
      : rec.id === 'rec-04' || rec.id === 'rec-05'
        ? 1
        : 2;

  for (const prod of MOCK_PRODUCTS) {
    const pkgPrice = prod.prices[storeKey][periodIdx];
    const effectiveSize = periodIdx === 2 ? prod.seen_package_size : prod.standard_package_size;
    const normalizedPrice = pkgPrice / effectiveSize;

    MOCK_RECEIPT_ITEMS.push({
      id: `item-${itemIdCounter++}`,
      receipt_id: rec.id,
      canonical_product_id: prod.id,
      raw_description: prod.raw_alias,
      quantity: 1,
      unit_type: prod.unit_type,
      unit_price: pkgPrice,
      total_price: pkgPrice,
      normalized_price_per_base_unit: Number(normalizedPrice.toFixed(6))
    });
  }
}

// Observações históricas de flyers e fotos de gôndola dos meses -5, -4 e -3 para completar janela de 6 meses
export const MOCK_COLLECTED_PRICES: MockCollectedPrice[] = [];
const earlierMonthConfigs: Array<{
  daysBack: number;
  souzaMultipliers: [number, number];
  neMultipliers: [number, number];
  sourceType: 'MARKET_FLYER' | 'SHELF_PHOTO';
}> = [
  // Mês -5 (~Junho): Mercado Souza fez feirão de carnes/hortifruti mais barato que o NE
  { daysBack: 155, souzaMultipliers: [0.91, 0.95], neMultipliers: [1.05, 1.09], sourceType: 'MARKET_FLYER' },
  // Mês -4 (~Julho): Alta sazonal de entressafra nos dois mercados, NE levemente mais competitivo
  { daysBack: 124, souzaMultipliers: [1.06, 1.11], neMultipliers: [1.02, 1.06], sourceType: 'SHELF_PHOTO' },
  // Mês -3 (~Agosto): Promoção de aniversário no Mercado Souza em mercearia e laticínios
  { daysBack: 93, souzaMultipliers: [0.94, 0.98], neMultipliers: [1.01, 1.04], sourceType: 'MARKET_FLYER' }
];

let collectedCounter = 1;
for (let mIdx = 0; mIdx < earlierMonthConfigs.length; mIdx++) {
  const cfg = earlierMonthConfigs[mIdx];
  const observedIso = daysAgo(cfg.daysBack);

  MOCK_PRODUCTS.forEach((prod, pIdx) => {
    if (prod.has_price_observations === false || prod.category === 'Combustível') return;

    const souzaFactor =
      pIdx % 2 === 0 ? cfg.souzaMultipliers[0] : cfg.souzaMultipliers[1];
    const neFactor =
      pIdx % 2 === 0 ? cfg.neMultipliers[1] : cfg.neMultipliers[0];

    const souzaPkg = Number((prod.prices.mercadoSouza[0] * souzaFactor).toFixed(2));
    const nePkg = Number((prod.prices.neSupermercado[0] * neFactor).toFixed(2));
    const stdSize = Math.max(1, prod.standard_package_size);

    MOCK_COLLECTED_PRICES.push(
      {
        id: `col-${collectedCounter++}`,
        canonical_product_id: prod.id,
        store_id: 'store-mercado-souza',
        store_name: CANONICAL_STORE_SOUZA,
        collected_at: observedIso,
        normalized_price_per_base_unit: Number((souzaPkg / stdSize).toFixed(6)),
        package_price: souzaPkg,
        source_type: cfg.sourceType
      },
      {
        id: `col-${collectedCounter++}`,
        canonical_product_id: prod.id,
        store_id: 'store-ne-supermercado',
        store_name: CANONICAL_STORE_NE,
        collected_at: observedIso,
        normalized_price_per_base_unit: Number((nePkg / stdSize).toFixed(6)),
        package_price: nePkg,
        source_type: cfg.sourceType
      }
    );
  });
}

// Visão v_current_product_prices
export function getMockCurrentProductPrices() {
  const results: Array<Record<string, unknown>> = [];
  const storeMap = new Map(MOCK_STORES.map((s) => [s.id, s.trading_name]));

  for (const prod of MOCK_PRODUCTS) {
    if (prod.has_price_observations === false) continue;
    const storeKeys: Array<
      ['store-ne-supermercado' | 'store-mercado-souza', 'neSupermercado' | 'mercadoSouza']
    > = [
      ['store-ne-supermercado', 'neSupermercado'],
      ['store-mercado-souza', 'mercadoSouza']
    ];

    for (const [sId, sKey] of storeKeys) {
      const pHistory = prod.prices[sKey];
      const latestPkgPrice = pHistory[2];
      const prevPkgPrice = pHistory[1];
      const minPkgPrice = Math.min(...pHistory);
      const maxPkgPrice = Math.max(...pHistory);

      const effectiveBasePrice = latestPkgPrice / prod.seen_package_size;
      const prevBasePrice = prevPkgPrice / prod.standard_package_size;
      const estBase = 0.7 * effectiveBasePrice + 0.3 * prevBasePrice;
      const estPkg = estBase * prod.standard_package_size;

      results.push({
        canonical_product_id: prod.id,
        product_name: prod.name,
        category: prod.category,
        base_unit: prod.base_unit,
        standard_package_size: prod.standard_package_size,
        is_essential: prod.is_essential,
        store_id: sId,
        store_name: storeMap.get(sId) ?? '',
        estimated_base_price: Number(estBase.toFixed(6)),
        estimated_package_price: Number(estPkg.toFixed(2)),
        min_historical_price: Number(minPkgPrice.toFixed(2)),
        max_historical_price: Number(maxPkgPrice.toFixed(2)),
        days_since_last_seen: sKey === 'neSupermercado' ? 5 : 12,
        last_seen_at: daysAgo(sKey === 'neSupermercado' ? 5 : 12),
        observations_count: 3
      });
    }
  }

  return results;
}

// Visão v_store_category_heatmap
export function getMockStoreCategoryHeatmap() {
  const currentPrices = getMockCurrentProductPrices();
  const categories: ProductCategory[] = [
    'Carnes',
    'Laticínios',
    'Hortifruti',
    'Mercearia',
    'Limpeza',
    'Higiene',
    'Besteiras/Impulso'
  ];

  const results: Array<Record<string, unknown>> = [];

  for (const store of MOCK_STORES) {
    for (const cat of categories) {
      const storePrices = currentPrices.filter(
        (p) => p.store_id === store.id && p.category === cat
      );
      if (storePrices.length === 0) continue;

      const basketCost = storePrices.reduce(
        (sum, p) => sum + Number(p.estimated_package_price),
        0
      );

      let index = 100.0;
      if (store.trading_name === CANONICAL_STORE_NE) {
        index = cat === 'Carnes' || cat === 'Mercearia' ? 94.2 : 102.4;
      } else {
        index = cat === 'Hortifruti' || cat === 'Laticínios' || cat === 'Limpeza' ? 93.1 : 104.8;
      }

      results.push({
        store_id: store.id,
        store_name: store.trading_name,
        category: cat,
        products_tracked: storePrices.length,
        competitiveness_index: Number(index.toFixed(1)),
        basket_category_cost: Number(basketCost.toFixed(2)),
        min_days_since_seen: 5,
        max_days_since_seen: 12,
        freshness_tier: '< 15 dias'
      });
    }
  }

  return results;
}

// Visão v_personal_inflation_and_shrinkflation
export function getMockPersonalInflationAndShrinkflation() {
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const results: Array<Record<string, unknown>> = [];

  for (const prod of MOCK_PRODUCTS) {
    if (prod.category === 'Combustível' || prod.has_price_observations === false) continue;

    const isShrunk = prod.seen_package_size < prod.standard_package_size;
    const reductionPct = isShrunk
      ? ((prod.standard_package_size - prod.seen_package_size) / prod.standard_package_size) * 100
      : 0;

    const neCurrent = prod.prices.neSupermercado[2];
    const nePrev = prod.prices.neSupermercado[1];
    const momInflation = ((neCurrent - nePrev) / nePrev) * 100;

    results.push({
      canonical_product_id: prod.id,
      product_name: prod.name,
      category: prod.category,
      base_unit: prod.base_unit,
      standard_package_size: prod.standard_package_size,
      latest_seen_package_size: prod.seen_package_size,
      ref_month: currentMonthStr,
      avg_std_package_price: Number(neCurrent.toFixed(2)),
      mom_inflation_pct: Number(momInflation.toFixed(2)),
      shrinkflation_detected: isShrunk,
      package_reduction_pct: Number(reductionPct.toFixed(1))
    });
  }

  return results;
}

// Visão v_true_spending_breakdown
export function getMockTrueSpendingBreakdown() {
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return [
    {
      ref_month: currentMonthStr,
      wallet_source: 'VR_VA',
      payment_method: 'VR_VA',
      category: 'Alimentação Essencial',
      is_essential: true,
      spending_pillar: 'Alimentação Essencial',
      receipts_count: 3,
      reconciled_receipts_count: 3,
      total_spent: 644.55
    },
    {
      ref_month: currentMonthStr,
      wallet_source: 'BANK_ACCOUNT',
      payment_method: 'PIX',
      category: 'Alimentação Essencial',
      is_essential: true,
      spending_pillar: 'Alimentação Essencial',
      receipts_count: 3,
      reconciled_receipts_count: 2,
      total_spent: 498.3
    },
    {
      ref_month: currentMonthStr,
      wallet_source: 'BANK_ACCOUNT',
      payment_method: 'CREDIT_CARD',
      category: 'Besteiras/Impulso',
      is_essential: false,
      spending_pillar: 'Besteiras/Impulso',
      receipts_count: 2,
      reconciled_receipts_count: 1,
      total_spent: 185.9
    },
    {
      ref_month: currentMonthStr,
      wallet_source: 'BANK_ACCOUNT',
      payment_method: 'CREDIT_CARD',
      category: 'Limpeza & Higiene',
      is_essential: true,
      spending_pillar: 'Limpeza & Higiene',
      receipts_count: 2,
      reconciled_receipts_count: 2,
      total_spent: 142.4
    }
  ];
}

// Série temporal de evolução dos 6 produtos chave
export function getMockPriceEvolutionSeries() {
  const months = ['2026-09', '2026-10', '2026-11'];
  const targets = [
    { name: 'Peito de Frango Sem Osso (1kg)', prices: [20.9, 19.9, 18.49] },
    { name: 'Patinho Bovino Moído (1kg)', prices: [38.9, 39.5, 37.9] },
    { name: 'Arroz Agulhinha Tipo 1 (5kg)', prices: [27.9, 26.5, 24.9] },
    { name: 'Azeite de Oliva Extra Virgem (500ml)', prices: [41.9, 43.9, 45.9] },
    { name: 'Café Torrado e Moído Tradicional (500g)', prices: [17.9, 19.5, 21.49] },
    { name: 'Leite Integral UHT (1L)', prices: [5.29, 4.99, 4.69] }
  ];

  const rows: Array<{ month_label: string; product_name: string; avg_package_price: number }> = [];

  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    for (const t of targets) {
      rows.push({
        month_label: m,
        product_name: t.name,
        avg_package_price: t.prices[i]
      });
    }
  }

  return rows;
}
