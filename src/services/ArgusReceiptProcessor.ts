import crypto from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import sharp from 'sharp';
import jsQR from 'jsqr';
import {
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource
} from '@zxing/library';

// Evita acúmulo de cache nativo libvips em lotes grandes no plano Free (512 MB RAM)
sharp.cache(false);
sharp.concurrency(1);
import * as cheerio from 'cheerio';
import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus, withArgusTransaction } from '../lib/db';
import { classifyAndNormalizeStoreName } from '../lib/store-normalization';
import { ArgusStoreNormalizationService } from './ArgusStoreNormalizationService';
import { receiptVisionClient } from './ReceiptVisionClient';
import { failureAuditService } from './ArgusFailureAuditService';
import { llmFallbackProvider } from './LlmFallbackProvider';
import type {
  BaseUnit,
  PaymentMethod,
  ProductCategory,
  ReceiptUnitType
} from '../types/argus';

const geminiModelCooldownUntil = new Map<string, number>();

export function isQuotaExhaustedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lower = msg.toLowerCase();
  return (
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('"code":429') ||
    msg.includes('429') ||
    lower.includes('quota exceeded') ||
    lower.includes('no credits remaining') ||
    lower.includes('credit balance is too low')
  );
}

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lower = msg.toLowerCase();
  return (
    msg.includes('"code":503') ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    lower.includes('timeout') ||
    lower.includes('high demand') ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset')
  );
}

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
  private readonly storeNormalizer = new ArgusStoreNormalizationService();

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
   * Normaliza datas ISO ("2026-09-12T17:38:36") ou brasileiras ("12/09/26 17:38:36") para TIMESTAMPTZ seguro.
   * IMPORTANTE: testa ISO YYYY-MM-DD ANTES de DD/MM/YYYY para nunca capturar "26-09-12" dentro de "2026-09-12".
   * Quando houver chave SEFAZ oficial (44 dígitos), valida/corrige ano e mês usando AAMM (posições 2..5)
   * e protege contra anos absurdos de OCR ou datas no futuro.
   */
  normalizeReceiptDate(rawDate?: string, officialAccessKey?: string): string {
    const now = new Date();
    const currentYear = now.getUTCFullYear();

    let parsed: Date | null = null;
    if (rawDate) {
      const trimmed = rawDate.trim();

      // 1. Formato ISO YYYY-MM-DD (com ou sem hora/timezone) — DEVE vir antes do formato BR!
      const isoMatch = trimmed.match(
        /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/i
      );
      if (isoMatch) {
        const year = isoMatch[1];
        const month = isoMatch[2];
        const day = isoMatch[3];
        const hour = (isoMatch[4] || '12').padStart(2, '0');
        const min = (isoMatch[5] || '00').padStart(2, '0');
        const sec = (isoMatch[6] || '00').padStart(2, '0');
        const tz = isoMatch[7] || '-03:00';
        const candidate = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}${tz}`);
        if (!Number.isNaN(candidate.getTime())) {
          parsed = candidate;
        }
      }

      // 2. Formato brasileiro DD/MM/YYYY ou DD/MM/YY (com negative lookbehind para não casar dentro de YYYY)
      if (!parsed) {
        const brMatch = trimmed.match(
          /(?<!\d)(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?!\d)(?:[\s,Tàs]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i
        );
        if (brMatch) {
          const day = brMatch[1].padStart(2, '0');
          const month = brMatch[2].padStart(2, '0');
          const year = brMatch[3].length === 2 ? `20${brMatch[3]}` : brMatch[3];
          const hour = (brMatch[4] || '12').padStart(2, '0');
          const min = (brMatch[5] || '00').padStart(2, '0');
          const sec = (brMatch[6] || '00').padStart(2, '0');
          const candidate = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}-03:00`);
          if (!Number.isNaN(candidate.getTime())) {
            parsed = candidate;
          }
        }
      }

      if (!parsed) {
        const fallback = new Date(trimmed);
        if (!Number.isNaN(fallback.getTime())) {
          parsed = fallback;
        }
      }
    }

    if (!parsed) {
      parsed = new Date(now.getTime());
    }

    // 3. Se houver chave SEFAZ oficial de 44 dígitos, usa AAMM (posições 2..5) como fonte da verdade para ano/mês
    const cleanKey = (officialAccessKey || '').replace(/\D/g, '');
    if (cleanKey.length === 44) {
      const keyYear = 2000 + Number.parseInt(cleanKey.slice(2, 4), 10);
      const keyMonth = Number.parseInt(cleanKey.slice(4, 6), 10);
      if (
        keyYear >= 2020 &&
        keyYear <= currentYear + 1 &&
        keyMonth >= 1 &&
        keyMonth <= 12 &&
        (parsed.getUTCFullYear() !== keyYear || parsed.getUTCMonth() + 1 !== keyMonth)
      ) {
        const maxDay = new Date(Date.UTC(keyYear, keyMonth, 0)).getUTCDate();
        const safeDay = Math.min(parsed.getUTCDate(), maxDay);
        parsed = new Date(
          Date.UTC(
            keyYear,
            keyMonth - 1,
            safeDay,
            parsed.getUTCHours(),
            parsed.getUTCMinutes(),
            parsed.getUTCSeconds()
          )
        );
      }
    }

    // 4. Proteção contra anos absurdos de OCR (ex.: 2003, 2018, 2099) ou datas no futuro (> hoje + 2 dias)
    const y = parsed.getUTCFullYear();
    if (y < 2024 || y > currentYear + 1) {
      const maxDay = new Date(Date.UTC(currentYear, parsed.getUTCMonth() + 1, 0)).getUTCDate();
      const safeDay = Math.min(parsed.getUTCDate(), maxDay);
      let corrected = new Date(
        Date.UTC(
          currentYear,
          parsed.getUTCMonth(),
          safeDay,
          parsed.getUTCHours(),
          parsed.getUTCMinutes(),
          parsed.getUTCSeconds()
        )
      );
      if (corrected.getTime() > now.getTime() + 2 * 24 * 60 * 60 * 1000) {
        corrected = new Date(
          Date.UTC(
            currentYear - 1,
            parsed.getUTCMonth(),
            safeDay,
            parsed.getUTCHours(),
            parsed.getUTCMinutes(),
            parsed.getUTCSeconds()
          )
        );
      }
      parsed = corrected;
    } else if (parsed.getTime() > now.getTime() + 2 * 24 * 60 * 60 * 1000) {
      // Data no futuro no mesmo ano (ex.: 25/11/2026 quando hoje é 19/11/2026) -> recua 1 ano
      const prevYear = parsed.getUTCFullYear() - 1;
      const maxDay = new Date(Date.UTC(prevYear, parsed.getUTCMonth() + 1, 0)).getUTCDate();
      const safeDay = Math.min(parsed.getUTCDate(), maxDay);
      parsed = new Date(
        Date.UTC(
          prevYear,
          parsed.getUTCMonth(),
          safeDay,
          parsed.getUTCHours(),
          parsed.getUTCMinutes(),
          parsed.getUTCSeconds()
        )
      );
    }

    return parsed.toISOString();
  }

  /**
   * Extrai data/hora impressa e meio de pagamento diretamente do texto bruto OCR (custo zero de tokens)
   * para dupla checagem híbrida OCR + LLM.
   */
  extractPrintedDateAndPaymentFromRawText(rawText?: string | null): {
    printedDate?: string;
    paymentMethod?: PaymentMethod;
  } {
    if (!rawText || !rawText.trim()) return {};

    // Data/hora brasileira impressa no cupom (ex.: "12/09/26 17:38:36" ou "12/09/2026 17:38")
    const dateMatch = rawText.match(
      /(?<!\d)(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})(?!\d)(?:[\s,Tàs]+(\d{2}):(\d{2})(?::(\d{2}))?)?/i
    );
    let printedDate: string | undefined;
    if (dateMatch) {
      const dd = Number.parseInt(dateMatch[1], 10);
      const mm = Number.parseInt(dateMatch[2], 10);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        const yyyy = dateMatch[3].length === 2 ? `20${dateMatch[3]}` : dateMatch[3];
        const hh = dateMatch[4] || '12';
        const mi = dateMatch[5] || '00';
        const ss = dateMatch[6] || '00';
        printedDate = `${dateMatch[1]}/${dateMatch[2]}/${yyyy} ${hh}:${mi}:${ss}`;
      }
    }

    const normalized = rawText
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();

    let paymentMethod: PaymentMethod | undefined;
    if (
      /\b(VALE\s+ALIMENTACAO|VALE\s+REFEICAO|ALIMENTACAO|REFEICAO|ALELO|SODEXO|PLUXEE|TICKET|BEN\s+VISA|CAJU|FLASH|SWILE|VR|VA)\b/.test(
        normalized
      )
    ) {
      paymentMethod = 'VR_VA';
    } else if (/\bPIX\b/.test(normalized)) {
      paymentMethod = 'PIX';
    } else if (/\b(DEBITO|CARTAO\s+DE\s+DEBITO|VISA\s+ELECTRON|MAESTRO)\b/.test(normalized)) {
      paymentMethod = 'DEBIT';
    } else if (/\b(CREDITO|CARTAO\s+DE\s+CREDITO)\b/.test(normalized)) {
      paymentMethod = 'CREDIT_CARD';
    } else if (/\b(DINHEIRO|ESPECIE)\b/.test(normalized)) {
      paymentMethod = 'CASH';
    }

    return { printedDate, paymentMethod };
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
    const rawTrading = (raw.storeTradingName || raw.storeRawName || 'Mercado Identificado').trim();
    const storeTradingName = classifyAndNormalizeStoreName(rawTrading).canonicalName;
    const storeCnpj = this.normalizeStoreCnpj(raw.storeCnpj, storeTradingName);
    const totalAmount = Number(Number(raw.totalAmount || 0).toFixed(2));

    // Verifica se há uma Chave de Acesso SEFAZ oficial de 44 dígitos reais (não sintética 8888... nem preenchida artificialmente)
    const cleanKeyDigits = (raw.accessKey || '').replace(/\D/g, '');
    const isGenuine44Key =
      cleanKeyDigits.length === 44 &&
      !cleanKeyDigits.startsWith('8888') &&
      !/^(\d)\1{15,}$/.test(cleanKeyDigits) &&
      !cleanKeyDigits.endsWith('9999999999') &&
      !cleanKeyDigits.endsWith('0000000000');

    const purchaseDate = this.normalizeReceiptDate(
      raw.purchaseDate,
      isGenuine44Key ? cleanKeyDigits : undefined
    );

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
   * 1. Decodifica QR Code 100% localmente usando `sharp` + `jsqr` + `@zxing/library`
   *    (limita largura para conter RAM, força sRGB+RGBA para jsQR e isola cada passada)
   */
  async decodeQrCodeFromImage(imageBuffer: Buffer): Promise<string | null> {
    try {
      const base = sharp(imageBuffer)
        .rotate()
        .resize({ width: 1400, withoutEnlargement: true });

      let baseWidth = 0;
      let baseHeight = 0;

      // Passada 1: imagem inteira (RGBA 4 canais)
      try {
        const { data, info } = await base
          .clone()
          .toColourspace('srgb')
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        baseWidth = info.width;
        baseHeight = info.height;

        if (info.channels === 4) {
          const qrFull = jsQR(new Uint8ClampedArray(data), info.width, info.height);
          if (qrFull?.data) {
            logger.info(
              { qrUrl: qrFull.data.slice(0, 60) },
              '[ArgusReceiptProcessor] QR Code detectado localmente via sharp+jsqr'
            );
            return qrFull.data;
          }
        }
      } catch (err) {
        logger.debug({ err }, '[ArgusReceiptProcessor] Passada 1 (full) de QR local sem leitura');
      }

      // Passadas 2, 3 e 4: metade inferior do cupom (onde fica o QR Code)
      if (baseHeight >= 400 && baseWidth >= 200) {
        const cropTop = Math.floor(baseHeight * 0.45);
        const cropHeight = baseHeight - cropTop;
        const cropBuffer = await base
          .clone()
          .extract({ left: 0, top: cropTop, width: baseWidth, height: cropHeight })
          .resize({ width: 1100, withoutEnlargement: true })
          .png()
          .toBuffer();

        // Passada 2: recorte inferior com normalise (RGBA 4 canais)
        try {
          const { data: cropData, info: cropInfo } = await sharp(cropBuffer)
            .normalise()
            .toColourspace('srgb')
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          if (cropInfo.channels === 4) {
            const qrCrop = jsQR(new Uint8ClampedArray(cropData), cropInfo.width, cropInfo.height);
            if (qrCrop?.data) {
              logger.info(
                { qrUrl: qrCrop.data.slice(0, 60) },
                '[ArgusReceiptProcessor] QR Code detectado localmente via recorte inferior sharp+jsqr'
              );
              return qrCrop.data;
            }
          }
        } catch (err) {
          logger.debug({ err }, '[ArgusReceiptProcessor] Passada 2 (crop) de QR local sem leitura');
        }

        // Passada 3: binarização com threshold + sharpen convertida de volta para sRGB+RGBA (4 canais)
        try {
          const { data: threshData, info: threshInfo } = await sharp(cropBuffer)
            .grayscale()
            .normalise()
            .sharpen()
            .threshold(135)
            .toColourspace('srgb')
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          if (threshInfo.channels === 4) {
            const qrThresh = jsQR(
              new Uint8ClampedArray(threshData),
              threshInfo.width,
              threshInfo.height
            );
            if (qrThresh?.data) {
              logger.info(
                { qrUrl: qrThresh.data.slice(0, 60) },
                '[ArgusReceiptProcessor] QR Code detectado localmente via threshold sharp+jsqr'
              );
              return qrThresh.data;
            }
          }
        } catch (err) {
          logger.debug({ err }, '[ArgusReceiptProcessor] Passada 3 (threshold) de QR local sem leitura');
        }

        // Passada 4: binarização adaptativa local via @zxing/library (HybridBinarizer)
        try {
          const { data: grayData, info: grayInfo } = await sharp(cropBuffer)
            .grayscale()
            .normalise()
            .toColourspace('b-w')
            .raw()
            .toBuffer({ resolveWithObject: true });

          if (grayInfo.channels === 1 && grayData.length === grayInfo.width * grayInfo.height) {
            const luminance = new RGBLuminanceSource(
              new Uint8ClampedArray(grayData),
              grayInfo.width,
              grayInfo.height
            );
            const bitmap = new BinaryBitmap(new HybridBinarizer(luminance));
            const zxingRes = new QRCodeReader().decode(bitmap);
            const text = zxingRes?.getText();
            if (text) {
              logger.info(
                { qrUrl: text.slice(0, 60) },
                '[ArgusReceiptProcessor] QR Code detectado localmente via @zxing/library (HybridBinarizer)'
              );
              return text;
            }
          }
        } catch {
          // NotFoundException esperada quando não há QR legível
        }
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
    timeoutMsPerModel = 35000
  ): Promise<{ text?: string }> {
    let lastError: unknown;
    const now = Date.now();

    if (this.ai) {
      const candidateModels = Array.from(
        new Set([
          env.GEMINI_MODEL,
          'gemini-3.6-flash',
          'gemini-3.5-flash',
          'gemini-3.5-flash-lite',
          'gemini-3.8-flash'
        ])
      );
      const activeModels = candidateModels.filter((m) => {
        const until = geminiModelCooldownUntil.get(m) ?? 0;
        return now >= until;
      });
      const modelsToTry =
        activeModels.length > 0
          ? activeModels
          : [...candidateModels].sort(
              (a, b) =>
                (geminiModelCooldownUntil.get(a) ?? 0) - (geminiModelCooldownUntil.get(b) ?? 0)
            ).slice(0, 2);

      for (const modelName of modelsToTry) {
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
          geminiModelCooldownUntil.delete(modelName);
          return result;
        } catch (err) {
          if (timer) clearTimeout(timer);
          lastError = err;
          const errMsg = err instanceof Error ? err.message : String(err ?? '');
          if (
            errMsg.includes('"code":404') ||
            errMsg.includes('NOT_FOUND') ||
            errMsg.toLowerCase().includes('no longer available')
          ) {
            geminiModelCooldownUntil.set(modelName, Date.now() + 24 * 60 * 60 * 1000);
          } else if (isQuotaExhaustedError(err)) {
            const isDailyQuota =
              errMsg.includes('PerDay') ||
              errMsg.includes('free_tier_requests') ||
              /retry in \d+h/i.test(errMsg);
            const cooldownMs = isDailyQuota ? 2 * 60 * 60 * 1000 : 15 * 60 * 1000;
            geminiModelCooldownUntil.set(modelName, Date.now() + cooldownMs);
          }
          logger.warn(
            { modelName, err: (err as Error).message },
            '[ArgusReceiptProcessor] Tentando próximo modelo Gemini'
          );
        }
      }
    } else {
      lastError = new Error('GEMINI_API_KEY não configurada.');
    }

    // Fallback cadeia 2 (OpenAI) -> 3 (Claude) -> Erro
    if (llmFallbackProvider.hasAnyFallbackConfigured()) {
      logger.warn(
        { geminiError: lastError instanceof Error ? lastError.message : String(lastError) },
        '[ArgusReceiptProcessor] Todos os modelos Gemini falharam; acionando fallback 2. OpenAI -> 3. Claude'
      );
      const rawContents = Array.isArray(params.contents) ? params.contents : [params.contents];
      const textParts: string[] = [];
      let imageBase64: string | undefined;
      let imageMimeType: string | undefined;

      for (const part of rawContents) {
        if (typeof part === 'string') {
          textParts.push(part);
        } else if (part && typeof part === 'object') {
          const obj = part as {
            text?: string;
            inlineData?: { data?: string; mimeType?: string };
          };
          if (obj.text) textParts.push(obj.text);
          if (obj.inlineData?.data) {
            imageBase64 = obj.inlineData.data;
            imageMimeType = obj.inlineData.mimeType || 'image/jpeg';
          }
        }
      }

      const expectJson =
        (params.config as { responseMimeType?: string } | undefined)?.responseMimeType ===
        'application/json';

      try {
        const fallbackRes = await llmFallbackProvider.generateWithSecondaryAndTertiary({
          prompt: textParts.join('\n\n'),
          imageBase64,
          imageMimeType,
          expectJson,
          timeoutMs: 22000
        });
        return { text: fallbackRes.text };
      } catch (fallbackErr) {
        if (isTransientGeminiError(lastError) && fallbackErr && typeof fallbackErr === 'object') {
          (fallbackErr as { geminiTransient?: boolean }).geminiTransient = true;
        }
        throw fallbackErr;
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
    if (!this.ai && !llmFallbackProvider.hasAnyFallbackConfigured()) {
      throw new Error(
        'Nenhum provedor de IA configurado (GEMINI_API_KEY, OPENAI_API_KEY ou ANTHROPIC_API_KEY).'
      );
    }

    const startedAt = Date.now();
    logger.info(
      { mimeType, bytes: imageBuffer.length, openCvEnabled: receiptVisionClient.isEnabled() },
      '[INÍCIO] [ArgusReceiptProcessor] Extração Multimodal de Cupom'
    );

    // [1/4] Camada OpenCV (quando RECEIPT_VISION_API_URL configurada): corrige rotação 180°, recupera contraste CLAHE e tenta QR Code SEFAZ
    logger.info('[1/4] [ArgusReceiptProcessor] Verificando pré-processamento OpenCV + QR SEFAZ');
    const visionPre = receiptVisionClient.isEnabled()
      ? await receiptVisionClient.processImages([{ buffer: imageBuffer, mimeType }])
      : null;

    const resolvedQrUrl =
      visionPre?.qrCodeUrl && this.isGenuineSefazQrUrl(visionPre.qrCodeUrl)
        ? visionPre.qrCodeUrl
        : await this.decodeQrCodeFromImage(imageBuffer);

    if (resolvedQrUrl && this.isGenuineSefazQrUrl(resolvedQrUrl)) {
      const keyMatch = resolvedQrUrl.match(/\b(\d{44})\b/);
      if (keyMatch) {
        try {
          const existingByKey = await queryArgus<{
            total_amount: string;
            purchase_date: string;
            trading_name: string;
            cnpj: string;
            address: string;
          }>(
            `SELECT r.total_amount, r.purchase_date, s.trading_name, s.cnpj, s.address
             FROM argus.receipts r
             JOIN argus.stores s ON s.id = r.store_id
             WHERE r.access_key = $1
             LIMIT 1`,
            [keyMatch[1]]
          );
          if (existingByKey.length > 0) {
            const row = existingByKey[0];
            logger.info(
              { elapsedMs: Date.now() - startedAt, accessKey: keyMatch[1], store: row.trading_name },
              '[FIM] [ArgusReceiptProcessor] Chave SEFAZ do QR Code já registrada no banco (pré-cheque sem IA)'
            );
            return {
              imageQuality: 'GOOD',
              qualityReason: 'Chave SEFAZ identificada localmente via QR Code e já existente no banco',
              documentsCount: 1,
              documents: [
                {
                  storeCnpj: row.cnpj,
                  storeRawName: row.trading_name,
                  storeTradingName: row.trading_name,
                  storeAddress: row.address,
                  purchaseDate: new Date(row.purchase_date).toISOString(),
                  totalAmount: Number(row.total_amount),
                  discountAmount: 0,
                  paymentMethod: 'PIX',
                  accessKey: keyMatch[1],
                  hasOfficialAccessKey: true,
                  items: [],
                  extractionMethod: 'QR_SEFAZ_SCRAPER'
                }
              ]
            };
          }
        } catch {
          // Segue fluxo normal se falhar consulta rápida
        }
      }

      const scraped = await this.scrapeSefazReceipt(resolvedQrUrl).catch(() => null);
      if (scraped) {
        logger.info(
          { elapsedMs: Date.now() - startedAt, store: scraped.storeTradingName, total: scraped.totalAmount },
          '[FIM] [ArgusReceiptProcessor] Cupom extraído via QR Code SEFAZ local/OpenCV'
        );
        return {
          imageQuality: 'GOOD',
          qualityReason: visionPre?.qrCodeUrl
            ? 'QR Code SEFAZ recuperado via camada OpenCV (CLAHE/Orientação)'
            : 'QR Code SEFAZ decodificado localmente via sharp+jsqr',
          documentsCount: 1,
          documents: [scraped]
        };
      }
    }

    // Se a camada OpenCV corrigiu rotação macro (ex: 180°) ou desfoque sem cortar outros documentos, prioriza a imagem tratada
    const preReport = visionPre?.qualityReports?.[0];
    const sourceBuffer =
      visionPre?.enhancedImageBuffer &&
      preReport &&
      (preReport.detected_rotation_deg !== 0 || preReport.is_blurry || !preReport.cropped_document)
        ? visionPre.enhancedImageBuffer
        : imageBuffer;
    const sourceMime = sourceBuffer === imageBuffer ? mimeType : 'image/png';

    // [2/4] Otimiza a imagem mantendo alta resolução (1800x2600) para preservar legibilidade de múltiplas notas lado a lado
    let optimizedBuffer = sourceBuffer;
    let optimizedMime = sourceMime;
    if (sourceMime.startsWith('image/')) {
      try {
        optimizedBuffer = await sharp(sourceBuffer)
          .rotate()
          .resize({ width: 1800, height: 2600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 86, mozjpeg: true })
          .toBuffer();
        optimizedMime = 'image/jpeg';
      } catch {
        optimizedBuffer = sourceBuffer;
      }
    }
    logger.info(
      { sourceBytes: sourceBuffer.length, optimizedBytes: optimizedBuffer.length, usedOpenCvImage: sourceBuffer !== imageBuffer },
      '[2/4] [ArgusReceiptProcessor] Imagem preparada para Gemini Vision'
    );

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

    logger.info(
      { model: env.GEMINI_MODEL },
      '[3/4] [ArgusReceiptProcessor] Chamando Gemini Vision (qualidade + multi-documentos | até 3 tentativas)'
    );

    const response = await failureAuditService.executeWithRetryAndAudit({
      serviceName: 'ArgusReceiptProcessor',
      operationName: 'gemini_extract',
      maxAttempts: 3,
      baseDelayMs: 1500,
      shouldRetry: (err) =>
        Boolean((err as { geminiTransient?: boolean } | null)?.geminiTransient) ||
        !isQuotaExhaustedError(err),
      payloadSummary: {
        model: env.GEMINI_MODEL,
        mimeType: optimizedMime,
        sourceBytes: sourceBuffer.length,
        optimizedBytes: optimizedBuffer.length,
        usedOpenCvImage: sourceBuffer !== imageBuffer,
        imageSha256: crypto.createHash('sha256').update(imageBuffer).digest('hex')
      },
      fn: () =>
        this.generateWithModelFallback(
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
4. Se imageQuality = 'UNREADABLE', retorne documents: [] e documentsCount: 0.
5. Em purchaseDate, extraia OBRIGATORIAMENTE a DATA e HORA IMPRESSA NO PAPEL do cupom/NF (ex: "14/09/2026 18:22:10"). NUNCA use a data de hoje se houver uma data impressa no papel; se a hora não estiver visível, use "12:00:00". Confira os 4 dígitos do ano com extremo cuidado (cupons atuais são de 2025/2026 — não confunda "2026" borrado com "2003", "2018" ou "2024"; se a chave de 44 dígitos estiver visível, os dígitos 3º-6º são AAMM da emissão). Só retorne "" se não houver nenhuma data impressa na foto.
6. Em paymentMethod, leia a linha exata de FORMA DE PAGAMENTO / VALOR PAGO no rodapé do cupom e mapeie rigorosamente:
   - 'VR_VA': Vale Alimentação, Vale Refeição, VA, VR, Alelo, Sodexo, Pluxee, Ticket, Ben Visa Vale, Caju, Flash, Swile, Cartão Alimentação/Refeição.
   - 'PIX': Pix, QR Code Pix, Pagamento Instantâneo.
   - 'DEBIT': Cartão de Débito, Débito, Visa Electron, Maestro, Elo Débito.
   - 'CREDIT_CARD': Cartão de Crédito, Crédito.
   - 'CASH': Dinheiro, Espécie, Troco em dinheiro.
   Nunca chute 'CREDIT_CARD' se o cupom indicar Alimentação/VR/VA, Débito, Pix ou Dinheiro.`
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
          35000
        )
    });

    const parsed = JSON.parse(response.text || '{}') as {
      imageQuality?: ImageQualityLevel;
      qualityReason?: string;
      documentsCount?: number;
      documents?: ExtractedReceiptData[];
    };

    const rawDocs = Array.isArray(parsed.documents) ? parsed.documents : [];

    // Dupla checagem híbrida (OCR local/OpenCV custo zero + 2ª passada LLM apenas quando houver anomalia/divergência)
    if (
      rawDocs.length === 1 &&
      rawDocs[0].detectedDocumentType === 'FISCAL_RECEIPT' &&
      (parsed.imageQuality === 'GOOD' || parsed.imageQuality === 'ACCEPTABLE')
    ) {
      const candidateDoc = rawDocs[0];
      const ocrHints = this.extractPrintedDateAndPaymentFromRawText(visionPre?.rawOcrText);

      // Se o OCR detectou pagamento explícito (ex.: ALIMENTACAO -> VR_VA) e o LLM chutou outro, corrige sem custo de tokens
      if (ocrHints.paymentMethod && ocrHints.paymentMethod !== candidateDoc.paymentMethod) {
        logger.info(
          { llmPayment: candidateDoc.paymentMethod, ocrPayment: ocrHints.paymentMethod },
          '[ArgusReceiptProcessor] Pagamento ajustado por dupla checagem híbrida OCR'
        );
        candidateDoc.paymentMethod = ocrHints.paymentMethod;
      }

      const rawDateStr = (candidateDoc.purchaseDate || '').trim();
      if (!rawDateStr && ocrHints.printedDate) {
        candidateDoc.purchaseDate = ocrHints.printedDate;
      }

      const effectiveRawDate = (candidateDoc.purchaseDate || '').trim();
      const parsedPreview = effectiveRawDate
        ? new Date(this.normalizeReceiptDate(effectiveRawDate))
        : null;
      const ocrDatePreview = ocrHints.printedDate
        ? new Date(this.normalizeReceiptDate(ocrHints.printedDate))
        : null;
      const ocrDateMismatch =
        Boolean(parsedPreview && ocrDatePreview) &&
        parsedPreview!.toISOString().slice(0, 10) !== ocrDatePreview!.toISOString().slice(0, 10);

      const nowMs = Date.now();
      const itemsSum = (candidateDoc.items || []).reduce(
        (acc, it) => acc + Number(it.totalPrice || 0),
        0
      );
      const mathGap =
        candidateDoc.totalAmount > 0 ? Math.abs(itemsSum - Number(candidateDoc.totalAmount)) : 0;
      const needsDoubleCheck =
        Date.now() - startedAt < 75_000 &&
        (!effectiveRawDate ||
          !parsedPreview ||
          parsedPreview.getTime() > nowMs + 2 * 24 * 60 * 60 * 1000 ||
          parsedPreview.getUTCFullYear() < 2025 ||
          ocrDateMismatch ||
          mathGap > 1.0);

      if (needsDoubleCheck) {
        try {
          logger.info(
            {
              rawDate: effectiveRawDate || null,
              ocrDate: ocrHints.printedDate || null,
              ocrDateMismatch,
              paymentMethod: candidateDoc.paymentMethod,
              totalAmount: candidateDoc.totalAmount,
              mathGap: Number(mathGap.toFixed(2))
            },
            '[ArgusReceiptProcessor] Acionando dupla checagem focalizada (2ª passada LLM) para data/pagamento/total'
          );
          const ocrHintLine = ocrHints.printedDate
            ? `\nDICA DO OCR: o OCR leu "${ocrHints.printedDate}". Confirme olhando diretamente na foto qual data está realmente impressa.`
            : '';
          const verifyRes = await this.generateWithModelFallback(
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
                  text: `Auditoria de dupla checagem deste cupom fiscal. Leia APENAS os campos exatos impressos no papel:
1. rawPrintedDateTime: transcreva LITERALMENTE a data e hora impressas no papel no formato DD/MM/YYYY HH:mm:ss (ex: "12/09/2026 17:38:36"). Se o ano tiver 2 dígitos (ex: "12/09/26"), expanda para 4 dígitos ("12/09/2026").${ocrHintLine}
2. paymentMethod: mapeie a linha exata de FORMA DE PAGAMENTO / VALOR PAGO ('VR_VA' para Alimentação/Refeição/Alelo/Sodexo/Pluxee/Ticket/VR/VA; 'PIX'; 'DEBIT'; 'CREDIT_CARD'; 'CASH').
3. totalAmount: valor total numérico impresso na linha TOTAL.`
                }
              ],
              config: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    rawPrintedDateTime: { type: Type.STRING },
                    paymentMethod: {
                      type: Type.STRING,
                      enum: ['PIX', 'CREDIT_CARD', 'DEBIT', 'VR_VA', 'CASH']
                    },
                    totalAmount: { type: Type.NUMBER }
                  },
                  required: ['rawPrintedDateTime', 'paymentMethod', 'totalAmount']
                }
              }
            },
            18000
          );
          const verified = JSON.parse(verifyRes.text || '{}') as {
            rawPrintedDateTime?: string;
            paymentMethod?: PaymentMethod;
            totalAmount?: number;
          };
          if (verified.rawPrintedDateTime && verified.rawPrintedDateTime.trim().length >= 8) {
            candidateDoc.purchaseDate = verified.rawPrintedDateTime.trim();
          }
          if (verified.paymentMethod) {
            candidateDoc.paymentMethod = verified.paymentMethod;
          }
          if (
            typeof verified.totalAmount === 'number' &&
            Number.isFinite(verified.totalAmount) &&
            verified.totalAmount > 0 &&
            mathGap > 1.0
          ) {
            candidateDoc.totalAmount = verified.totalAmount;
          }
          logger.info(
            {
              verifiedDate: verified.rawPrintedDateTime,
              verifiedPayment: verified.paymentMethod,
              verifiedTotal: verified.totalAmount
            },
            '[ArgusReceiptProcessor] Dupla checagem focalizada concluída'
          );
        } catch (verifyErr) {
          logger.warn(
            { err: verifyErr instanceof Error ? verifyErr.message : String(verifyErr) },
            '[ArgusReceiptProcessor] Dupla checagem opcional falhou; mantendo 1ª leitura'
          );
        }
      }
    }

    const finalizedDocs = rawDocs.map((doc) => {
      const enriched: ExtractedReceiptData = {
        ...doc,
        accessKey:
          doc.accessKey && /^\d{44}$/.test(doc.accessKey)
            ? doc.accessKey
            : visionPre?.sefazAccessKey || doc.accessKey,
        extractionMethod: 'GEMINI_VISION_2_5_FLASH'
      };
      const finalized = this.finalizeReceiptIdentifiers(enriched);
      return this.applySelfHealingMathWarning(finalized);
    });

    const totalItemsExtracted = finalizedDocs.reduce((acc, d) => acc + d.items.length, 0);
    logger.info(
      {
        elapsedMs: Date.now() - startedAt,
        imageQuality: parsed.imageQuality || 'ACCEPTABLE',
        documentsCount: finalizedDocs.length,
        totalItemsExtracted,
        dates: finalizedDocs.map((d) => d.purchaseDate),
        payments: finalizedDocs.map((d) => d.paymentMethod)
      },
      '[FIM] [ArgusReceiptProcessor] [4/4] Extração Multimodal finalizada com Self-Healing matemático'
    );

    return {
      imageQuality: parsed.imageQuality || 'ACCEPTABLE',
      qualityReason: parsed.qualityReason || 'Leitura padrão',
      documentsCount: finalizedDocs.length,
      documents: finalizedDocs
    };
  }

  /**
   * Validação Matemática (Self-Healing): verifica se Soma(Itens) bate com o Total Pago
   * e sinaliza divergência no reasoning caso haja erro de leitura térmica (ex: 3 vs 8).
   */
  private applySelfHealingMathWarning(doc: ExtractedReceiptData): ExtractedReceiptData {
    if (doc.detectedDocumentType !== 'FISCAL_RECEIPT' || doc.items.length === 0 || doc.totalAmount <= 0) {
      return doc;
    }
    const itemsSum = Number(
      doc.items.reduce((acc, it) => acc + Number(it.totalPrice || 0), 0).toFixed(2)
    );
    const diff = Number(Math.abs(itemsSum - Number(doc.totalAmount)).toFixed(2));
    if (diff > 0.1) {
      const note = ` [confidence_warning: Soma dos itens (R$ ${itemsSum.toFixed(2)}) diverge do total (R$ ${doc.totalAmount.toFixed(2)}) em R$ ${diff.toFixed(2)}]`;
      return {
        ...doc,
        classificationReasoning: `${doc.classificationReasoning || ''}${note}`.trim()
      };
    }
    return doc;
  }

  /**
   * Costura múltiplas fotos sequenciais de UMA MESMA nota longa (ex: 70-120 itens em 2-3 fotos)
   * usando o microsserviço OpenCV (SIFT/AKAZE + Linear Blending) e extrai os dados sem duplicar itens.
   */
  async extractStitchedReceiptFromParts(
    parts: Array<{ buffer: Buffer; mimeType?: string }>
  ): Promise<{
    stitched: boolean;
    overlapsDetected: number;
    unifiedBuffer: Buffer;
    document: ExtractedReceiptData;
  } | null> {
    if (parts.length < 2) {
      return null;
    }

    // 1. Tenta primeiro o microsserviço OpenCV (SIFT/AKAZE + Linear Blending) quando disponível
    const visionRes = receiptVisionClient.isEnabled()
      ? await receiptVisionClient.processImages(parts)
      : null;

    if (visionRes?.enhancedImageBuffer && visionRes.stitchSummary.overlaps_detected > 0) {
      if (visionRes.qrCodeUrl && this.isGenuineSefazQrUrl(visionRes.qrCodeUrl)) {
        const scraped = await this.scrapeSefazReceipt(visionRes.qrCodeUrl).catch(() => null);
        if (scraped) {
          return {
            stitched: true,
            overlapsDetected: visionRes.stitchSummary.overlaps_detected,
            unifiedBuffer: visionRes.enhancedImageBuffer,
            document: scraped
          };
        }
      }

      const multi = await this.extractMultipleReceiptsViaGeminiVision(
        visionRes.enhancedImageBuffer,
        'image/png'
      );
      if (multi.documents.length > 0) {
        return {
          stitched: true,
          overlapsDetected: visionRes.stitchSummary.overlaps_detected,
          unifiedBuffer: visionRes.enhancedImageBuffer,
          document: multi.documents[0]
        };
      }
    }

    // 2. Fallback Multimodal Nativo (sem depender do OpenCV acordado):
    //    envia todas as partes (2..4 fotos) juntas na MESMA chamada ao Gemini Vision para detectar
    //    continuação de nota longa, mesclar cabeçalho + rodapé e deduplicar itens sobrepostos.
    if (!this.ai && !llmFallbackProvider.hasAnyFallbackConfigured()) {
      return null;
    }

    const startedAt = Date.now();
    logger.info(
      { partsCount: parts.length },
      '[INÍCIO] [ArgusReceiptProcessor] Fusão Multimodal Nativa de álbum (2..4 fotos) via Gemini Vision'
    );

    // Tenta decodificar QR Code SEFAZ localmente em qualquer uma das partes (geralmente na última foto)
    let localSefazKey: string | undefined;
    for (let i = parts.length - 1; i >= 0; i--) {
      const qr = await this.decodeQrCodeFromImage(parts[i].buffer).catch(() => null);
      if (qr && this.isGenuineSefazQrUrl(qr)) {
        const km = qr.match(/\b(\d{44})\b/);
        if (km) localSefazKey = km[1];
        const scraped = await this.scrapeSefazReceipt(qr).catch(() => null);
        if (scraped && scraped.items.length > 0) {
          logger.info(
            { elapsedMs: Date.now() - startedAt, itemsCount: scraped.items.length },
            '[FIM] [ArgusReceiptProcessor] Nota longa resolvida diretamente via QR SEFAZ de uma das partes'
          );
          return {
            stitched: true,
            overlapsDetected: parts.length - 1,
            unifiedBuffer: parts[0].buffer,
            document: scraped
          };
        }
      }
    }

    const optimizedParts: Array<{ buffer: Buffer; mimeType: string }> = [];
    for (const part of parts) {
      try {
        const opt = await sharp(part.buffer)
          .rotate()
          .resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 84, mozjpeg: true })
          .toBuffer();
        optimizedParts.push({ buffer: opt, mimeType: 'image/jpeg' });
      } catch {
        optimizedParts.push({ buffer: part.buffer, mimeType: part.mimeType || 'image/jpeg' });
      }
    }

    const response = await this.generateWithModelFallback(
      {
        model: env.GEMINI_MODEL,
        contents: [
          ...optimizedParts.map((p) => ({
            inlineData: {
              data: p.buffer.toString('base64'),
              mimeType: p.mimeType
            }
          })),
          {
            text: `Você recebeu ${optimizedParts.length} fotos enviadas juntas em um álbum do Telegram.
TAREFA PRINCIPAL — VERIFICAR CONTINUAÇÃO DE NOTA LONGA:
Analise cuidadosamente todas as ${optimizedParts.length} imagens em ordem:
1. Determine se elas são PARTES/CONTINUAÇÃO DA MESMA NOTA FISCAL LONGA (ex.: Foto 1 mostra cabeçalho/loja e itens 01..66; Foto 2 mostra itens sobrepostos 48..66 + continuação 67..74 + TOTAL + forma de pagamento + data + chave SEFAZ).
   - Se SIM: defina isSameReceiptContinuation = true, informe overlapsDetected (quantas emendas existem, ex.: ${optimizedParts.length - 1}), e UNIFIQUE tudo em UM ÚNICO objeto \`document\`:
     * Use o nome da loja, CNPJ e endereço da Foto 1 (cabeçalho).
     * Use o valor TOTAL, desconto, forma de pagamento, data/hora de emissão e chave de acesso SEFAZ (44 dígitos) da Foto final (rodapé).
     * MESCLE todos os itens na ordem correta SEM DUPLICAR os itens da zona de sobreposição (ex.: se os itens 48..66 aparecem nas duas fotos, inclua cada item apenas UMA vez, totalizando os 74 itens reais!).
   - Se NÃO (são notas fiscais diferentes / independentes, ou flyers): defina isSameReceiptContinuation = false e deixe \`document\` vazio/mínimo.

REGRAS ESTRITAS PARA O DOCUMENTO UNIFICADO:
- Em purchaseDate, extraia a DATA e HORA IMPRESSAS NO PAPEL no formato "DD/MM/YYYY HH:mm:ss" (ex: "01/09/2026 21:52:55").
- Em paymentMethod, leia a linha exata de pagamento no rodapé ('VR_VA' para Alimentação/Refeição/Alelo/Sodexo/Pluxee/Ticket/VR/VA; 'PIX'; 'DEBIT'; 'CREDIT_CARD'; 'CASH'). Se houver pagamento misto (ex.: Alelo + Débito), escolha o de maior valor.
- Em accessKey, extraia os 44 dígitos da Chave de Acesso SEFAZ se visível no rodapé.`
          }
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isSameReceiptContinuation: { type: Type.BOOLEAN },
              overlapsDetected: { type: Type.NUMBER },
              reasoning: { type: Type.STRING },
              document: {
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
            },
            required: ['isSameReceiptContinuation', 'overlapsDetected', 'document']
          }
        }
      },
      45000
    );

    const parsed = JSON.parse(response.text || '{}') as {
      isSameReceiptContinuation?: boolean;
      overlapsDetected?: number;
      reasoning?: string;
      document?: ExtractedReceiptData;
    };

    if (!parsed.isSameReceiptContinuation || !parsed.document || (parsed.document.items || []).length === 0) {
      logger.info(
        {
          elapsedMs: Date.now() - startedAt,
          isSameReceiptContinuation: Boolean(parsed.isSameReceiptContinuation),
          reasoning: parsed.reasoning?.slice(0, 140)
        },
        '[FIM] [ArgusReceiptProcessor] Álbum não é continuação da mesma nota; seguindo leitura individual'
      );
      return null;
    }

    const enriched: ExtractedReceiptData = {
      ...parsed.document,
      detectedDocumentType: 'FISCAL_RECEIPT',
      hasPrintedTotalLine: (parsed.document.totalAmount || 0) > 0,
      accessKey:
        parsed.document.accessKey && /^\d{44}$/.test(parsed.document.accessKey.replace(/\D/g, ''))
          ? parsed.document.accessKey.replace(/\D/g, '')
          : localSefazKey || parsed.document.accessKey || '',
      extractionMethod: 'GEMINI_VISION_2_5_FLASH'
    };
    const finalized = this.applySelfHealingMathWarning(this.finalizeReceiptIdentifiers(enriched));

    logger.info(
      {
        elapsedMs: Date.now() - startedAt,
        store: finalized.storeTradingName,
        totalAmount: finalized.totalAmount,
        itemsCount: finalized.items.length,
        purchaseDate: finalized.purchaseDate,
        paymentMethod: finalized.paymentMethod,
        overlapsDetected: Math.max(1, Number(parsed.overlapsDetected || 1))
      },
      '[FIM] [ArgusReceiptProcessor] Nota longa unificada com sucesso via Fusão Multimodal Nativa (Gemini)'
    );

    return {
      stitched: true,
      overlapsDetected: Math.max(1, Number(parsed.overlapsDetected || 1)),
      unifiedBuffer: optimizedParts[0].buffer,
      document: finalized
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
    unitType: ReceiptUnitType,
    dbClient?: PoolClient
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
    const runQuery = async <T extends QueryResultRow>(
      sql: string,
      params?: unknown[]
    ): Promise<T[]> => {
      if (dbClient) {
        const res = await dbClient.query<T>(sql, params);
        return res.rows;
      }
      return queryArgus<T>(sql, params);
    };

    // 1. Verifica no cache de aliases (`argus.product_aliases`)
    const cached = await runQuery<{
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
    const upsertedProduct = await runQuery<{ id: string }>(
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

    await runQuery(
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
    const startedAt = Date.now();
    const data = this.finalizeReceiptIdentifiers(rawInput);
    logger.info(
      {
        store: data.storeTradingName,
        totalAmount: data.totalAmount,
        itemsCount: data.items.length,
        hasOfficialKey: data.hasOfficialAccessKey
      },
      '[INÍCIO] [ArgusReceiptProcessor] Ingestão de Nota Fiscal no PostgreSQL'
    );

    // [1/3] Verifica duplicidade nas Camadas 2 a 5 contra o banco argus.receipts
    logger.info('[1/3] [ArgusReceiptProcessor] Verificando camadas de deduplicação no banco');
    const dupCheck = await this.checkPostOcrDuplicateLayers(data);
    if (dupCheck.isDuplicate && dupCheck.existingReceiptId) {
      logger.info(
        {
          elapsedMs: Date.now() - startedAt,
          existingReceiptId: dupCheck.existingReceiptId,
          layer: dupCheck.layer
        },
        '[FIM] [ArgusReceiptProcessor] Nota fiscal já registrada (duplicata evitada)'
      );
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

    return failureAuditService.executeWithRetryAndAudit({
      serviceName: 'ArgusReceiptProcessor',
      operationName: 'ingest_receipt',
      maxAttempts: 3,
      baseDelayMs: 800,
      payloadSummary: {
        store: data.storeTradingName,
        cnpj: data.storeCnpj,
        totalAmount: data.totalAmount,
        itemsCount: data.items.length,
        receiptNumber: data.receiptNumber ?? null,
        accessKey: data.accessKey,
        imageSha256: data.imageSha256 ?? null
      },
      fn: () => withArgusTransaction(async (client) => {
      // [2/3] Garante que a loja exista de forma canônica (respeitando store_aliases e variantes)
      logger.info({ rawStore: data.storeRawName }, '[2/3] [ArgusReceiptProcessor] Resolvendo mercado canônico');
      const canonicalStore = await this.storeNormalizer.resolveOrUpsertCanonicalStore(client, {
        cnpj: data.storeCnpj,
        rawName: data.storeRawName,
        tradingName: data.storeTradingName,
        address: data.storeAddress,
        latitude: env.HOME_LAT - 0.012,
        longitude: env.HOME_LNG - 0.015
      });
      const storeId = canonicalStore.storeId;

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
        const norm = await this.resolveOrCreateCanonicalProduct(
          item.rawDescription,
          item.unitType,
          client
        );

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

      logger.info(
        {
          elapsedMs: Date.now() - startedAt,
          receiptId,
          store: canonicalStore.canonicalTradingName,
          itemsProcessed: data.items.length,
          shrinkflationAlerts: shrinkflationAlerts.length
        },
        '[FIM] [ArgusReceiptProcessor] [3/3] Ingestão e normalização de itens concluídas'
      );

      return {
        receiptId,
        alreadyExisted: false,
        itemsProcessed: data.items.length,
        shrinkflationAlerts
      };
    })
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

  /**
   * Converte um registro salvo erroneamente em `argus.receipts` para coleta de Flyer (`MARKET_FLYER`),
   * preservando todos os preços dos itens em `argus.collected_prices` sem contabilizar como gasto real.
   */
  async convertReceiptToFlyer(receiptId: string): Promise<{
    converted: boolean;
    storeName: string;
    movedItemsCount: number;
  }> {
    return withArgusTransaction(async (client) => {
      const recRes = await client.query<{
        id: string;
        store_id: string;
        store_name: string;
        store_address: string | null;
        purchase_date: string;
      }>(
        `SELECT r.id, r.store_id, s.trading_name AS store_name, s.address AS store_address, r.purchase_date::text
         FROM argus.receipts r
         JOIN argus.stores s ON s.id = r.store_id
         WHERE r.id = $1
         LIMIT 1`,
        [receiptId]
      );

      if (recRes.rows.length === 0) {
        return { converted: false, storeName: '', movedItemsCount: 0 };
      }
      const rec = recRes.rows[0];

      const itemsRes = await client.query<{
        canonical_product_id: string;
        raw_description: string;
        canonical_product_name: string;
        category: string;
        unit_type: string;
        base_unit: string;
        standard_package_size: string;
        unit_price: string;
        normalized_price_per_base_unit: string;
      }>(
        `SELECT
           ri.canonical_product_id,
           ri.raw_description,
           cp.name AS canonical_product_name,
           cp.category,
           ri.unit_type,
           cp.base_unit,
           cp.standard_package_size::text,
           ri.unit_price::text,
           ri.normalized_price_per_base_unit::text
         FROM argus.receipt_items ri
         JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
         WHERE ri.receipt_id = $1`,
        [receiptId]
      );

      for (const it of itemsRes.rows) {
        await client.query(
          `INSERT INTO argus.collected_prices (
             store_id, canonical_product_id, source_type,
             store_name_detected, store_location_detected,
             raw_product_description, canonical_product_name, category,
             unit_type, base_unit, package_size_in_base_unit,
             collected_price, promo_club_price, normalized_price_per_base_unit,
             confidence_score_pct, missing_info_flags, confidence_explanation, collected_at
           ) VALUES ($1, $2, 'MARKET_FLYER', $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, 95, $13, $14, $15)`,
          [
            rec.store_id,
            it.canonical_product_id,
            rec.store_name,
            rec.store_address || 'Local do mercado',
            it.raw_description,
            it.canonical_product_name,
            it.category || 'Mercearia',
            it.unit_type || 'UN',
            it.base_unit || 'un',
            Number(it.standard_package_size) || 1,
            Number(it.unit_price) || 0,
            Number(it.normalized_price_per_base_unit) || 0,
            [],
            'Convertido manualmente de Nota Fiscal para Flyer pelo painel web',
            rec.purchase_date
          ]
        );
      }

      await client.query(`DELETE FROM argus.receipt_items WHERE receipt_id = $1`, [receiptId]);
      await client.query(`DELETE FROM argus.receipts WHERE id = $1`, [receiptId]);

      return {
        converted: true,
        storeName: rec.store_name,
        movedItemsCount: itemsRes.rows.length
      };
    });
  }

  private computeNormalizedUnitPrice(
    quantity: number,
    unitType: ReceiptUnitType,
    seenPackageSize: number,
    totalPrice: number,
    unitPrice: number
  ): number {
    const totalBaseUnits =
      unitType === 'KG' || unitType === 'LT'
        ? quantity * 1000
        : quantity * seenPackageSize;
    const norm = totalBaseUnits > 0 ? totalPrice / totalBaseUnits : unitPrice;
    return Number((Number.isFinite(norm) ? norm : 0).toFixed(6));
  }

  async updateReceiptDetails(
    receiptId: string,
    input: {
      storeName?: string;
      purchaseDate?: string;
      paymentMethod?: PaymentMethod;
      totalAmount?: number;
      discountAmount?: number;
      reconciled?: boolean;
    }
  ): Promise<{
    updated: boolean;
    storeId?: string;
    storeName?: string;
    storeAddress?: string;
    purchaseDate?: string;
    paymentMethod?: PaymentMethod;
    totalAmount?: number;
    discountAmount?: number;
    reconciled?: boolean;
  }> {
    return withArgusTransaction(async (client) => {
      const existing = await client.query<{
        id: string;
        store_id: string;
        purchase_date: string;
        payment_method: PaymentMethod;
        total_amount: string;
        discount_amount: string;
        reconciled: boolean;
      }>(
        `SELECT id, store_id, purchase_date::text, payment_method, total_amount::text, discount_amount::text, reconciled
         FROM argus.receipts
         WHERE id = $1`,
        [receiptId]
      );
      if (existing.rows.length === 0) {
        return { updated: false };
      }
      const cur = existing.rows[0];

      let storeId = cur.store_id;
      let resolvedStoreName: string | undefined;
      let resolvedStoreAddress: string | undefined;

      if (input.storeName && input.storeName.trim().length > 0) {
        const cleanStore = input.storeName.trim();
        const syntheticCnpj = this.normalizeStoreCnpj(undefined, cleanStore);
        const storeRes = await this.storeNormalizer.resolveOrUpsertCanonicalStore(client, {
          cnpj: syntheticCnpj,
          rawName: cleanStore,
          tradingName: cleanStore,
          address: 'Endereço não informado',
          latitude: env.HOME_LAT - 0.012,
          longitude: env.HOME_LNG - 0.015
        });
        storeId = storeRes.storeId;
        const addrRow = await client.query<{ trading_name: string; address: string }>(
          `SELECT trading_name, address FROM argus.stores WHERE id = $1`,
          [storeId]
        );
        resolvedStoreName = addrRow.rows[0]?.trading_name || cleanStore;
        resolvedStoreAddress = addrRow.rows[0]?.address;
      }

      const nextPurchaseDate = input.purchaseDate
        ? this.normalizeReceiptDate(input.purchaseDate)
        : new Date(cur.purchase_date).toISOString();
      const nextPaymentMethod = input.paymentMethod ?? cur.payment_method;
      const nextTotalAmount =
        input.totalAmount !== undefined
          ? Math.max(0, Number(Number(input.totalAmount).toFixed(2)))
          : Number(cur.total_amount);
      const nextDiscountAmount =
        input.discountAmount !== undefined
          ? Math.max(0, Number(Number(input.discountAmount).toFixed(2)))
          : Number(cur.discount_amount || 0);
      const nextReconciled =
        input.reconciled !== undefined ? Boolean(input.reconciled) : Boolean(cur.reconciled);

      await client.query(
        `UPDATE argus.receipts
         SET store_id = $2,
             purchase_date = $3,
             payment_method = $4,
             total_amount = $5,
             discount_amount = $6,
             reconciled = $7
         WHERE id = $1`,
        [
          receiptId,
          storeId,
          nextPurchaseDate,
          nextPaymentMethod,
          nextTotalAmount,
          nextDiscountAmount,
          nextReconciled
        ]
      );

      if (!resolvedStoreName) {
        const stRow = await client.query<{ trading_name: string; address: string }>(
          `SELECT trading_name, address FROM argus.stores WHERE id = $1`,
          [storeId]
        );
        resolvedStoreName = stRow.rows[0]?.trading_name;
        resolvedStoreAddress = stRow.rows[0]?.address;
      }

      return {
        updated: true,
        storeId,
        storeName: resolvedStoreName,
        storeAddress: resolvedStoreAddress,
        purchaseDate: nextPurchaseDate,
        paymentMethod: nextPaymentMethod,
        totalAmount: nextTotalAmount,
        discountAmount: nextDiscountAmount,
        reconciled: nextReconciled
      };
    });
  }

  async addReceiptItem(
    receiptId: string,
    input: {
      rawDescription: string;
      quantity: number;
      unitType: ReceiptUnitType;
      unitPrice: number;
      totalPrice?: number;
      recalculateTotal?: boolean;
    }
  ) {
    return withArgusTransaction(async (client) => {
      const recCheck = await client.query<{ id: string }>(
        `SELECT id FROM argus.receipts WHERE id = $1`,
        [receiptId]
      );
      if (recCheck.rows.length === 0) {
        return null;
      }

      const rawDesc = input.rawDescription.trim().toUpperCase();
      const qty = Math.max(0.001, Number(input.quantity) || 1);
      const unitType = input.unitType || 'UN';
      const unitPrice = Math.max(0, Number(input.unitPrice) || 0);
      const totalPrice =
        input.totalPrice !== undefined
          ? Math.max(0, Number(Number(input.totalPrice).toFixed(2)))
          : Number((qty * unitPrice).toFixed(2));

      const norm = await this.resolveOrCreateCanonicalProduct(rawDesc, unitType, client);
      const normalizedPricePerBaseUnit = this.computeNormalizedUnitPrice(
        qty,
        unitType,
        norm.seenPackageSize,
        totalPrice,
        unitPrice
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO argus.receipt_items (
           receipt_id, canonical_product_id, raw_description, quantity, unit_type, unit_price, total_price, normalized_price_per_base_unit
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          receiptId,
          norm.canonicalProductId,
          rawDesc,
          qty,
          unitType,
          unitPrice,
          totalPrice,
          normalizedPricePerBaseUnit
        ]
      );

      let newReceiptTotal: number | undefined;
      if (input.recalculateTotal) {
        const sumRes = await client.query<{ sum_total: string }>(
          `SELECT COALESCE(SUM(total_price), 0)::text AS sum_total FROM argus.receipt_items WHERE receipt_id = $1`,
          [receiptId]
        );
        newReceiptTotal = Number(Number(sumRes.rows[0]?.sum_total || 0).toFixed(2));
        await client.query(`UPDATE argus.receipts SET total_amount = $2 WHERE id = $1`, [
          receiptId,
          newReceiptTotal
        ]);
      }

      return {
        item: {
          id: inserted.rows[0].id,
          rawDescription: rawDesc,
          canonicalProductName: norm.canonicalName,
          category: norm.category,
          quantity: qty,
          unitType,
          unitPrice,
          totalPrice,
          baseUnit: norm.baseUnit,
          normalizedPricePerBaseUnit
        },
        newReceiptTotal
      };
    });
  }

  async updateReceiptItem(
    receiptId: string,
    itemId: string,
    input: {
      rawDescription: string;
      quantity: number;
      unitType: ReceiptUnitType;
      unitPrice: number;
      totalPrice?: number;
      recalculateTotal?: boolean;
    }
  ) {
    return withArgusTransaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM argus.receipt_items WHERE id = $1 AND receipt_id = $2`,
        [itemId, receiptId]
      );
      if (existing.rows.length === 0) {
        return null;
      }

      const rawDesc = input.rawDescription.trim().toUpperCase();
      const qty = Math.max(0.001, Number(input.quantity) || 1);
      const unitType = input.unitType || 'UN';
      const unitPrice = Math.max(0, Number(input.unitPrice) || 0);
      const totalPrice =
        input.totalPrice !== undefined
          ? Math.max(0, Number(Number(input.totalPrice).toFixed(2)))
          : Number((qty * unitPrice).toFixed(2));

      const norm = await this.resolveOrCreateCanonicalProduct(rawDesc, unitType, client);
      const normalizedPricePerBaseUnit = this.computeNormalizedUnitPrice(
        qty,
        unitType,
        norm.seenPackageSize,
        totalPrice,
        unitPrice
      );

      await client.query(
        `UPDATE argus.receipt_items
         SET canonical_product_id = $3,
             raw_description = $4,
             quantity = $5,
             unit_type = $6,
             unit_price = $7,
             total_price = $8,
             normalized_price_per_base_unit = $9
         WHERE id = $1 AND receipt_id = $2`,
        [
          itemId,
          receiptId,
          norm.canonicalProductId,
          rawDesc,
          qty,
          unitType,
          unitPrice,
          totalPrice,
          normalizedPricePerBaseUnit
        ]
      );

      let newReceiptTotal: number | undefined;
      if (input.recalculateTotal) {
        const sumRes = await client.query<{ sum_total: string }>(
          `SELECT COALESCE(SUM(total_price), 0)::text AS sum_total FROM argus.receipt_items WHERE receipt_id = $1`,
          [receiptId]
        );
        newReceiptTotal = Number(Number(sumRes.rows[0]?.sum_total || 0).toFixed(2));
        await client.query(`UPDATE argus.receipts SET total_amount = $2 WHERE id = $1`, [
          receiptId,
          newReceiptTotal
        ]);
      }

      return {
        item: {
          id: itemId,
          rawDescription: rawDesc,
          canonicalProductName: norm.canonicalName,
          category: norm.category,
          quantity: qty,
          unitType,
          unitPrice,
          totalPrice,
          baseUnit: norm.baseUnit,
          normalizedPricePerBaseUnit
        },
        newReceiptTotal
      };
    });
  }

  async deleteReceiptItem(
    receiptId: string,
    itemId: string,
    recalculateTotal = false
  ): Promise<{ deleted: boolean; newReceiptTotal?: number }> {
    return withArgusTransaction(async (client) => {
      const del = await client.query<{ id: string }>(
        `DELETE FROM argus.receipt_items WHERE id = $1 AND receipt_id = $2 RETURNING id`,
        [itemId, receiptId]
      );
      if (del.rows.length === 0) {
        return { deleted: false };
      }

      let newReceiptTotal: number | undefined;
      if (recalculateTotal) {
        const sumRes = await client.query<{ sum_total: string }>(
          `SELECT COALESCE(SUM(total_price), 0)::text AS sum_total FROM argus.receipt_items WHERE receipt_id = $1`,
          [receiptId]
        );
        newReceiptTotal = Number(Number(sumRes.rows[0]?.sum_total || 0).toFixed(2));
        await client.query(`UPDATE argus.receipts SET total_amount = $2 WHERE id = $1`, [
          receiptId,
          newReceiptTotal
        ]);
      }

      return { deleted: true, newReceiptTotal };
    });
  }
}
