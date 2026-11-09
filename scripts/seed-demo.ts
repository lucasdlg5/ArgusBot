import path from 'node:path';
import dotenv from 'dotenv';
import { withArgusTransaction } from '../src/lib/db';
import type { BaseUnit, PaymentMethod, ProductCategory, ReceiptUnitType } from '../src/types/argus';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface SeedStore {
  cnpj: string;
  rawName: string;
  tradingName: string;
  address: string;
  lat: number;
  lng: number;
}

interface SeedProduct {
  name: string;
  category: ProductCategory;
  baseUnit: BaseUnit;
  standardPackageSize: number;
  isEssential: boolean;
  rawAlias: string;
  seenPackageSize: number; // se menor que standardPackageSize, aciona detector de Reduflação
  unitType: ReceiptUnitType;
  pricesByStore: {
    atacadao: [number, number, number]; // [2 meses atrás, 1 mês atrás, atual]
    assai: [number, number, number];
    paoDeAcucar: [number, number, number];
  };
}

const STORES: SeedStore[] = [
  {
    cnpj: '75.315.333/0001-09',
    rawName: 'ATACADAO S.A. - LOJA CAMBUCI',
    tradingName: 'Atacadão Cambuci',
    address: 'Av. do Estado, 4950 - Cambuci, São Paulo - SP',
    lat: -23.55682,
    lng: -46.61845
  },
  {
    cnpj: '06.057.223/0001-71',
    rawName: 'SENDAS DISTRIBUIDORA S/A - ASSAI',
    tradingName: 'Assaí Atacadista Paulista',
    address: 'Rua da Consolação, 2300 - Consolação, São Paulo - SP',
    lat: -23.55312,
    lng: -46.66015
  },
  {
    cnpj: '47.508.411/0001-56',
    rawName: 'CIA BRASILEIRA DE DISTRIBUICAO - PAO DE ACUCAR',
    tradingName: 'Pão de Açúcar Jardins',
    address: 'Rua Pamplona, 1704 - Jardim Paulista, São Paulo - SP',
    lat: -23.56985,
    lng: -46.65892
  }
];

