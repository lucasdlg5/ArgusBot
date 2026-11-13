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

export type DetectedDocumentCategory =
  | 'FISCAL_RECEIPT'
  | 'MARKET_FLYER'
  | 'SHELF_TAG'
  | 'UNCERTAIN';

export interface DocumentClassificationVerdict {
  decision: 'DEFINITE_RECEIPT' | 'DEFINITE_FLYER_OR_SHELF' | 'UNCERTAIN_ASK_USER';
  category: DetectedDocumentCategory;
  confidencePct: number;
  receiptScore: number;
  flyerScore: number;
  colorSaturationScore: number;
  detectedFeatures: string[];
  summaryReason: string;
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
  // Metadados de Classificação Multimodal (Nota Fiscal vs. Flyer/Panfleto/Gôndola)
  detectedDocumentType?: DetectedDocumentCategory;
  classificationConfidencePct?: number;
  hasPrintedTotalLine?: boolean;
  hasPaymentOrChangeLine?: boolean;
  hasTabularQtyUnitColumns?: boolean;
  hasPromotionalFlyerMarkers?: boolean;
  classificationReasoning?: string;
}

export type ImageQualityLevel = 'GOOD' | 'ACCEPTABLE' | 'UNREADABLE';

export interface MultiDocumentExtractionResult {
  imageQuality: ImageQualityLevel;
  qualityReason: string;
  documentsCount: number;
  documents: ExtractedReceiptData[];
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

    // Verifica se há uma Chave de Acesso SEFAZ oficial de 44 dígitos reais (não sintética 8888... nem preenchida artificialmente)
    const cleanKeyDigits = (raw.accessKey || '').replace(/\D/g, '');
    const isGenuine44Key =
      cleanKeyDigits.length === 44 &&
      !cleanKeyDigits.startsWith('8888') &&
      !/^(\d)\1{15,}$/.test(cleanKeyDigits) &&
      !cleanKeyDigits.endsWith('9999999999') &&
      !cleanKeyDigits.endsWith('0000000000');

