import crypto from 'node:crypto';
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
  hasOfficialAccessKey?: boolean;
  receiptNumber?: string | null;
  imageSha256?: string | null;
  normalizedImageSha256?: string | null;
  contentFingerprint?: string | null;
  items: ExtractedReceiptItemInput[];
  extractionMethod: 'QR_SEFAZ_SCRAPER' | 'GEMINI_VISION_2_5_FLASH' | 'STRUCTURED_INPUT';
  storageBucket?: string;
  storagePath?: string;
  originalSizeBytes?: number;
  compressedSizeBytes?: number;
}

export interface DuplicateVerificationResult {
  isDuplicate: boolean;
  layer:
    | 'NONE'
    | 'LAYER_1_EXACT_IMAGE_HASH'
    | 'LAYER_1_NORMALIZED_VISUAL_HASH'
    | 'LAYER_2_OFFICIAL_SEFAZ_KEY'
    | 'LAYER_3_RECEIPT_NUMBER_COO'
    | 'LAYER_4_CONTENT_FINGERPRINT'
    | 'LAYER_5_STORE_TOTAL_ITEMS_COLLISION';
  reason: string;
  existingReceiptId?: string;
  existingStoreName?: string;
  existingTotalAmount?: number;
  existingPurchaseDate?: string;
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
   * Camada 1 (Pré-OCR): Calcula o SHA-256 exato dos bytes e o SHA-256 visual normalizado (16x16 grayscale)
   * para identificar a mesma imagem mesmo se reencaminhada/recomprimida pelo Telegram.
   */
  async computeImageHashes(imageBuffer: Buffer): Promise<{
    imageSha256: string;
    normalizedImageSha256: string;
  }> {
    const imageSha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');
    try {
      const visualMatrix = await sharp(imageBuffer)
        .rotate()
        .grayscale()
        .resize(16, 16, { fit: 'fill' })
        .raw()
        .toBuffer();
      // Quantiza pixels em blocos de 16 níveis para tolerar recompressão JPEG do Telegram
      const quantized = Buffer.from(visualMatrix.map((b) => Math.floor(b / 16)));
      const normalizedImageSha256 = crypto.createHash('sha256').update(quantized).digest('hex');
      return { imageSha256, normalizedImageSha256 };
    } catch {
      return { imageSha256, normalizedImageSha256: imageSha256 };
    }
  }

  /**
   * Verifica no banco `argus.receipts` se a imagem já foi processada (antes de gastar cota do Gemini Vision)
   */
  async checkPreOcrImageDuplicate(
    imageSha256: string,
    normalizedImageSha256: string
  ): Promise<DuplicateVerificationResult> {
    const rows = await queryArgus<{
      id: string;
      trading_name: string;
      total_amount: string;
      purchase_date: string;
      image_sha256: string | null;
      normalized_image_sha256: string | null;
    }>(
      `SELECT r.id, s.trading_name, r.total_amount::text, r.purchase_date::text, r.image_sha256, r.normalized_image_sha256
       FROM argus.receipts r
       JOIN argus.stores s ON s.id = r.store_id
       WHERE r.image_sha256 = $1 OR r.normalized_image_sha256 = $2
       LIMIT 1`,
      [imageSha256, normalizedImageSha256]
    );

    if (rows.length > 0) {
      const match = rows[0];
      const isExact = match.image_sha256 === imageSha256;
      return {
        isDuplicate: true,
        layer: isExact ? 'LAYER_1_EXACT_IMAGE_HASH' : 'LAYER_1_NORMALIZED_VISUAL_HASH',
        reason: isExact
          ? 'Camada 1 (Hash Binário SHA-256): Este exato arquivo de imagem já foi processado e salvo.'
          : 'Camada 1 (Assinatura Visual 16x16): Esta mesma foto já foi enviada e salva anteriormente.',
        existingReceiptId: match.id,
        existingStoreName: match.trading_name,
        existingTotalAmount: Number(match.total_amount),
        existingPurchaseDate: match.purchase_date
      };
    }

    return { isDuplicate: false, layer: 'NONE', reason: '' };
  }