const PRODUCTS: SeedProduct[] = [
  // 1-4: Carnes
  {
    name: 'Peito de Frango Sem Osso (1kg)',
    category: 'Carnes',
    baseUnit: 'g',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'FILE PEITO FRANGO SADIA 1KG',
    seenPackageSize: 1000,
    unitType: 'KG',
    pricesByStore: {
      atacadao: [20.9, 19.9, 18.49], // Mínima histórica no Atacadão!
      assai: [21.5, 20.8, 19.8],
      paoDeAcucar: [26.9, 27.5, 27.9]
    }
  },
  {
    name: 'Patinho Bovino Moído (1kg)',
    category: 'Carnes',
    baseUnit: 'g',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'CARNE BOV PATINHO MOIDO KG',
    seenPackageSize: 1000,
    unitType: 'KG',
    pricesByStore: {
      atacadao: [38.9, 39.5, 37.9],
      assai: [37.9, 38.2, 36.8], // Mínima histórica no Assaí
      paoDeAcucar: [46.9, 48.0, 48.9]
    }
  },
  {
    name: 'Acém Bovino em Cubos (1kg)',
    category: 'Carnes',
    baseUnit: 'g',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'CARNE BOV ACEM CUBOS KG',
    seenPackageSize: 1000,
    unitType: 'KG',
    pricesByStore: {
      atacadao: [29.9, 30.9, 31.5],
      assai: [28.9, 29.5, 29.2],
      paoDeAcucar: [36.9, 37.9, 38.5]
    }
  },
  {
    name: 'Ovos Brancos Grandes (Cartela 30 un)',
    category: 'Carnes',
    baseUnit: 'un',
    standardPackageSize: 30,
    isEssential: true,
    rawAlias: 'OVOS BRANCOS EXTRA C/30 UN',
    seenPackageSize: 30,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [19.9, 18.9, 17.9],
      assai: [20.5, 19.5, 18.5],
      paoDeAcucar: [26.9, 25.9, 25.5]
    }
  },

  // 5-7: Laticínios
  {
    name: 'Leite Integral UHT (1L)',
    category: 'Laticínios',
    baseUnit: 'ml',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'LEITE UHT INTEGRAL ITALAC 1L',
    seenPackageSize: 1000,
    unitType: 'LT',
    pricesByStore: {
      atacadao: [5.49, 5.19, 4.79], // Oportunidade de estocar
      assai: [5.59, 5.29, 4.99],
      paoDeAcucar: [6.79, 6.89, 6.49]
    }
  },
  {
    name: 'Creme de Leite UHT (200g)',
    category: 'Laticínios',
    baseUnit: 'g',
    standardPackageSize: 200,
    isEssential: true,
    rawAlias: 'CREME DE LEITE NESTLE TP 200G',
    seenPackageSize: 200,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [3.69, 3.79, 3.49],
      assai: [3.59, 3.69, 3.39],
      paoDeAcucar: [4.89, 4.99, 4.79]
    }
  },
  {
    name: 'Manteiga Extra Sem Sal (200g)',
    category: 'Laticínios',
    baseUnit: 'g',
    standardPackageSize: 200,
    isEssential: true,
    rawAlias: 'MANTEIGA AVIACAO TABLETE 200G',
    seenPackageSize: 200,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [11.9, 12.5, 12.9],
      assai: [11.5, 11.9, 12.2],
      paoDeAcucar: [14.9, 15.5, 15.9]
    }
  },

  // 8-12: Mercearia
  {
    name: 'Arroz Agulhinha Tipo 1 (5kg)',
    category: 'Mercearia',
    baseUnit: 'g',
    standardPackageSize: 5000,
    isEssential: true,
    rawAlias: 'ARROZ T1 CAMIL PCT 5KG',
    seenPackageSize: 5000,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [27.9, 26.5, 24.9], // Mínima histórica no Atacadão
      assai: [28.5, 27.9, 26.9],
      paoDeAcucar: [33.9, 34.5, 32.9]
    }
  },
  {
    name: 'Feijão Carioca Tipo 1 (1kg)',
    category: 'Mercearia',
    baseUnit: 'g',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'FEIJAO CARIOCA CAMIL 1KG',
    seenPackageSize: 1000,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [7.99, 7.69, 7.29],
      assai: [7.89, 7.59, 7.19],
      paoDeAcucar: [9.99, 9.79, 9.49]
    }
  },
  {
    name: 'Azeite de Oliva Extra Virgem (500ml)',
    category: 'Mercearia',
    baseUnit: 'ml',
    standardPackageSize: 500,
    isEssential: true,
    rawAlias: 'AZEITE PORTUGUES GALLO VD 500ML',
    seenPackageSize: 500,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [39.9, 42.9, 44.9], // Alta abrupta de inflação
      assai: [38.9, 41.9, 43.9],
      paoDeAcucar: [46.9, 49.9, 52.9]
    }
  },
  {
    name: 'Café Torrado e Moído Tradicional (500g)',
    category: 'Mercearia',
    baseUnit: 'g',
    standardPackageSize: 500,
    isEssential: true,
    rawAlias: 'CAFE PILAO TRADICIONAL VACUO 500G',
    seenPackageSize: 500,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [17.9, 19.5, 21.9], // Alta de inflação
      assai: [18.2, 19.8, 21.5],
      paoDeAcucar: [21.9, 23.9, 25.9]
    }
  },
  {
    name: 'Catchup Tradicional (400g)',
    category: 'Mercearia',
    baseUnit: 'g',
    standardPackageSize: 400,
    isEssential: true,
    rawAlias: 'CATCHUP HEINZ TRAD 397G',
    seenPackageSize: 397,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [10.9, 11.2, 10.49],
      assai: [10.5, 10.9, 10.29],
      paoDeAcucar: [13.9, 14.2, 13.8]
    }
  },

  // 13-15: Hortifruti (Pão de Açúcar e Assaí competitivos)
  {
    name: 'Batata Monalisa Lavada (1kg)',
    category: 'Hortifruti',
    baseUnit: 'g',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'BATATA MONALISA EXTRA KG',
    seenPackageSize: 1000,
    unitType: 'KG',
    pricesByStore: {
      atacadao: [6.99, 6.49, 5.99],
      assai: [6.49, 5.99, 5.49],
      paoDeAcucar: [5.99, 5.49, 4.99] // Pão de Açúcar ganha em feira fresca
    }
  },
  {
    name: 'Cebola Nacional (1kg)',
    category: 'Hortifruti',
    baseUnit: 'g',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'CEBOLA NACIONAL GRANEL KG',
    seenPackageSize: 1000,
    unitType: 'KG',
    pricesByStore: {
      atacadao: [5.99, 5.49, 5.29],
      assai: [5.79, 5.29, 4.99],
      paoDeAcucar: [5.49, 4.99, 4.69]
    }
  },
  {
    name: 'Champignon Fatiado em Conserva (100g)',
    category: 'Hortifruti',
    baseUnit: 'g',
    standardPackageSize: 100,
    isEssential: true,
    rawAlias: 'COGUMELO CHAMPIGNON HEMMER 100G',
    seenPackageSize: 100,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [7.9, 7.8, 7.49],
      assai: [7.5, 7.4, 7.19],
      paoDeAcucar: [8.9, 8.9, 8.59]
    }
  },

  // 16-17: Limpeza & Higiene (Com Casos Reais de Reduflação!)
  {
    name: 'Lava-Roupas em Pó Omo (Caixa 800g -> Reduflação 720g)',
    category: 'Limpeza',
    baseUnit: 'g',
    standardPackageSize: 800,
    isEssential: true,
    rawAlias: 'SABAO PO OMO LAVAGEM PERFEITA 720G',
    seenPackageSize: 720, // Reduziu 10% a embalagem mantendo preço nominal!
    unitType: 'UN',
    pricesByStore: {
      atacadao: [14.9, 14.9, 15.49],
      assai: [13.9, 13.9, 14.29],
      paoDeAcucar: [17.9, 18.5, 18.9]
    }
  },
  {
    name: 'Papel Higiênico Folha Dupla Neve (Leve 12 Pague 11 - 30m -> Reduflação 20m)',
    category: 'Higiene',
    baseUnit: 'un',
    standardPackageSize: 12,
    isEssential: true,
    rawAlias: 'PAPEL HIG NEVE FD COMPACTO 12X20M',
    seenPackageSize: 10, // Equivalente reduzido na metragem por rolo
    unitType: 'UN',
    pricesByStore: {
      atacadao: [21.9, 22.5, 22.9],
      assai: [19.9, 20.5, 20.9],
      paoDeAcucar: [25.9, 26.9, 27.5]
    }
  },

  // 18-19: Besteiras/Impulso (`is_essential = false` + Reduflação de Barra de Chocolate)
  {
    name: 'Barra de Chocolate Ao Leite Lacta (90g -> Reduflação 80g)',
    category: 'Besteiras/Impulso',
    baseUnit: 'g',
    standardPackageSize: 90,
    isEssential: false,
    rawAlias: 'CHOC BARRA LACTA AO LEITE 80G',
    seenPackageSize: 80, // Clássica reduflação 90g -> 80g
    unitType: 'UN',
    pricesByStore: {
      atacadao: [6.49, 6.79, 6.99],
      assai: [6.29, 6.59, 6.89],
      paoDeAcucar: [7.99, 8.49, 8.99]
    }
  },
  {
    name: 'Pack Cerveja Puro Malte Long Neck (6x330ml)',
    category: 'Besteiras/Impulso',
    baseUnit: 'ml',
    standardPackageSize: 1980,
    isEssential: false,
    rawAlias: 'CERVEJA HEINEKEN LN PACK 6X330ML',
    seenPackageSize: 1980,
    unitType: 'UN',
    pricesByStore: {
      atacadao: [37.9, 36.9, 35.9],
      assai: [36.9, 35.9, 34.9],
      paoDeAcucar: [41.9, 40.9, 39.9]
    }
  },

  // 20: Combustível (Usado pelo ArgusOptimizerService para calcular o custo de Gasolina!)
  {
    name: 'Gasolina Comum Aditivada (1 Litro)',
    category: 'Combustível',
    baseUnit: 'ml',
    standardPackageSize: 1000,
    isEssential: true,
    rawAlias: 'GASOLINA COMUM BOMBA LT',
    seenPackageSize: 1000,
    unitType: 'LT',
    pricesByStore: {
      atacadao: [5.79, 5.85, 5.89],
      assai: [5.79, 5.85, 5.89],
      paoDeAcucar: [5.89, 5.95, 5.99]
    }
  }
];

