import sharp from 'sharp';
import jsQR from 'jsqr';
import * as cheerio from 'cheerio';
import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus, withArgusTransaction } from '../lib/db';
import type {
  BaseUnit,
  PaymentMethod,
  ProductCategory,
  ReceiptUnitType
} from '../types/argus';

export interface ExtractedReceiptItemInput {
  rawDescription: string;
  ean?: string;
  quantity: number;
  unitType: ReceiptUnitType;
  unitPrice: number;
  totalPrice: number;
}

export interface ExtractedReceiptData {
  storeCnpj: string;
  storeRawName: string;
  storeTradingName: string;
  storeAddress: string;
  purchaseDate: string;
  totalAmount: number;
  discountAmount: number;
  paymentMethod: PaymentMethod;
  accessKey: string;
  items: ExtractedReceiptItemInput[];
  extractionMethod: 'QR_SEFAZ_SCRAPER' | 'GEMINI_VISION_2_5_FLASH' | 'STRUCTURED_INPUT';
  storageBucket?: string;
  storagePath?: string;
  originalSizeBytes?: number;
  compressedSizeBytes?: number;
}

export interface NormalizedItemInfo {
  canonicalName: string;
  category: ProductCategory;
  baseUnit: BaseUnit;
  standardPackageSize: number;
  seenPackageSize: number;
  packageMultiplier: number;
  isEssential: boolean;
}

export class ArgusReceiptProcessor {
  private readonly ai: GoogleGenAI | null;

  constructor() {
    this.ai = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;
  }

