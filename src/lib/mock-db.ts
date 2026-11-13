import type { BaseUnit, PaymentMethod, ProductCategory, ReceiptUnitType } from '../types/argus';

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
  prices: {
    atacadao: [number, number, number];
    assai: [number, number, number];
    paoDeAcucar: [number, number, number];
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

// 3 Mercados Modelo em SP
export const MOCK_STORES: MockStore[] = [
  {
    id: 'store-atacadao-1',
    cnpj: '75.315.333/0001-09',
    raw_name: 'ATACADAO S.A. - LOJA CAMBUCI',
    trading_name: 'Atacadão Cambuci',
    address: 'Av. do Estado, 4950 - Cambuci, São Paulo - SP',
    latitude: -23.55682,
    longitude: -46.61845,
    created_at: new Date(Date.now() - 90 * 86400000).toISOString()
  },
  {
    id: 'store-assai-2',
    cnpj: '06.057.223/0001-71',
    raw_name: 'SENDAS DISTRIBUIDORA S/A - ASSAI',
    trading_name: 'Assaí Atacadista Paulista',
    address: 'Rua da Consolação, 2300 - Consolação, São Paulo - SP',
    latitude: -23.55312,
    longitude: -46.66015,
    created_at: new Date(Date.now() - 90 * 86400000).toISOString()
  },
  {
    id: 'store-pao-3',
    cnpj: '47.508.411/0001-56',
    raw_name: 'CIA BRASILEIRA DE DISTRIBUICAO - PAO DE ACUCAR',
    trading_name: 'Pão de Açúcar Jardins',
    address: 'Rua Pamplona, 1704 - Jardim Paulista, São Paulo - SP',
    latitude: -23.56985,
    longitude: -46.65892,
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
      atacadao: [20.9, 19.9, 18.49],
      assai: [21.5, 20.8, 19.8],
      paoDeAcucar: [26.9, 27.5, 27.9]
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
      atacadao: [38.9, 39.5, 37.9],
      assai: [37.9, 38.2, 36.8],
      paoDeAcucar: [46.9, 48.0, 48.9]
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
      atacadao: [29.9, 30.9, 31.5],
      assai: [28.9, 29.5, 29.2],
      paoDeAcucar: [36.9, 37.9, 38.5]
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
      atacadao: [19.9, 18.9, 17.9],
      assai: [20.5, 19.5, 18.5],
      paoDeAcucar: [26.9, 25.9, 25.5]
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
      atacadao: [5.49, 5.19, 4.79],
      assai: [5.59, 5.29, 4.99],
      paoDeAcucar: [6.79, 6.89, 6.49]
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
      atacadao: [3.69, 3.79, 3.49],
      assai: [3.59, 3.69, 3.39],
      paoDeAcucar: [4.89, 4.99, 4.79]
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
      atacadao: [11.9, 12.5, 12.9],
      assai: [11.5, 11.9, 12.2],
      paoDeAcucar: [14.9, 15.5, 15.9]
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
      atacadao: [27.9, 26.5, 24.9],
      assai: [28.5, 27.9, 26.9],
      paoDeAcucar: [33.9, 34.5, 32.9]
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
      atacadao: [7.99, 7.69, 7.29],
      assai: [7.89, 7.59, 7.19],
      paoDeAcucar: [9.99, 9.79, 9.49]
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
      atacadao: [39.9, 42.9, 44.9],
      assai: [38.9, 41.9, 43.9],
      paoDeAcucar: [46.9, 49.9, 52.9]
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
      atacadao: [17.9, 19.5, 21.9],
      assai: [18.2, 19.8, 21.5],
      paoDeAcucar: [21.9, 23.9, 25.9]
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
      atacadao: [10.9, 11.2, 10.49],
      assai: [10.5, 10.9, 10.29],
      paoDeAcucar: [13.9, 14.2, 13.8]
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
      atacadao: [6.99, 6.49, 5.99],
      assai: [6.49, 5.99, 5.49],
      paoDeAcucar: [5.99, 5.49, 4.99]
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
      atacadao: [5.99, 5.49, 5.29],
      assai: [5.79, 5.29, 4.99],
      paoDeAcucar: [5.49, 4.99, 4.69]
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
      atacadao: [7.9, 7.8, 7.49],
      assai: [7.5, 7.4, 7.19],
      paoDeAcucar: [8.9, 8.9, 8.59]
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
      atacadao: [14.9, 14.9, 15.49],
      assai: [13.9, 13.9, 14.29],
      paoDeAcucar: [17.9, 18.5, 18.9]
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
      atacadao: [21.9, 22.5, 22.9],
      assai: [19.9, 20.5, 20.9],
      paoDeAcucar: [25.9, 26.9, 27.5]
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
      atacadao: [6.49, 6.79, 6.99],
      assai: [6.29, 6.59, 6.89],
      paoDeAcucar: [7.99, 8.49, 8.99]
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
      atacadao: [37.9, 36.9, 35.9],
      assai: [36.9, 35.9, 34.9],
      paoDeAcucar: [41.9, 40.9, 39.9]
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
      atacadao: [5.79, 5.85, 5.89],
      assai: [5.79, 5.85, 5.89],
      paoDeAcucar: [5.89, 5.95, 5.99]
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
  { recipe_id: 'recipe-02', canonical_product_id: 'prod-14', quantity_in_base_unit: 100 }
];

// Gera os cupons e recibos simulados
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

export const MOCK_RECEIPTS: MockReceipt[] = [
  {
    id: 'rec-01',
    store_id: 'store-atacadao-1',
    store_name: 'Atacadão Cambuci',
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
    store_id: 'store-assai-2',
    store_name: 'Assaí Atacadista Paulista',
    purchase_date: daysAgo(52),
    total_amount: 318.9,
    discount_amount: 0,
    payment_method: 'VR_VA',
    access_key: '35260906057223000171650010000010021000010022',
    open_finance_tx_id: null,
    reconciled: true
  },
  {
    id: 'rec-03',
    store_id: 'store-pao-3',
    store_name: 'Pão de Açúcar Jardins',
    purchase_date: daysAgo(46),
    total_amount: 395.7,
    discount_amount: 0,
    payment_method: 'CREDIT_CARD',
    access_key: '35260947508411000156650010000010031000010033',
    open_finance_tx_id: null,
    reconciled: true
  },
  {
    id: 'rec-04',
    store_id: 'store-atacadao-1',
    store_name: 'Atacadão Cambuci',
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
    store_id: 'store-assai-2',
    store_name: 'Assaí Atacadista Paulista',
    purchase_date: daysAgo(23),
    total_amount: 324.4,
    discount_amount: 0,
    payment_method: 'PIX',
    access_key: '35261006057223000171650010000020021000020022',
    open_finance_tx_id: null,
    reconciled: true
  },
  {
    id: 'rec-06',
    store_id: 'store-pao-3',
    store_name: 'Pão de Açúcar Jardins',
    purchase_date: daysAgo(18),
    total_amount: 405.3,
    discount_amount: 0,
    payment_method: 'CREDIT_CARD',
    access_key: '35261047508411000156650010000020031000020033',
    open_finance_tx_id: 'pluggy-tx-paoacucar-03',
    reconciled: true
  },
  {
    id: 'rec-07',
    store_id: 'store-assai-2',
    store_name: 'Assaí Atacadista Paulista',
    purchase_date: daysAgo(12),
    total_amount: 320.15,
    discount_amount: 0,
    payment_method: 'VR_VA',
    access_key: '35261106057223000171650010000030021000030022',
    open_finance_tx_id: 'pluggy-tx-assai-02',
    reconciled: true
  },
  {
    id: 'rec-08',
    store_id: 'store-pao-3',
    store_name: 'Pão de Açúcar Jardins',
    purchase_date: daysAgo(8),
    total_amount: 412.8,
    discount_amount: 0,
    payment_method: 'CREDIT_CARD',
    access_key: '35261147508411000156650010000030031000030033',
    open_finance_tx_id: null,
    reconciled: false
  },
  {
    id: 'rec-09',
    store_id: 'store-atacadao-1',
    store_name: 'Atacadão Cambuci',
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
  const storeKey: 'atacadao' | 'assai' | 'paoDeAcucar' =
    rec.store_id === 'store-atacadao-1'
      ? 'atacadao'
      : rec.store_id === 'store-assai-2'
        ? 'assai'
        : 'paoDeAcucar';

  const periodIdx: 0 | 1 | 2 =
    rec.id === 'rec-01' || rec.id === 'rec-02' || rec.id === 'rec-03'
      ? 0
      : rec.id === 'rec-04' || rec.id === 'rec-05' || rec.id === 'rec-06'
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

// Visão v_current_product_prices
export function getMockCurrentProductPrices() {
  const results: Array<Record<string, unknown>> = [];
  const storeMap = new Map(MOCK_STORES.map((s) => [s.id, s.trading_name]));

  for (const prod of MOCK_PRODUCTS) {
    const storeKeys: Array<['store-atacadao-1' | 'store-assai-2' | 'store-pao-3', 'atacadao' | 'assai' | 'paoDeAcucar']> = [
      ['store-atacadao-1', 'atacadao'],
      ['store-assai-2', 'assai'],
      ['store-pao-3', 'paoDeAcucar']
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
        days_since_last_seen: sKey === 'atacadao' ? 5 : sKey === 'assai' ? 12 : 8,
        last_seen_at: daysAgo(sKey === 'atacadao' ? 5 : sKey === 'assai' ? 12 : 8),
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

      // Competitividade: Atacadão e Assaí são tipicamente mais baratos em Mercearia e Carnes; Pão de Açúcar em Hortifruti
      let index = 100.0;
      if (store.trading_name.includes('Atacadão')) {
        index = cat === 'Carnes' || cat === 'Mercearia' ? 92.4 : 98.1;
      } else if (store.trading_name.includes('Assaí')) {
        index = cat === 'Laticínios' || cat === 'Limpeza' ? 93.8 : 96.5;
      } else {
        index = cat === 'Hortifruti' ? 94.2 : 118.5;
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
    if (prod.category === 'Combustível') continue;

    const isShrunk = prod.seen_package_size < prod.standard_package_size;
    const reductionPct = isShrunk
      ? ((prod.standard_package_size - prod.seen_package_size) / prod.standard_package_size) * 100
      : 0;

    const atacadaoCurrent = prod.prices.atacadao[2];
    const atacadaoPrev = prod.prices.atacadao[1];
    const momInflation = ((atacadaoCurrent - atacadaoPrev) / atacadaoPrev) * 100;

    results.push({
      canonical_product_id: prod.id,
      product_name: prod.name,
      category: prod.category,
      base_unit: prod.base_unit,
      standard_package_size: prod.standard_package_size,
      latest_seen_package_size: prod.seen_package_size,
      ref_month: currentMonthStr,
      avg_std_package_price: Number(atacadaoCurrent.toFixed(2)),
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
    { name: 'Azeite de Oliva Extra Virgem (500ml)', prices: [39.9, 42.9, 44.9] },
    { name: 'Café Torrado e Moído Tradicional (500g)', prices: [17.9, 19.5, 21.9] },
    { name: 'Leite Integral UHT (1L)', prices: [5.49, 5.19, 4.79] }
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