async function main() {
  console.log('======================================================================');
  console.log('🌱 ARGUS (moneta-argus) - Populando Seed Realista de Demonstração');
  console.log('======================================================================');

  await withArgusTransaction(async (client) => {
    // Limpa registros anteriores do schema argus para seed idempotente
    await client.query(`DELETE FROM argus.recipe_ingredients`);
    await client.query(`DELETE FROM argus.recipes`);
    await client.query(`DELETE FROM argus.receipt_items`);
    await client.query(`DELETE FROM argus.receipts`);
    await client.query(`DELETE FROM argus.product_aliases`);
    await client.query(`DELETE FROM argus.canonical_products`);
    await client.query(`DELETE FROM argus.stores`);

    // 1. Insere 3 Mercados Locais
    const storeIds: Record<'atacadao' | 'assai' | 'paoDeAcucar', string> = {
      atacadao: '',
      assai: '',
      paoDeAcucar: ''
    };
    const keys: Array<'atacadao' | 'assai' | 'paoDeAcucar'> = ['atacadao', 'assai', 'paoDeAcucar'];

    for (let i = 0; i < STORES.length; i++) {
      const st = STORES[i];
      const res = await client.query<{ id: string }>(
        `INSERT INTO argus.stores (cnpj, raw_name, trading_name, address, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [st.cnpj, st.rawName, st.tradingName, st.address, st.lat, st.lng]
      );
      storeIds[keys[i]] = res.rows[0].id;
    }
    console.log(' ✅ 3 Mercados locais cadastrados (Atacadão, Assaí, Pão de Açúcar).');

    // 2. Insere 20 Produtos Canônicos e seus Aliases
    const productIdsByName = new Map<string, string>();

    for (const prod of PRODUCTS) {
      const pRes = await client.query<{ id: string }>(
        `INSERT INTO argus.canonical_products (name, category, base_unit, standard_package_size, is_essential)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [prod.name, prod.category, prod.baseUnit, prod.standardPackageSize, prod.isEssential]
      );
      const pid = pRes.rows[0].id;
      productIdsByName.set(prod.name, pid);

      await client.query(
        `INSERT INTO argus.product_aliases (raw_description, ean, canonical_product_id, package_multiplier, last_seen_package_size)
         VALUES ($1, $2, $3, 1, $4)`,
        [
          prod.rawAlias,
          `7891000${String(productIdsByName.size).padStart(6, '0')}`,
          pid,
          prod.seenPackageSize
        ]
      );
    }
    console.log(' ✅ 20 Produtos Canônicos e Aliases (com casos de Reduflação) criados.');

    // 3. Gera 2 meses de histórico de Cupons Fiscais nos 3 mercados
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

    const receiptConfigs: Array<{
      storeKey: 'atacadao' | 'assai' | 'paoDeAcucar';
      periodIdx: 0 | 1 | 2; // 0 = 2 meses atrás, 1 = 1 mês atrás, 2 = mês atual
      daysOffset: number;
      paymentMethod: PaymentMethod;
      accessKey: string;
      openFinanceTxId: string | null;
      reconciled: boolean;
    }> = [
      // Mês -2 (Setembro)
      {
        storeKey: 'atacadao',
        periodIdx: 0,
        daysOffset: 58,
        paymentMethod: 'PIX',
        accessKey: '35260975315333000109650010000010011000010011',
        openFinanceTxId: null,
        reconciled: true
      },
      {
        storeKey: 'assai',
        periodIdx: 0,
        daysOffset: 52,
        paymentMethod: 'VR_VA',
        accessKey: '35260906057223000171650010000010021000010022',
        openFinanceTxId: null,
        reconciled: true
      },
      {
        storeKey: 'paoDeAcucar',
        periodIdx: 0,
        daysOffset: 46,
        paymentMethod: 'CREDIT_CARD',
        accessKey: '35260947508411000156650010000010031000010033',
        openFinanceTxId: null,
        reconciled: true
      },
      // Mês -1 (Outubro)
      {
        storeKey: 'atacadao',
        periodIdx: 1,
        daysOffset: 27,
        paymentMethod: 'VR_VA',
        accessKey: '35261075315333000109650010000020011000020011',
        openFinanceTxId: 'pluggy-tx-atacadao-04',
        reconciled: true
      },
      {
        storeKey: 'assai',
        periodIdx: 1,
        daysOffset: 23,
        paymentMethod: 'PIX',
        accessKey: '35261006057223000171650010000020021000020022',
        openFinanceTxId: null,
        reconciled: true
      },
      {
        storeKey: 'paoDeAcucar',
        periodIdx: 1,
        daysOffset: 18,
        paymentMethod: 'CREDIT_CARD',
        accessKey: '35261047508411000156650010000020031000020033',
        openFinanceTxId: 'pluggy-tx-paoacucar-03',
        reconciled: true
      },
      // Mês Atual (Novembro)
      {
        storeKey: 'assai',
        periodIdx: 2,
        daysOffset: 12,
        paymentMethod: 'VR_VA',
        accessKey: '35261106057223000171650010000030021000030022',
        openFinanceTxId: 'pluggy-tx-assai-02',
        reconciled: true
      },
      {
        storeKey: 'paoDeAcucar',
        periodIdx: 2,
        daysOffset: 8,
        paymentMethod: 'CREDIT_CARD',
        accessKey: '35261147508411000156650010000030031000030033',
        openFinanceTxId: null,
        reconciled: false
      },
      {
        storeKey: 'atacadao',
        periodIdx: 2,
        daysOffset: 5,
        paymentMethod: 'PIX',
        accessKey: '35261175315333000109650010000030011000030011',
        openFinanceTxId: 'pluggy-tx-atacadao-01',
        reconciled: true
      }
    ];

    for (const rc of receiptConfigs) {
      const storeId = storeIds[rc.storeKey];
      let receiptTotal = 0;

      // Calcula soma dos produtos para o cabeçalho
      for (const prod of PRODUCTS) {
        const pkgPrice = prod.pricesByStore[rc.storeKey][rc.periodIdx];
        receiptTotal += pkgPrice;
      }

      const rRes = await client.query<{ id: string }>(
        `INSERT INTO argus.receipts (
           store_id, purchase_date, total_amount, discount_amount, payment_method, access_key, open_finance_tx_id, reconciled
         ) VALUES ($1, $2, $3, 0, $4, $5, $6, $7)
         RETURNING id`,
        [
          storeId,
          daysAgo(rc.daysOffset),
          Number(receiptTotal.toFixed(2)),
          rc.paymentMethod,
          rc.accessKey,
          rc.openFinanceTxId,
          rc.reconciled
        ]
      );
      const receiptId = rRes.rows[0].id;

      for (const prod of PRODUCTS) {
        const pid = productIdsByName.get(prod.name)!;
        const pkgPrice = prod.pricesByStore[rc.storeKey][rc.periodIdx];
        // Normaliza pelo seenPackageSize no mês atual (periodIdx = 2) para refletir a reduflação no preço por g/ml!
        const effectiveSize = rc.periodIdx === 2 ? prod.seenPackageSize : prod.standardPackageSize;
        const normalizedBasePrice = pkgPrice / effectiveSize;

        await client.query(
          `INSERT INTO argus.receipt_items (
             receipt_id, canonical_product_id, raw_description, quantity, unit_type, unit_price, total_price, normalized_price_per_base_unit
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7)`,
          [
            receiptId,
            pid,
            prod.rawAlias,
            prod.unitType,
            pkgPrice,
            pkgPrice,
            Number(normalizedBasePrice.toFixed(6))
          ]
        );
      }
    }
    console.log(' ✅ 9 Cupons Fiscais históricos (180 observações de itens em 2 meses) inseridos.');

    // 4. Insere 2 Receitas Completas (Strogonoff de Frango e Frango Grelhado com Purê)
    const strogonoffRes = await client.query<{ id: string }>(
      `INSERT INTO argus.recipes (name, servings, instructions)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        'Strogonoff de Frango com Arroz Branco',
        6,
        '1. Doure a cebola na manteiga e azeite. 2. Sele o peito de frango em cubos. 3. Adicione catchup, champignon e finalize com creme de leite. 4. Sirva com arroz branco soltinho.'
      ]
    );
    const strogonoffId = strogonoffRes.rows[0].id;

    const strogonoffIngredients: Array<[string, number]> = [
      ['Peito de Frango Sem Osso (1kg)', 800], // 800g
      ['Creme de Leite UHT (200g)', 400], // 400g (2 caixinhas)
      ['Catchup Tradicional (400g)', 120], // 120g
      ['Champignon Fatiado em Conserva (100g)', 100], // 100g
      ['Cebola Nacional (1kg)', 150], // 150g
      ['Manteiga Extra Sem Sal (200g)', 30], // 30g
      ['Arroz Agulhinha Tipo 1 (5kg)', 500] // 500g
    ];

    for (const [pName, qty] of strogonoffIngredients) {
      const pid = productIdsByName.get(pName)!;
      await client.query(
        `INSERT INTO argus.recipe_ingredients (recipe_id, canonical_product_id, quantity_in_base_unit)
         VALUES ($1, $2, $3)`,
        [strogonoffId, pid, qty]
      );
    }

    const grelhadoRes = await client.query<{ id: string }>(
      `INSERT INTO argus.recipes (name, servings, instructions)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        'Frango Grelhado com Purê Cremoso de Batata',
        5,
        '1. Tempere os filés de peito de frango e grelhe no azeite. 2. Cozinhe as batatas Monalisa, amasse e bata no fogo com leite integral e manteiga até obter um purê aveludado.'
      ]
    );
    const grelhadoId = grelhadoRes.rows[0].id;

    const grelhadoIngredients: Array<[string, number]> = [
      ['Peito de Frango Sem Osso (1kg)', 750], // 750g
      ['Batata Monalisa Lavada (1kg)', 1000], // 1000g
      ['Leite Integral UHT (1L)', 250], // 250ml
      ['Manteiga Extra Sem Sal (200g)', 50], // 50g
      ['Azeite de Oliva Extra Virgem (500ml)', 25], // 25ml
      ['Cebola Nacional (1kg)', 100] // 100g
    ];

    for (const [pName, qty] of grelhadoIngredients) {
      const pid = productIdsByName.get(pName)!;
      await client.query(
        `INSERT INTO argus.recipe_ingredients (recipe_id, canonical_product_id, quantity_in_base_unit)
         VALUES ($1, $2, $3)`,
        [grelhadoId, pid, qty]
      );
    }

    console.log(' ✅ 2 Receitas completas ("Strogonoff de Frango" e "Frango Grelhado com Purê") populadas.');
  });

  console.log('======================================================================');
  console.log('🎯 Seed concluído com sucesso! O Argus Vision BI está pronto.');
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('[Argus Seed] Erro fatal:', err);
  process.exit(1);
});