  /**
   * 1. Decodifica QR Code 100% localmente usando `sharp` + `jsqr`
   */
  async decodeQrCodeFromImage(imageBuffer: Buffer): Promise<string | null> {
    try {
      const { data, info } = await sharp(imageBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const qr = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      if (qr?.data) {
        logger.info({ qrUrl: qr.data.slice(0, 60) }, '[ArgusReceiptProcessor] QR Code detectado localmente via sharp+jsqr');
        return qr.data;
      }
      return null;
    } catch (err) {
      logger.warn({ err }, '[ArgusReceiptProcessor] Aviso ao decodificar QR Code com sharp+jsqr');
      return null;
    }
  }

  /**
   * 2. Faz scraping direto da página da SEFAZ (NFC-e / SAT-CF-e SP) com `fetch` + `cheerio`
   */
  async scrapeSefazReceipt(qrUrl: string): Promise<ExtractedReceiptData | null> {
    try {
      if (!/^https?:\/\//i.test(qrUrl)) return null;

      const response = await fetch(qrUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) return null;

      const html = await response.text();
      const $ = cheerio.load(html);

      const storeTradingName =
        $('#u20').text().trim() ||
        $('.txtTopo').first().text().trim() ||
        'Supermercado Identificado via SEFAZ';

      const cnpjText = $('.text').text();
      const cnpjMatch = cnpjText.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
      const storeCnpj = cnpjMatch ? cnpjMatch[0] : '00.000.000/0001-91';

      const accessKeyRaw = $('.chave').text().replace(/\D/g, '');
      const accessKey =
        accessKeyRaw.length === 44
          ? accessKeyRaw
          : qrUrl.replace(/\D/g, '').slice(0, 44).padEnd(44, '0');

      const items: ExtractedReceiptItemInput[] = [];
      $('tr[id^="Item"]').each((_, el) => {
        const rawDescription = $(el).find('.txtTit').first().text().trim();
        const qtyRaw = $(el)
          .find('.Rqtd')
          .text()
          .replace(/[^\d,.-]/g, '')
          .replace(',', '.');
        const unitRaw = $(el).find('.RUN').text().toUpperCase();
        const unitValRaw = $(el)
          .find('.RvlUnit')
          .text()
          .replace(/[^\d,.-]/g, '')
          .replace(',', '.');
        const totalRaw = $(el)
          .find('.valor')
          .text()
          .replace(/[^\d,.-]/g, '')
          .replace(',', '.');

        const quantity = Number(qtyRaw) || 1;
        const unitPrice = Number(unitValRaw) || Number(totalRaw) || 0;
        const totalPrice = Number(totalRaw) || Number((quantity * unitPrice).toFixed(2));
        const unitType: ReceiptUnitType = unitRaw.includes('KG')
          ? 'KG'
          : unitRaw.includes('LT') || unitRaw.includes('L')
            ? 'LT'
            : 'UN';

        if (rawDescription && totalPrice > 0) {
          items.push({
            rawDescription,
            quantity,
            unitType,
            unitPrice,
            totalPrice
          });
        }
      });

      if (items.length === 0) return null;

      const totalAmount = items.reduce((acc, item) => acc + item.totalPrice, 0);

      return {
        storeCnpj,
        storeRawName: storeTradingName,
        storeTradingName,
        storeAddress: 'São Paulo - SP',
        purchaseDate: new Date().toISOString(),
        totalAmount: Number(totalAmount.toFixed(2)),
        discountAmount: 0,
        paymentMethod: 'PIX',
        accessKey,
        items,
        extractionMethod: 'QR_SEFAZ_SCRAPER'
      };
    } catch (err) {
      logger.warn({ err }, '[ArgusReceiptProcessor] Falha no scraping direto da SEFAZ; acionando fallback Gemini Vision');
      return null;
    }
  }

  private async generateWithModelFallback(
    params: Parameters<GoogleGenAI['models']['generateContent']>[0]
  ) {
    if (!this.ai) {
      throw new Error('GEMINI_API_KEY não configurada.');
    }
    const candidateModels = Array.from(
      new Set([env.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'])
    );
    let lastError: unknown;
    for (const modelName of candidateModels) {
      try {
        return await this.ai.models.generateContent({
          ...params,
          model: modelName
        });
      } catch (err) {
        lastError = err;
        logger.warn({ modelName, err: (err as Error).message }, '[ArgusReceiptProcessor] Tentando próximo modelo Gemini');
      }
    }
    throw lastError;
  }

  /**
   * 3. Fallback Inteligente com Gemini Vision (Structured Outputs) para extrair foto/PDF
   */
  async extractReceiptViaGeminiVision(
    imageBuffer: Buffer,
    mimeType = 'image/jpeg'
  ): Promise<ExtractedReceiptData> {
    if (!this.ai) {
      throw new Error(
        'GEMINI_API_KEY não configurada e QR Code SEFAZ não pôde ser lido localmente.'
      );
    }

    const response = await this.generateWithModelFallback({
      model: env.GEMINI_MODEL,
      contents: [
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType
          }
        },
        {
          text: 'Você é o Argus (@MonetaArgusBot), auditor fiscal. Extraia o cabeçalho e todos os itens deste cupom fiscal brasileiro (NFC-e / SAT).'
        }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            storeCnpj: { type: Type.STRING },
            storeRawName: { type: Type.STRING },
            storeTradingName: { type: Type.STRING },
            storeAddress: { type: Type.STRING },
            purchaseDate: { type: Type.STRING },
            totalAmount: { type: Type.NUMBER },
            discountAmount: { type: Type.NUMBER },
            paymentMethod: {
              type: Type.STRING,
              enum: ['PIX', 'CREDIT_CARD', 'DEBIT', 'VR_VA', 'CASH']
            },
            accessKey: { type: Type.STRING },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  rawDescription: { type: Type.STRING },
                  quantity: { type: Type.NUMBER },
                  unitType: { type: Type.STRING, enum: ['KG', 'UN', 'LT'] },
                  unitPrice: { type: Type.NUMBER },
                  totalPrice: { type: Type.NUMBER }
                },
                required: ['rawDescription', 'quantity', 'unitType', 'unitPrice', 'totalPrice']
              }
            }
          },
          required: [
            'storeCnpj',
            'storeTradingName',
            'totalAmount',
            'paymentMethod',
            'accessKey',
            'items'
          ]
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}') as ExtractedReceiptData;
    return {
      ...parsed,
      storeRawName: parsed.storeRawName || parsed.storeTradingName,
      storeAddress: parsed.storeAddress || 'São Paulo - SP',
      purchaseDate: parsed.purchaseDate || new Date().toISOString(),
      discountAmount: parsed.discountAmount || 0,
      accessKey: (parsed.accessKey || '').replace(/\D/g, '').padEnd(44, '9').slice(0, 44),
      extractionMethod: 'GEMINI_VISION_2_5_FLASH'
    };
  }