  /**
   * Normaliza datas brasileiras (ex: "11/11/2026 15:39:42") ou ISO para TIMESTAMPTZ seguro
   */
  normalizeReceiptDate(rawDate?: string): string {
    if (!rawDate) return new Date().toISOString();
    const trimmed = rawDate.trim();
    const brMatch = trimmed.match(
      /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
    );
    if (brMatch) {
      const day = brMatch[1].padStart(2, '0');
      const month = brMatch[2].padStart(2, '0');
      const year = brMatch[3].length === 2 ? `20${brMatch[3]}` : brMatch[3];
      const hour = (brMatch[4] || '12').padStart(2, '0');
      const min = (brMatch[5] || '00').padStart(2, '0');
      const sec = (brMatch[6] || '00').padStart(2, '0');
      const isoCandidate = `${year}-${month}-${day}T${hour}:${min}:${sec}-03:00`;
      const parsed = new Date(isoCandidate);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    const fallback = new Date(trimmed);
    if (!Number.isNaN(fallback.getTime())) {
      return fallback.toISOString();
    }
    return new Date().toISOString();
  }

  /**
   * Normaliza o CNPJ da loja; se o cupom não tiver CNPJ visível, gera um CNPJ sintético determinístico
   * baseado no nome do mercado para que mercados distintos nunca colidam no mesmo placeholder.
   */
  normalizeStoreCnpj(rawCnpj: string | undefined, storeTradingName: string): string {
    const digits = (rawCnpj || '').replace(/\D/g, '');
    if (digits.length === 14 && !/^0+$/.test(digits) && !/^9+$/.test(digits)) {
      return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12, 14)}`;
    }
    const cleanStore = (storeTradingName || 'MERCADO DESCONHECIDO')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    const hashHex = crypto.createHash('sha256').update(cleanStore).digest('hex');
    const numericHash = hashHex
      .split('')
      .map((c) => String(parseInt(c, 16) % 10))
      .join('');
    return `99.${numericHash.slice(0, 3)}.${numericHash.slice(3, 6)}/0001-${numericHash.slice(6, 8)}`;
  }

  /**
   * Calcula todos os identificadores multicamada do cupom (Chave Oficial vs. Sintética Determinística,
   * Número do Cupom/COO e Fingerprint Semântico do Conteúdo).
   */
  finalizeReceiptIdentifiers(
    raw: ExtractedReceiptData,
    hashes?: { imageSha256?: string; normalizedImageSha256?: string }
  ): ExtractedReceiptData {
    const storeTradingName = (raw.storeTradingName || raw.storeRawName || 'Mercado Identificado').trim();
    const storeCnpj = this.normalizeStoreCnpj(raw.storeCnpj, storeTradingName);
    const purchaseDate = this.normalizeReceiptDate(raw.purchaseDate);
    const totalAmount = Number(Number(raw.totalAmount || 0).toFixed(2));

    // Verifica se há uma Chave de Acesso SEFAZ oficial de 44 dígitos reais (não preenchida artificialmente)
    const cleanKeyDigits = (raw.accessKey || '').replace(/\D/g, '');
    const isGenuine44Key =
      cleanKeyDigits.length === 44 &&
      !/^(\d)\1{15,}$/.test(cleanKeyDigits) &&
      !cleanKeyDigits.endsWith('9999999999') &&
      !cleanKeyDigits.endsWith('0000000000');

    // Extrai/normaliza identificador secundário (COO / Extrato / Nº do Cupom ou carimbo de data+hora exato impresso)
    const rawReceiptNum = (raw.receiptNumber || '').trim();
    const receiptNumber =
      rawReceiptNum && !/^(null|undefined|n\/a|none|0+)$/i.test(rawReceiptNum)
        ? rawReceiptNum.slice(0, 64)
        : null;

    // Constrói a assinatura semântica imutável do conteúdo (Mercado + Total + Preços ordenados dos itens)
    const normStoreKey = storeTradingName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    const itemPricesSignature = [...(raw.items || [])]
      .map((it) => `${Number(it.quantity || 1).toFixed(2)}x${Number(it.totalPrice || 0).toFixed(2)}`)
      .sort()
      .join('|');

    const fingerprintPayload = `${normStoreKey}::${totalAmount.toFixed(2)}::${raw.items?.length || 0}::${itemPricesSignature}`;
    const contentFingerprint = crypto
      .createHash('sha256')
      .update(fingerprintPayload)
      .digest('hex');

    // Se não houver chave SEFAZ de 44 dígitos no cupom, deriva uma chave determinística de 44 dígitos do contentFingerprint
    const deterministicNumericKey =
      '8888' +
      contentFingerprint
        .split('')
        .map((ch) => String(parseInt(ch, 16) % 10))
        .join('')
        .slice(0, 40)
        .padEnd(40, '7');

    const finalAccessKey = isGenuine44Key ? cleanKeyDigits : deterministicNumericKey;

    return {
      ...raw,
      storeCnpj,
      storeRawName: raw.storeRawName || storeTradingName,
      storeTradingName,
      storeAddress: raw.storeAddress || 'São Paulo - SP',
      purchaseDate,
      totalAmount,
      discountAmount: Number(raw.discountAmount || 0),
      accessKey: finalAccessKey,
      hasOfficialAccessKey: isGenuine44Key,
      receiptNumber,
      imageSha256: hashes?.imageSha256 ?? raw.imageSha256 ?? null,
      normalizedImageSha256: hashes?.normalizedImageSha256 ?? raw.normalizedImageSha256 ?? null,
      contentFingerprint
    };
  }

  /**
   * Camadas 2, 3, 4 e 5 (Pós-OCR): Verifica no banco `argus.receipts` se este cupom já foi registrado,
   * mesmo quando a foto não possui a Chave de Acesso de 44 dígitos ou foi tirada de outro ângulo.
   */
  async checkPostOcrDuplicateLayers(
    data: ExtractedReceiptData
  ): Promise<DuplicateVerificationResult> {
    // Camada 2: Chave de Acesso SEFAZ Oficial de 44 dígitos
    if (data.hasOfficialAccessKey && data.accessKey) {
      const byKey = await queryArgus<{
        id: string;
        trading_name: string;
        total_amount: string;
        purchase_date: string;
      }>(
        `SELECT r.id, s.trading_name, r.total_amount::text, r.purchase_date::text
         FROM argus.receipts r
         JOIN argus.stores s ON s.id = r.store_id
         WHERE r.access_key = $1
         LIMIT 1`,
        [data.accessKey]
      );
      if (byKey.length > 0) {
        return {
          isDuplicate: true,
          layer: 'LAYER_2_OFFICIAL_SEFAZ_KEY',
          reason: `Camada 2 (Chave SEFAZ 44 dígitos): A chave oficial ${data.accessKey.slice(0, 12)}... já consta no banco.`,
          existingReceiptId: byKey[0].id,
          existingStoreName: byKey[0].trading_name,
          existingTotalAmount: Number(byKey[0].total_amount),
          existingPurchaseDate: byKey[0].purchase_date
        };
      }
    }

    // Camada 3: Número do Cupom / COO / Extrato + Mesmo Mercado/CNPJ + Mesmo Valor Total
    if (data.receiptNumber) {
      const byCoo = await queryArgus<{
        id: string;
        trading_name: string;
        total_amount: string;
        purchase_date: string;
      }>(
        `SELECT r.id, s.trading_name, r.total_amount::text, r.purchase_date::text
         FROM argus.receipts r
         JOIN argus.stores s ON s.id = r.store_id
         WHERE r.receipt_number = $1
           AND ABS(r.total_amount - $2) <= 0.05
           AND (s.cnpj = $3 OR UPPER(s.trading_name) = UPPER($4))
         LIMIT 1`,
        [data.receiptNumber, data.totalAmount, data.storeCnpj, data.storeTradingName]
      );
      if (byCoo.length > 0) {
        return {
          isDuplicate: true,
          layer: 'LAYER_3_RECEIPT_NUMBER_COO',
          reason: `Camada 3 (Identificador de Cupom/COO Nº ${data.receiptNumber}): Documento já auditado para ${byCoo[0].trading_name}.`,
          existingReceiptId: byCoo[0].id,
          existingStoreName: byCoo[0].trading_name,
          existingTotalAmount: Number(byCoo[0].total_amount),
          existingPurchaseDate: byCoo[0].purchase_date
        };
      }
    }

    // Camada 4: Content Fingerprint (Assinatura Semântica de Mercado + Total + Preços dos Itens)
    if (data.contentFingerprint) {
      const byFp = await queryArgus<{
        id: string;
        trading_name: string;
        total_amount: string;
        purchase_date: string;
      }>(
        `SELECT r.id, s.trading_name, r.total_amount::text, r.purchase_date::text
         FROM argus.receipts r
         JOIN argus.stores s ON s.id = r.store_id
         WHERE r.content_fingerprint = $1 OR r.access_key = $2
         LIMIT 1`,
        [data.contentFingerprint, data.accessKey]
      );
      if (byFp.length > 0) {
        return {
          isDuplicate: true,
          layer: 'LAYER_4_CONTENT_FINGERPRINT',
          reason:
            'Camada 4 (Fingerprint Semântico de Conteúdo): Cupom sem chave SEFAZ oficial, mas com idêntica assinatura de estabelecimento, total e lista de itens.',
          existingReceiptId: byFp[0].id,
          existingStoreName: byFp[0].trading_name,
          existingTotalAmount: Number(byFp[0].total_amount),
          existingPurchaseDate: byFp[0].purchase_date
        };
      }
    }

    // Camada 5: Heurística de Colisão de Compra (Mesmo Mercado + Mesmo Valor Total Exato + Mesma Quantidade de Itens)
    const byCollision = await queryArgus<{
      id: string;
      trading_name: string;
      total_amount: string;
      purchase_date: string;
      items_count: number;
    }>(
      `SELECT
         r.id,
         s.trading_name,
         r.total_amount::text,
         r.purchase_date::text,
         (SELECT count(*)::int FROM argus.receipt_items ri WHERE ri.receipt_id = r.id) AS items_count
       FROM argus.receipts r
       JOIN argus.stores s ON s.id = r.store_id
       WHERE (s.cnpj = $1 OR UPPER(s.trading_name) = UPPER($2))
         AND ABS(r.total_amount - $3) <= 0.01
       LIMIT 5`,
      [data.storeCnpj, data.storeTradingName, data.totalAmount]
    );

    for (const row of byCollision) {
      if (Math.abs(row.items_count - data.items.length) <= 1) {
        return {
          isDuplicate: true,
          layer: 'LAYER_5_STORE_TOTAL_ITEMS_COLLISION',
          reason: `Camada 5 (Colisão de Compra): Já existe uma nota no mercado ${row.trading_name} com o valor exato de R$ ${Number(
            row.total_amount
          ).toFixed(2)} e ${row.items_count} itens.`,
          existingReceiptId: row.id,
          existingStoreName: row.trading_name,
          existingTotalAmount: Number(row.total_amount),
          existingPurchaseDate: row.purchase_date
        };
      }
    }

    return { isDuplicate: false, layer: 'NONE', reason: '' };
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

      return this.finalizeReceiptIdentifiers({
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
      });
    } catch (err) {
      logger.warn({ err }, '[ArgusReceiptProcessor] Falha no scraping direto da SEFAZ; acionando fallback Gemini Vision');
      return null;
    }
  }

  private async generateWithModelFallback(
    params: Parameters<GoogleGenAI['models']['generateContent']>[0],
    timeoutMsPerModel = 18000
  ) {
    if (!this.ai) {
      throw new Error('GEMINI_API_KEY não configurada.');
    }
    const candidateModels = Array.from(
      new Set([
        env.GEMINI_MODEL,
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.8-flash'
      ])
    );
    let lastError: unknown;
    for (const modelName of candidateModels) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timeout (${timeoutMsPerModel}ms) no modelo ${modelName}`)),
            timeoutMsPerModel
          );
        });

        const result = await Promise.race([
          this.ai.models.generateContent({
            ...params,
            model: modelName
          }),
          timeoutPromise
        ]);
        if (timer) clearTimeout(timer);
        return result;
      } catch (err) {
        if (timer) clearTimeout(timer);
        lastError = err;
        logger.warn(
          { modelName, err: (err as Error).message },
          '[ArgusReceiptProcessor] Tentando próximo modelo Gemini'
        );
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

    // Otimiza a imagem com sharp antes de enviar ao Gemini Vision para reduzir latência de rede e inferência
    let optimizedBuffer = imageBuffer;
    let optimizedMime = mimeType;
    if (mimeType.startsWith('image/')) {
      try {
        optimizedBuffer = await sharp(imageBuffer)
          .rotate()
          .resize({ width: 1400, height: 2200, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toBuffer();
        optimizedMime = 'image/jpeg';
      } catch {
        optimizedBuffer = imageBuffer;
      }
    }

    const response = await this.generateWithModelFallback(
      {
        model: env.GEMINI_MODEL,
        contents: [
          {
            inlineData: {
              data: optimizedBuffer.toString('base64'),
              mimeType: optimizedMime
            }
          },
          {
            text: 'Você é o Argus (@MonetaArgusBot), auditor fiscal. Extraia o cabeçalho e todos os itens deste cupom fiscal brasileiro (NFC-e / SAT / Cupom de Mercado). Se a chave de acesso de 44 dígitos não estiver visível na foto, retorne string vazia em accessKey e extraia em receiptNumber qualquer número fixo do documento (COO, Extrato, Pedido, Caixa ou Data+Hora exata impressa no cabeçalho).'
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
              receiptNumber: { type: Type.STRING },
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
      },
      20000
    );

    const parsed = JSON.parse(response.text || '{}') as ExtractedReceiptData;
    return this.finalizeReceiptIdentifiers({
      ...parsed,
      extractionMethod: 'GEMINI_VISION_2_5_FLASH'
    });
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
    // Heurística determinística instantânea (preserva 100% da cota de RPM do Gemini Free Tier para o OCR Vision)
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
   * 5. Persiste o Cupom Fiscal completo no schema `argus` garantindo idempotência em 5 camadas
   */
  async ingestReceipt(rawInput: ExtractedReceiptData): Promise<{
    receiptId: string;
    alreadyExisted: boolean;
    duplicateLayer?: string;
    duplicateReason?: string;
    itemsProcessed: number;
    shrinkflationAlerts: string[];
  }> {
    const data = this.finalizeReceiptIdentifiers(rawInput);

    // Verifica duplicidade nas Camadas 2 a 5 contra o banco argus.receipts
    const dupCheck = await this.checkPostOcrDuplicateLayers(data);
    if (dupCheck.isDuplicate && dupCheck.existingReceiptId) {
      return {
        receiptId: dupCheck.existingReceiptId,
        alreadyExisted: true,
        duplicateLayer: dupCheck.layer,
        duplicateReason: dupCheck.reason,
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

      // 2. Insere o cabeçalho do cupom (incluindo colunas multicamada de deduplicação + bucket FotosArgus)
      const receiptRes = await client.query<{ id: string }>(
        `INSERT INTO argus.receipts (
           store_id, purchase_date, total_amount, discount_amount, payment_method, access_key, reconciled,
           storage_bucket, storage_path, original_size_bytes, compressed_size_bytes,
           has_official_access_key, receipt_number, image_sha256, normalized_image_sha256, content_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
          data.compressedSizeBytes || null,
          Boolean(data.hasOfficialAccessKey),
          data.receiptNumber || null,
          data.imageSha256 || null,
          data.normalizedImageSha256 || null,
          data.contentFingerprint || null
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