    // Extrai/normaliza identificador secundário (COO / Extrato / Nº do Cupom / Pedido)
    const rawReceiptNum = (raw.receiptNumber || '')
      .trim()
      .replace(/^(?:pedido|coo|extrato|doc|cupom|ccf|n[ºo°]?)\s*[:#\-]?\s*/i, '')
      .trim();
    const receiptNumber =
      rawReceiptNum && !/^(null|undefined|n\/a|none|0+)$/i.test(rawReceiptNum)
        ? rawReceiptNum.slice(0, 64)
        : null;

    // Constrói a assinatura semântica imutável do conteúdo (Total + Quantidade de itens + Preços ordenados dos itens)
    // Agnóstica ao nome da loja no cabeçalho para detectar a mesma nota mesmo quando o topo está cortado na foto!
    const itemPricesSignature = [...(raw.items || [])]
      .map((it) => `${Number(it.quantity || 1).toFixed(2)}x${Number(it.totalPrice || 0).toFixed(2)}`)
      .sort()
      .join('|');

    const fingerprintPayload = `${totalAmount.toFixed(2)}::${raw.items?.length || 0}::${itemPricesSignature}`;
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

    // Camada 3: Número do Cupom / COO / Extrato / Pedido + Mesmo Valor Total
    // (Mesmo se o cabeçalho do mercado foi cortado em um dos ângulos da foto)
    if (data.receiptNumber) {
      const normalizedCoo = data.receiptNumber
        .replace(/^(?:pedido|coo|extrato|doc|cupom|ccf|n[ºo°]?)\s*[:#\-]?\s*/i, '')
        .trim();

      const byCoo = await queryArgus<{
        id: string;
        store_id: string;
        store_cnpj: string;
        trading_name: string;
        total_amount: string;
        purchase_date: string;
      }>(
        `SELECT r.id, r.store_id, s.cnpj AS store_cnpj, s.trading_name, r.total_amount::text, r.purchase_date::text
         FROM argus.receipts r
         JOIN argus.stores s ON s.id = r.store_id
         WHERE (
           r.receipt_number = $1
           OR r.receipt_number = $2
           OR REGEXP_REPLACE(COALESCE(r.receipt_number, ''), '^(pedido|coo|extrato|doc|cupom|ccf|n[ºo°]?)\\s*[:#\\-]?\\s*', '', 'i') = $2
         )
           AND ABS(r.total_amount - $3) <= 0.05
         LIMIT 1`,
        [data.receiptNumber, normalizedCoo, data.totalAmount]
      );
      if (byCoo.length > 0) {
        // Se a nota anterior foi salva a partir de um ângulo com topo cortado (CNPJ sintético 99.*)
        // e este novo ângulo traz o CNPJ real de 14 dígitos e nome real da loja, enriquece o cadastro da loja!
        if (
          byCoo[0].store_cnpj.startsWith('99.') &&
          data.storeCnpj &&
          !data.storeCnpj.startsWith('99.') &&
          !data.storeCnpj.startsWith('00.')
        ) {
          await queryArgus(
            `UPDATE argus.stores
             SET cnpj = $1, raw_name = $2, trading_name = $3
             WHERE id = $4
               AND NOT EXISTS (SELECT 1 FROM argus.stores s2 WHERE s2.cnpj = $1 AND s2.id <> $4)`,
            [data.storeCnpj, data.storeRawName, data.storeTradingName, byCoo[0].store_id]
          ).catch(() => undefined);
        }

        return {
          isDuplicate: true,
          layer: 'LAYER_3_RECEIPT_NUMBER_COO',
          reason: `Camada 3 (Identificador de Cupom/Pedido Nº ${normalizedCoo}): Mesma nota fiscal detectada (mesmo Pedido/COO e mesmo Total R$ ${Number(
            byCoo[0].total_amount
          ).toFixed(2)}), mesmo enviada de outro ângulo.`,
          existingReceiptId: byCoo[0].id,
          existingStoreName:
            !byCoo[0].store_cnpj.startsWith('99.') || data.storeCnpj.startsWith('99.')
              ? byCoo[0].trading_name
              : data.storeTradingName,
          existingTotalAmount: Number(byCoo[0].total_amount),
          existingPurchaseDate: byCoo[0].purchase_date
        };
      }
    }

    // Camada 4: Content Fingerprint (Assinatura Semântica de Total + Quantidades e Preços dos Itens)
    if (data.contentFingerprint) {
      const byFp = await queryArgus<{
        id: string;
        store_id: string;
        store_cnpj: string;
        trading_name: string;
        total_amount: string;
        purchase_date: string;
      }>(
        `SELECT r.id, r.store_id, s.cnpj AS store_cnpj, s.trading_name, r.total_amount::text, r.purchase_date::text
         FROM argus.receipts r
         JOIN argus.stores s ON s.id = r.store_id
         WHERE r.content_fingerprint = $1 OR r.access_key = $2
         LIMIT 1`,
        [data.contentFingerprint, data.accessKey]
      );
      if (byFp.length > 0) {
        if (
          byFp[0].store_cnpj.startsWith('99.') &&
          data.storeCnpj &&
          !data.storeCnpj.startsWith('99.') &&
          !data.storeCnpj.startsWith('00.')
        ) {
          await queryArgus(
            `UPDATE argus.stores
             SET cnpj = $1, raw_name = $2, trading_name = $3
             WHERE id = $4
               AND NOT EXISTS (SELECT 1 FROM argus.stores s2 WHERE s2.cnpj = $1 AND s2.id <> $4)`,
            [data.storeCnpj, data.storeRawName, data.storeTradingName, byFp[0].store_id]
          ).catch(() => undefined);
        }

        return {
          isDuplicate: true,
          layer: 'LAYER_4_CONTENT_FINGERPRINT',
          reason:
            'Camada 4 (Fingerprint Semântico dos Itens e Total): Cupom sem chave SEFAZ oficial, mas com idêntica assinatura matemática de itens, pesos e valor total.',
          existingReceiptId: byFp[0].id,
          existingStoreName: byFp[0].trading_name,
          existingTotalAmount: Number(byFp[0].total_amount),
          existingPurchaseDate: byFp[0].purchase_date
        };
      }
    }

    // Camada 5: Heurística de Colisão de Compra (Mesmo Valor Total Exato > 0 + Mesma Quantidade Exata de Itens >= 4)
    if (data.totalAmount > 0 && data.items.length >= 4) {
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
         WHERE ABS(r.total_amount - $1) <= 0.01
         LIMIT 5`,
        [data.totalAmount]
      );

      for (const row of byCollision) {
        if (row.items_count === data.items.length) {
          return {
            isDuplicate: true,
            layer: 'LAYER_5_STORE_TOTAL_ITEMS_COLLISION',
            reason: `Camada 5 (Colisão de Compra): Já existe uma nota registrada (${row.trading_name}) com o valor exato de R$ ${Number(
              row.total_amount
            ).toFixed(2)} e os mesmos ${row.items_count} itens.`,
            existingReceiptId: row.id,
            existingStoreName: row.trading_name,
            existingTotalAmount: Number(row.total_amount),
            existingPurchaseDate: row.purchase_date
          };
        }
      }
    }

    return { isDuplicate: false, layer: 'NONE', reason: '' };
  }

  /**
   * Verifica se o conteúdo de um QR Code pertence de fato à SEFAZ (NFC-e / SAT / NF-e)
   * ou se é apenas um QR Code promocional de Flyer/Encarte ("Baixe nosso App", Instagram, Linktree, etc.).
   */
  isGenuineSefazQrUrl(qrData: string | null | undefined): boolean {
    if (!qrData) return false;
    const clean = qrData.trim();
    if (/fazenda|sefaz|nfce|nfe|sat\.|cfe|portalcf|dec\.fazenda/i.test(clean)) {
      return true;
    }
    const digitsOnly = clean.replace(/\D/g, '');
    if (digitsOnly.length >= 44 && /\d{44}/.test(clean)) {
      return true;
    }
    return false;
  }

  /**
   * Analisa o perfil cromático (saturação RGB) da imagem via `sharp`:
   * - Cupons fiscais térmicos têm papel monocromático (branco/cinza/amarelo pálido e letras pretas) -> baixa saturação (< 22) e poucos pixels vivos (< 12%).
   * - Flyers/Encartes de supermercado (ex: Clube NE / Quarta Verde / Ofertas) têm fundos vermelhos, amarelos, verdes e fotos coloridas -> alta saturação (>= 26) e muitos pixels vivos (>= 18%).
   */
  async analyzeImageColorSaturation(imageBuffer: Buffer): Promise<{
    meanChannelDiff: number;
    vividPixelPct: number;
    isHighlyColorful: boolean;
    isMonochromeThermal: boolean;
  }> {
    try {
      const { data, info } = await sharp(imageBuffer)
        .resize(64, 64, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const pixelCount = info.width * info.height;
      let totalDiff = 0;
      let vividPixels = 0;

      for (let i = 0; i < data.length; i += 3) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const diff = max - min;
        totalDiff += diff;
        if (diff >= 55 && max >= 75) {
          vividPixels++;
        }
      }

      const meanChannelDiff = Number((totalDiff / Math.max(1, pixelCount)).toFixed(1));
      const vividPixelPct = Number(((vividPixels / Math.max(1, pixelCount)) * 100).toFixed(1));

      return {
        meanChannelDiff,
        vividPixelPct,
        isHighlyColorful: meanChannelDiff >= 26 || vividPixelPct >= 18,
        isMonochromeThermal: meanChannelDiff <= 19 && vividPixelPct <= 8
      };
    } catch {
      return {
        meanChannelDiff: 20,
        vividPixelPct: 10,
        isHighlyColorful: false,
        isMonochromeThermal: false
      };
    }
  }

  /**
   * Classificador Multicritério (Visual + Estrutural + Fiscal) que diferencia:
   * - `DEFINITE_RECEIPT`: Cupom Fiscal / Pedido de Caixa (ex: Mercado Souza)
   * - `DEFINITE_FLYER_OR_SHELF`: Flyer / Panfleto de Ofertas / Etiqueta de Gôndola (ex: Nova Época / Clube NE)
   * - `UNCERTAIN_ASK_USER`: Caso fronteiriço onde o bot exibe as características detectadas e pergunta ao usuário.
   */
  async evaluateDocumentClassification(
    extracted: ExtractedReceiptData,
    imageBuffer: Buffer,
    qrData?: string | null
  ): Promise<DocumentClassificationVerdict> {
    const colorStats = await this.analyzeImageColorSaturation(imageBuffer);
    let receiptScore = 0;
    let flyerScore = 0;
    const detectedFeatures: string[] = [];

    // 1. Sinais de QR Code (SEFAZ vs. App Promocional de Encarte)
    if (qrData) {
      if (this.isGenuineSefazQrUrl(qrData)) {
        receiptScore += 60;
        detectedFeatures.push('QR Code oficial SEFAZ/NFC-e validado');
      } else {
        flyerScore += 40;
        detectedFeatures.push(`QR Code promocional (não-SEFAZ: "${qrData.slice(0, 38)}...") típico de encarte/app`);
      }
    }

    // 2. Chave SEFAZ de 44 dígitos real
    if (extracted.hasOfficialAccessKey) {
      receiptScore += 55;
      detectedFeatures.push('Chave de Acesso SEFAZ de 44 dígitos presente');
    }

    // 3. Perfil Cromático (Papel Térmico Monocromático vs. Arte Gráfica Colorida de Flyer)
    if (colorStats.isHighlyColorful) {
      flyerScore += 32;
      detectedFeatures.push(
        `Alta saturação de cores RGB (${colorStats.vividPixelPct}% pixels vivos / Δ=${colorStats.meanChannelDiff}) típica de Flyer/Encarte ou Gôndola`
      );
    } else if (colorStats.isMonochromeThermal) {
      receiptScore += 24;
      detectedFeatures.push(
        `Papel monocromático de baixa saturação (${colorStats.vividPixelPct}% pixels vivos) típico de bobina térmica`
      );
    }

    // 4. Classificação direta da Visão Multimodal Gemini
    if (extracted.detectedDocumentType === 'MARKET_FLYER') {
      flyerScore += 45;
      detectedFeatures.push('Layout visual de Panfleto/Jornal de Ofertas (grade de produtos com selos de preço)');
    } else if (extracted.detectedDocumentType === 'SHELF_TAG') {
      flyerScore += 45;
      detectedFeatures.push('Layout visual de Etiqueta de Gôndola / Prateleira de supermercado');
    } else if (extracted.detectedDocumentType === 'FISCAL_RECEIPT') {
      receiptScore += 35;
      detectedFeatures.push('Layout estrutural de Cupom Fiscal / Pedido de Caixa');
    }

    // 5. Marcadores promocionais de Flyer (Clube NE, Quarta Verde, Ofertas Válidas, Imagens Ilustrativas, Loja 001/002/003)
    const rawCombinedText = `${extracted.storeRawName} ${extracted.storeTradingName} ${extracted.storeAddress} ${extracted.classificationReasoning || ''}`;
    const hasFlyerKeywords =
      extracted.hasPromotionalFlyerMarkers === true ||
      /clube\s+ne|quarta\s+verde|quinta\s+vermelha|ofertas\s+v[aá]lidas|imagens\s+ilustrativas|enquanto\s+durarem|baixe\s+j[aá]\s+o\s+nosso\s+app|jornal\s+de\s+ofertas|encarte|folheto|loja\s+001.*loja\s+002/i.test(
        rawCombinedText
      );
    if (hasFlyerKeywords) {
      flyerScore += 45;
      detectedFeatures.push('Termos promocionais de encarte detectados ("Ofertas Válidas / Clube / Imagens Ilustrativas")');
    }

    // 6. Presença de linha impressa de TOTAL + Pagamento/Troco vs. Ausência de totalização de caixa
    if (extracted.hasPrintedTotalLine === true && extracted.totalAmount > 0) {
      receiptScore += 25;
      detectedFeatures.push(`Linha impressa de TOTAL de caixa (R$ ${extracted.totalAmount.toFixed(2)})`);
    } else if (extracted.hasPrintedTotalLine === false || extracted.totalAmount <= 0) {
      flyerScore += 30;
      detectedFeatures.push('Ausência de linha impressa de TOTAL a pagar no documento');
    }

    if (extracted.hasPaymentOrChangeLine === true) {
      receiptScore += 25;
      detectedFeatures.push(' Meio de pagamento / TROCO / Vendedor impresso no rodapé');
    }

    // 7. Colunas tabulares (Desc | Qtd | Unit | Total) e pesos fracionados de balança (ex: 0,206 kg, 0,414 kg)
    const hasFractionalWeights = (extracted.items || []).some((it) => {
      const q = Number(it.quantity || 1);
      return q > 0 && Math.abs(q - Math.round(q)) > 0.001;
    });
    if (hasFractionalWeights) {
      receiptScore += 30;
      detectedFeatures.push('Itens pesados na balança do caixa com quantidade fracionada (ex: 0,206 kg / 0,414 kg)');
    }

    if (extracted.hasTabularQtyUnitColumns === true) {
      receiptScore += 20;
      detectedFeatures.push('Tabela sequencial com colunas Desc. do Produto | Qtd | Unit | Total');
    }

    // 8. Padrão de catálogo: muitos itens (>= 12) onde 100% têm quantidade inteira igual a 1 e sem CNPJ real impresso
    const allQtyOne =
      (extracted.items || []).length >= 8 &&
      (extracted.items || []).every((it) => Number(it.quantity || 1) === 1);
    const hasSyntheticCnpj =
      !extracted.storeCnpj ||
      extracted.storeCnpj.startsWith('99.') ||
      extracted.storeCnpj.startsWith('00.');

    if (allQtyOne && hasSyntheticCnpj) {
      flyerScore += 25;
      detectedFeatures.push(
        `Grade de catálogo (${extracted.items.length} produtos todos com Qtd = 1 e sem CNPJ fiscal impresso)`
      );
    }

    // 9. Número de Pedido / COO / Extrato impresso
    if (extracted.receiptNumber) {
      receiptScore += 20;
      detectedFeatures.push(`Identificador de Pedido/Cupom impresso (Nº ${extracted.receiptNumber})`);
    }

    const diff = Math.abs(receiptScore - flyerScore);
    const maxScore = Math.max(receiptScore, flyerScore, 1);
    const confidencePct = Math.min(99, Math.max(50, Math.round(50 + (diff / maxScore) * 49)));

    // Regra de decisão com zona de incerteza explícita
    if (flyerScore >= receiptScore + 25 && flyerScore >= 45) {
      const category: DetectedDocumentCategory =
        extracted.detectedDocumentType === 'SHELF_TAG' ? 'SHELF_TAG' : 'MARKET_FLYER';
      return {
        decision: 'DEFINITE_FLYER_OR_SHELF',
        category,
        confidencePct,
        receiptScore,
        flyerScore,
        colorSaturationScore: colorStats.meanChannelDiff,
        detectedFeatures,
        summaryReason:
          extracted.classificationReasoning ||
          'Identificado automaticamente como Panfleto/Encarte de Ofertas ou Gôndola.'
      };
    }

    if (receiptScore >= flyerScore + 25 && receiptScore >= 45) {
      return {
        decision: 'DEFINITE_RECEIPT',
        category: 'FISCAL_RECEIPT',
        confidencePct,
        receiptScore,
        flyerScore,
        colorSaturationScore: colorStats.meanChannelDiff,
        detectedFeatures,
        summaryReason:
          extracted.classificationReasoning ||
          'Identificado automaticamente como Cupom Fiscal / Pedido de Compra.'
      };
    }

    return {
      decision: 'UNCERTAIN_ASK_USER',
      category: 'UNCERTAIN',
      confidencePct,
      receiptScore,
      flyerScore,
      colorSaturationScore: colorStats.meanChannelDiff,
      detectedFeatures,
      summaryReason:
        extracted.classificationReasoning ||
        'A imagem apresenta características mistas ou parciais entre Nota Fiscal e Flyer/Gôndola.'
    };
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
   * 3. Fallback Inteligente com Gemini Vision (Structured Outputs) com:
   *    - Verificação explícita de qualidade da imagem (`GOOD` / `ACCEPTABLE` / `UNREADABLE`)
   *    - Detecção e extração separada de MÚLTIPLOS cupons fiscais na mesma foto!
   */
  async extractMultipleReceiptsViaGeminiVision(
    imageBuffer: Buffer,
    mimeType = 'image/jpeg'
  ): Promise<MultiDocumentExtractionResult> {
    if (!this.ai) {
      throw new Error(
        'GEMINI_API_KEY não configurada e QR Code SEFAZ não pôde ser lido localmente.'
      );
    }

    // Otimiza a imagem mantendo alta resolução (1800x2600) para preservar legibilidade de múltiplas notas lado a lado
    let optimizedBuffer = imageBuffer;
    let optimizedMime = mimeType;
    if (mimeType.startsWith('image/')) {
      try {
        optimizedBuffer = await sharp(imageBuffer)
          .rotate()
          .resize({ width: 1800, height: 2600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 86, mozjpeg: true })
          .toBuffer();
        optimizedMime = 'image/jpeg';
      } catch {
        optimizedBuffer = imageBuffer;
      }
    }

    const documentSchema = {
      type: Type.OBJECT,
      properties: {
        detectedDocumentType: {
          type: Type.STRING,
          enum: ['FISCAL_RECEIPT', 'MARKET_FLYER', 'SHELF_TAG', 'UNCERTAIN']
        },
        classificationConfidencePct: { type: Type.NUMBER },
        hasPrintedTotalLine: { type: Type.BOOLEAN },
        hasPaymentOrChangeLine: { type: Type.BOOLEAN },
        hasTabularQtyUnitColumns: { type: Type.BOOLEAN },
        hasPromotionalFlyerMarkers: { type: Type.BOOLEAN },
        classificationReasoning: { type: Type.STRING },
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
        'detectedDocumentType',
        'classificationConfidencePct',
        'hasPrintedTotalLine',
        'hasPaymentOrChangeLine',
        'hasTabularQtyUnitColumns',
        'hasPromotionalFlyerMarkers',
        'classificationReasoning',
        'storeCnpj',
        'storeTradingName',
        'totalAmount',
        'paymentMethod',
        'accessKey',
        'items'
      ]
    };

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
            text: `Você é o Argus (@MonetaArgusBot), auditor fiscal e classificador multimodal de documentos de supermercado.

TAREFA 1 — QUALIDADE DA IMAGEM (OBRIGATÓRIO):
Avalie imageQuality:
- 'GOOD': Texto, preços e nomes de produtos legíveis com clareza.
- 'ACCEPTABLE': Levemente escuro/amassado/inclinado, mas valores e itens principais são legíveis com segurança.
- 'UNREADABLE': Foto muito borrada, sem foco, escura demais, cortada nos preços ou ilegível a ponto de não ser possível garantir os valores reais. Explique o motivo curto em qualityReason.

TAREFA 2 — DETECÇÃO DE MÚLTIPLOS DOCUMENTOS NA MESMA FOTO (OBRIGATÓRIO):
Inspecione TODA a foto da esquerda para a direita e de cima para baixo!
- Se houver 2 ou mais notas fiscais / cupons / pedidos separados lado a lado ou empilhados na mesma imagem (ex.: duas folhas de papel térmico diferentes), você DEVE extrair CADA documento separadamente no array \`documents\` (1 objeto por nota fiscal) e informar a quantidade exata em \`documentsCount\`!
- NUNCA misture itens de duas notas diferentes no mesmo objeto, e NUNCA ignore a segunda nota!

TAREFA 3 — CLASSIFICAÇÃO DE CADA DOCUMENTO:
- 'FISCAL_RECEIPT': Cupom fiscal térmico, NFC-e, SAT ou Pedido de Caixa (papel monocromático, colunas Desc/Qtd/Unit/Total, linha impressa de TOTAL a pagar, meio de pagamento/TROCO, Pedido/COO). Mesmo se o topo com nome do mercado/CNPJ estiver cortado, se tiver itens + TOTAL + pagamento, é 'FISCAL_RECEIPT'.
- 'MARKET_FLYER': Panfleto/encarte/post de ofertas (arte colorida, selos de preço, "Clube", "Ofertas Válidas", sem linha de TOTAL de compra).
- 'SHELF_TAG': Etiqueta de gôndola/prateleira.
- 'UNCERTAIN': Ambíguo.

REGRAS ESTRITAS:
1. NUNCA some preços de um panfleto/flyer para inventar totalAmount! Sem linha impressa de TOTAL => hasPrintedTotalLine = false e totalAmount = 0.
2. Em receiptNumber, extraia APENAS o código/número do Pedido, COO ou Extrato (ex: "2596437", "2593977").
3. Se o CNPJ não estiver visível, retorne "" em storeCnpj.
4. Se imageQuality = 'UNREADABLE', retorne documents: [] e documentsCount: 0.`
          }
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              imageQuality: {
                type: Type.STRING,
                enum: ['GOOD', 'ACCEPTABLE', 'UNREADABLE']
              },
              qualityReason: { type: Type.STRING },
              documentsCount: { type: Type.NUMBER },
              documents: {
                type: Type.ARRAY,
                items: documentSchema
              }
            },
            required: ['imageQuality', 'qualityReason', 'documentsCount', 'documents']
          }
        }
      },
      25000
    );

    const parsed = JSON.parse(response.text || '{}') as {
      imageQuality?: ImageQualityLevel;
      qualityReason?: string;
      documentsCount?: number;
      documents?: ExtractedReceiptData[];
    };

    const rawDocs = Array.isArray(parsed.documents) ? parsed.documents : [];
    const finalizedDocs = rawDocs.map((doc) =>
      this.finalizeReceiptIdentifiers({
        ...doc,
        extractionMethod: 'GEMINI_VISION_2_5_FLASH'
      })
    );

    return {
      imageQuality: parsed.imageQuality || 'ACCEPTABLE',
      qualityReason: parsed.qualityReason || 'Leitura padrão',
      documentsCount: finalizedDocs.length,
      documents: finalizedDocs
    };
  }

  /**
   * Wrapper retrocompatível que extrai o primeiro documento encontrado na imagem.
   */
  async extractReceiptViaGeminiVision(
    imageBuffer: Buffer,
    mimeType = 'image/jpeg'
  ): Promise<ExtractedReceiptData> {
    const multi = await this.extractMultipleReceiptsViaGeminiVision(imageBuffer, mimeType);
    if (multi.documents.length === 0) {
      throw new Error(
        `Imagem ilegível ou sem itens detectados (${multi.qualityReason || 'baixa nitidez'}).`
      );
    }
    return multi.documents[0];
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

  /**
   * Rollback transacional completo de um cupom fiscal já gravado (para desfazer ou reclassificar como Flyer/Gôndola).
   * Remove `argus.receipt_items` (via CASCADE), `argus.receipts` e marca job vinculado na fila se houver.
   */
  async rollbackReceiptById(receiptId: string): Promise<{
    deleted: boolean;
    storeName: string;
    totalAmount: number;
    itemsRemoved: number;
    telegramFileId?: string | null;
    telegramMessageId?: number | null;
    telegramChatId?: number | null;
    mimeType?: string | null;
    userCaption?: string | null;
  }> {
    return withArgusTransaction(async (client) => {
      const existing = await client.query<{
        id: string;
        store_name: string;
        total_amount: string;
        items_count: number;
      }>(
        `SELECT
           r.id,
           s.trading_name AS store_name,
           r.total_amount::text,
           (SELECT count(*)::int FROM argus.receipt_items ri WHERE ri.receipt_id = r.id) AS items_count
         FROM argus.receipts r
         JOIN argus.stores s ON s.id = r.store_id
         WHERE r.id = $1
         LIMIT 1`,
        [receiptId]
      );

      if (existing.rows.length === 0) {
        return { deleted: false, storeName: '', totalAmount: 0, itemsRemoved: 0 };
      }

      const row = existing.rows[0];

      // Busca metadados do arquivo original caso tenha sido salvo em media_processing_queue
      const queueRow = await client.query<{
        telegram_file_id: string | null;
        telegram_message_id: number | null;
        telegram_chat_id: number | null;
        mime_type: string | null;
        user_caption: string | null;
      }>(
        `SELECT telegram_file_id, telegram_message_id, telegram_chat_id, mime_type, user_caption
         FROM argus.media_processing_queue
         WHERE result_summary->>'receiptId' = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [receiptId]
      );

      await client.query(`DELETE FROM argus.receipt_items WHERE receipt_id = $1`, [receiptId]);
      await client.query(`DELETE FROM argus.receipts WHERE id = $1`, [receiptId]);
      await client.query(
        `DELETE FROM argus.media_processing_queue WHERE result_summary->>'receiptId' = $1`,
        [receiptId]
      );

      const q = queueRow.rows[0];
      return {
        deleted: true,
        storeName: row.store_name,
        totalAmount: Number(row.total_amount),
        itemsRemoved: row.items_count,
        telegramFileId: q?.telegram_file_id ?? null,
        telegramMessageId: q?.telegram_message_id ?? null,
        telegramChatId: q?.telegram_chat_id ?? null,
        mimeType: q?.mime_type ?? null,
        userCaption: q?.user_caption ?? null
      };
    });
  }
}