  /**
   * 4. Normaliza a descrição abreviada do cupom para um Produto Canônico e Unidade Base (g, ml, un).
   * Consulta `argus.product_aliases` primeiro como cache; se for inédito, usa Gemini ou heurística determinística.
   */
  async resolveOrCreateCanonicalProduct(
    rawDescription: string,
    unitType: ReceiptUnitType
  ): Promise<{
    canonicalProductId: string;
    canonicalName: string;
    category: ProductCategory;
    baseUnit: BaseUnit;
    standardPackageSize: number;
    seenPackageSize: number;
    isEssential: boolean;
  }> {
    const cleanRaw = rawDescription.trim().toUpperCase();

    // 1. Verifica no cache de aliases (`argus.product_aliases`)
    const cached = await queryArgus<{
      canonical_product_id: string;
      name: string;
      category: ProductCategory;
      base_unit: BaseUnit;
      standard_package_size: string;
      last_seen_package_size: string;
      is_essential: boolean;
    }>(
      `SELECT
         pa.canonical_product_id,
         cp.name,
         cp.category,
         cp.base_unit,
         cp.standard_package_size,
         pa.last_seen_package_size,
         cp.is_essential
       FROM argus.product_aliases pa
       JOIN argus.canonical_products cp ON cp.id = pa.canonical_product_id
       WHERE UPPER(pa.raw_description) = $1
       LIMIT 1`,
      [cleanRaw]
    );

    if (cached.length > 0) {
      const row = cached[0];
      return {
        canonicalProductId: row.canonical_product_id,
        canonicalName: row.name,
        category: row.category,
        baseUnit: row.base_unit,
        standardPackageSize: Number(row.standard_package_size),
        seenPackageSize: Number(row.last_seen_package_size),
        isEssential: row.is_essential
      };
    }

    // 2. Classifica usando Gemini 2.5 Flash (se configurado) ou motor heurístico determinístico
    const inferred = await this.inferCanonicalProductMetadata(cleanRaw, unitType);

    // 3. Upsert no `canonical_products` e registra no cache `product_aliases`
    const upsertedProduct = await queryArgus<{ id: string }>(
      `INSERT INTO argus.canonical_products (name, category, base_unit, standard_package_size, is_essential)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         category = EXCLUDED.category
       RETURNING id`,
      [
        inferred.canonicalName,
        inferred.category,
        inferred.baseUnit,
        inferred.standardPackageSize,
        inferred.isEssential
      ]
    );

    const canonicalProductId = upsertedProduct[0].id;

    await queryArgus(
      `INSERT INTO argus.product_aliases (raw_description, canonical_product_id, package_multiplier, last_seen_package_size)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (raw_description) DO UPDATE SET
         last_seen_package_size = EXCLUDED.last_seen_package_size`,
      [cleanRaw, canonicalProductId, inferred.packageMultiplier, inferred.seenPackageSize]
    );

    return {
      canonicalProductId,
      canonicalName: inferred.canonicalName,
      category: inferred.category,
      baseUnit: inferred.baseUnit,
      standardPackageSize: inferred.standardPackageSize,
      seenPackageSize: inferred.seenPackageSize,
      isEssential: inferred.isEssential
    };
  }

  private async inferCanonicalProductMetadata(
    rawDescription: string,
    unitType: ReceiptUnitType
  ): Promise<NormalizedItemInfo> {
    if (this.ai) {
      try {
        const res = await this.generateWithModelFallback({
          model: env.GEMINI_MODEL,
          contents: `Normalize o item de nota fiscal brasileira "${rawDescription}" (unidade na nota: ${unitType}). Classifique a categoria, defina a unidade base ('g', 'ml' ou 'un'), o tamanho padrão da embalagem na unidade base (ex: 1000 para 1kg/1L, 500 para 500g), o tamanho real visto na descrição (para detectar reduflação, ex: 80g se disser 80G) e se é essencial (false para chocolates, refrigerantes, salgadinhos, doces, cerveja).`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                canonicalName: { type: Type.STRING },
                category: {
                  type: Type.STRING,
                  enum: [
                    'Carnes',
                    'Laticínios',
                    'Hortifruti',
                    'Mercearia',
                    'Limpeza',
                    'Higiene',
                    'Bebidas',
                    'Besteiras/Impulso',
                    'Combustível'
                  ]
                },
                baseUnit: { type: Type.STRING, enum: ['g', 'ml', 'un'] },
                standardPackageSize: { type: Type.NUMBER },
                seenPackageSize: { type: Type.NUMBER },
                isEssential: { type: Type.BOOLEAN }
              },
              required: [
                'canonicalName',
                'category',
                'baseUnit',
                'standardPackageSize',
                'seenPackageSize',
                'isEssential'
              ]
            }
          }
        });
        const parsed = JSON.parse(res.text || '{}');
        if (parsed.canonicalName) {
          return {
            ...parsed,
            packageMultiplier: 1
          };
        }
      } catch (err) {
        logger.warn({ err }, '[ArgusReceiptProcessor] Usando normalizador local determinístico');
      }
    }

    // Heurística determinística de alta precisão
    const upper = rawDescription.toUpperCase();
    const weightMatch = upper.match(/(\d+(?:[.,]\d+)?)\s*(KG|G|ML|L|LT|UN)\b/);
    let seenSize = unitType === 'KG' || unitType === 'LT' ? 1000 : 1;
    let baseUnit: BaseUnit = unitType === 'KG' ? 'g' : unitType === 'LT' ? 'ml' : 'un';

    if (weightMatch) {
      const val = Number(weightMatch[1].replace(',', '.'));
      const unit = weightMatch[2];
      if (unit === 'KG') {
        baseUnit = 'g';
        seenSize = val * 1000;
      } else if (unit === 'G') {
        baseUnit = 'g';
        seenSize = val;
      } else if (unit === 'L' || unit === 'LT') {
        baseUnit = 'ml';
        seenSize = val * 1000;
      } else if (unit === 'ML') {
        baseUnit = 'ml';
        seenSize = val;
      }
    }

    const isImpulse = /CHOC|BISCOITO|BOLACHA|REFRIG|COCA|CERVEJA|HEINEKEN|SALGADINHO|SORVETE|BOMBOM|DOCE|ENERGETICO/.test(
      upper
    );
    const category: ProductCategory = isImpulse
      ? 'Besteiras/Impulso'
      : /FRANGO|CARNE|PATINHO|ACEM|ALCATRA|LINGUICA|PORCO|PEIXE/.test(upper)
        ? 'Carnes'
        : /LEITE|QUEIJO|MANTEIGA|REQUEIJAO|IOGURTE|CREME DE LEITE/.test(upper)
          ? 'Laticínios'
          : /BATATA|TOMATE|CEBOLA|ALHO|BANANA|MACA|ALFACE|CENOURA|LIMAO/.test(upper)
            ? 'Hortifruti'
            : /DETERGENTE|SABAO|AMACIANTE|AGUA SANITARIA|DESINFETANTE|ESPONJA/.test(upper)
              ? 'Limpeza'
              : /SHAMPOO|SABONETE|CREME DENTAL|PAPEL HIGIENICO|DESODORANTE/.test(upper)
                ? 'Higiene'
                : /GASOLINA|ETANOL|DIESEL/.test(upper)
                  ? 'Combustível'
                  : 'Mercearia';

    return {
      canonicalName: rawDescription
        .replace(/\b\d+\s*(G|KG|ML|L|LT)\b/gi, '')
        .trim()
        .replace(/\s+/g, ' '),
      category,
      baseUnit,
      standardPackageSize: seenSize,
      seenPackageSize: seenSize,
      packageMultiplier: 1,
      isEssential: !isImpulse
    };
  }

  /**
   * 5. Persiste o Cupom Fiscal completo no schema `argus` garantindo idempotência via `access_key`
   */
  async ingestReceipt(data: ExtractedReceiptData): Promise<{
    receiptId: string;
    alreadyExisted: boolean;
    itemsProcessed: number;
    shrinkflationAlerts: string[];
  }> {
    // Verifica duplicidade via access_key
    const existing = await queryArgus<{ id: string }>(
      `SELECT id FROM argus.receipts WHERE access_key = $1 LIMIT 1`,
      [data.accessKey]
    );
    if (existing.length > 0) {
      return {
        receiptId: existing[0].id,
        alreadyExisted: true,
        itemsProcessed: 0,
        shrinkflationAlerts: []
      };
    }

    const shrinkflationAlerts: string[] = [];

    return withArgusTransaction(async (client) => {
      // 1. Garante que a loja exista
      const storeRes = await client.query<{ id: string }>(
        `INSERT INTO argus.stores (cnpj, raw_name, trading_name, address, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (cnpj) DO UPDATE SET
           trading_name = EXCLUDED.trading_name
         RETURNING id`,
        [
          data.storeCnpj,
          data.storeRawName,
          data.storeTradingName,
          data.storeAddress,
          env.HOME_LAT - 0.012,
          env.HOME_LNG - 0.015
        ]
      );
      const storeId = storeRes.rows[0].id;

      // 2. Insere o cabeçalho do cupom (incluindo referência ao arquivo comprimido no bucket FotosArgus)
      const receiptRes = await client.query<{ id: string }>(
        `INSERT INTO argus.receipts (
           store_id, purchase_date, total_amount, discount_amount, payment_method, access_key, reconciled,
           storage_bucket, storage_path, original_size_bytes, compressed_size_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9, $10)
         RETURNING id`,
        [
          storeId,
          data.purchaseDate,
          data.totalAmount,
          data.discountAmount,
          data.paymentMethod,
          data.accessKey,
          data.storageBucket || 'FotosArgus',
          data.storagePath || null,
          data.originalSizeBytes || null,
          data.compressedSizeBytes || null
        ]
      );
      const receiptId = receiptRes.rows[0].id;

      // 3. Processa e normaliza cada item
      for (const item of data.items) {
        const norm = await this.resolveOrCreateCanonicalProduct(item.rawDescription, item.unitType);

        // Calcula a quantidade total em unidade base (g, ml ou un)
        const totalBaseUnits =
          item.unitType === 'KG' || item.unitType === 'LT'
            ? item.quantity * 1000
            : item.quantity * norm.seenPackageSize;

        const normalizedPricePerBaseUnit =
          totalBaseUnits > 0 ? item.totalPrice / totalBaseUnits : item.unitPrice;

        if (norm.seenPackageSize < norm.standardPackageSize) {
          shrinkflationAlerts.push(
            `${norm.canonicalName}: embalagem reduzida de ${norm.standardPackageSize}${norm.baseUnit} para ${norm.seenPackageSize}${norm.baseUnit}`
          );
        }

        await client.query(
          `INSERT INTO argus.receipt_items (
             receipt_id, canonical_product_id, raw_description, quantity, unit_type, unit_price, total_price, normalized_price_per_base_unit
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            receiptId,
            norm.canonicalProductId,
            item.rawDescription,
            item.quantity,
            item.unitType,
            item.unitPrice,
            item.totalPrice,
            Number(normalizedPricePerBaseUnit.toFixed(6))
          ]
        );
      }

      return {
        receiptId,
        alreadyExisted: false,
        itemsProcessed: data.items.length,
        shrinkflationAlerts
      };
    });
  }
}
