import crypto from 'node:crypto';
import sharp from 'sharp';
import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus, withArgusTransaction } from '../lib/db';
import { ArgusStorageService } from './ArgusStorageService';
import { ArgusReceiptProcessor } from './ArgusReceiptProcessor';
import { ArgusReconciliationService } from './ArgusReconciliationService';
import type { ReceiptUnitType } from '../types/argus';

export type MediaScanKind = 'RECEIPT_PHOTO' | 'SHELF_PHOTO' | 'MARKET_FLYER' | 'AISLE_VIDEO';

export type QueueJobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'QUEUED_RETRY'
  | 'FAILED_PERMANENT'
  | 'SKIPPED_DUPLICATE';

export interface ScannedProductCandidate {
  rawProductDescription: string;
  price: number;
  promoOrClubPrice?: number | null;
  unitType: ReceiptUnitType;
  estimatedPackageWeightOrVolume?: string | null;
  productVisualClarityPct: number; // 0-100 avaliado pelo modelo visual
  isProductIdentificationUncertain: boolean;
  uncertaintyReason?: string | null;
  videoTimestampSec?: number | null;
}

export interface MultimodalPriceScanExtraction {
  detectedMediaKind: MediaScanKind;
  isFiscalReceipt: boolean;
  storeNameDetected: string | null;
  storeNameAmbiguous: boolean;
  storeLocationDetected: string | null;
  flyerValidityDateDetected: string | null;
  generalVisualNotes: string;
  items: ScannedProductCandidate[];
}

export interface ProcessedPriceScanItem {
  id: string;
  rawProductDescription: string;
  canonicalProductName: string;
  category: string;
  collectedPrice: number;
  promoClubPrice: number | null;
  unitType: ReceiptUnitType;
  baseUnit: string;
  normalizedPricePerBaseUnit: number;
  confidenceScorePct: number;
  missingInfoFlags: string[];
  confidenceExplanation: string;
  videoTimestampSec: number | null;
}

export interface PriceScanProcessOutcome {
  queueJobId: string;
  status: QueueJobStatus;
  mediaKind: MediaScanKind;
  isFiscalReceipt: boolean;
  alreadyProcessedDuplicate?: boolean;
  duplicateJobId?: string;
  storageBucket: string;
  storagePath: string;
  storeNameDetected: string;
  storeLocationDetected: string | null;
  overallConfidencePct: number;
  confidenceWarnings: string[];
  items: ProcessedPriceScanItem[];
  errorMessage?: string;
  nextRetryAt?: string;
}

export class ArgusPriceScannerService {
  private readonly ai: GoogleGenAI | null;
  private readonly storage = new ArgusStorageService();
  private readonly receiptProcessor = new ArgusReceiptProcessor();
  private readonly reconciler = new ArgusReconciliationService();

  constructor() {
    this.ai = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;
  }

  /**
   * Executa chamada ao Gemini Multimodal (Imagem ou Vídeo) com cascata de modelos e timeout
   */
  private async generateMultimodalWithFallback(
    params: Parameters<GoogleGenAI['models']['generateContent']>[0],
    timeoutMsPerModel = 28000
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
          '[ArgusPriceScannerService] Tentando próximo modelo Gemini para coleta de preços'
        );
      }
    }
    throw lastError;
  }

  /**
   * Analisa foto de gôndola, panfleto/flyer ou vídeo de corredor de mercado via Gemini Multimodal
   */
  async analyzeMediaWithGemini(
    mediaBuffer: Buffer,
    mimeType: string,
    userCaption?: string
  ): Promise<MultimodalPriceScanExtraction> {
    let payloadBuffer = mediaBuffer;
    let payloadMime = mimeType;

    // Se for imagem, otimiza resolução para leitura nítida de etiquetas de prateleira/flyers
    if (mimeType.startsWith('image/')) {
      try {
        payloadBuffer = await sharp(mediaBuffer)
          .rotate()
          .resize({ width: 1600, height: 2200, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 84, mozjpeg: true })
          .toBuffer();
        payloadMime = 'image/jpeg';
      } catch {
        payloadBuffer = mediaBuffer;
      }
    }

    const captionHint = userCaption?.trim()
      ? `Dica informada pelo usuário na legenda do Telegram: "${userCaption.trim()}".`
      : 'O usuário NÃO enviou legenda informando o nome ou local da loja.';

    const isVideo = mimeType.startsWith('video/');

    const response = await this.generateMultimodalWithFallback(
      {
        model: env.GEMINI_MODEL,
        contents: [
          {
            inlineData: {
              data: payloadBuffer.toString('base64'),
              mimeType: payloadMime
            }
          },
          {
            text: [
              'Você é o Argus (@MonetaArgusBot), auditor de inteligência de preços de supermercado.',
              isVideo
                ? 'Analise todos os quadros deste VÍDEO gravado nos corredores do mercado (gôndolas/prateleiras) ou mostrando encartes.'
                : 'Analise esta IMAGEM e classifique se é um Cupom Fiscal (NFC-e/SAT de compra concluída) OU uma Coleta de Preços (Foto de Gôndola/Etiqueta de Prateleira ou Panfleto/Flyer de Mercado).',
              captionHint,
              'Extraia TODOS os produtos com preços visíveis. Avalie rigorosamente:',
              '1. Se o nome do mercado/loja está visível (na etiqueta, logo, encarte ou legenda) ou se é desconhecido/ambíguo.',
              '2. Se o endereço/filial/localização da loja está visível (fotos de gôndola quase nunca têm o endereço da filial).',
              '3. Para cada produto, informe o preço principal, eventual preço promocional/clube/atacado, a nitidez visual (0 a 100), se há incerteza no nome/marca/gramatura do produto (ex: borrado no vídeo, etiqueta cortada, reflexo) e, se for vídeo, o segundo aproximado (videoTimestampSec) em que aparece.'
            ].join(' ')
          }
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedMediaKind: {
                type: Type.STRING,
                enum: ['RECEIPT_PHOTO', 'SHELF_PHOTO', 'MARKET_FLYER', 'AISLE_VIDEO']
              },
              isFiscalReceipt: { type: Type.BOOLEAN },
              storeNameDetected: { type: Type.STRING },
              storeNameAmbiguous: { type: Type.BOOLEAN },
              storeLocationDetected: { type: Type.STRING },
              flyerValidityDateDetected: { type: Type.STRING },
              generalVisualNotes: { type: Type.STRING },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    rawProductDescription: { type: Type.STRING },
                    price: { type: Type.NUMBER },
                    promoOrClubPrice: { type: Type.NUMBER },
                    unitType: { type: Type.STRING, enum: ['KG', 'UN', 'LT'] },
                    estimatedPackageWeightOrVolume: { type: Type.STRING },
                    productVisualClarityPct: { type: Type.NUMBER },
                    isProductIdentificationUncertain: { type: Type.BOOLEAN },
                    uncertaintyReason: { type: Type.STRING },
                    videoTimestampSec: { type: Type.NUMBER }
                  },
                  required: [
                    'rawProductDescription',
                    'price',
                    'unitType',
                    'productVisualClarityPct',
                    'isProductIdentificationUncertain'
                  ]
                }
              }
            },
            required: [
              'detectedMediaKind',
              'isFiscalReceipt',
              'storeNameAmbiguous',
              'generalVisualNotes',
              'items'
            ]
          }
        }
      },
      isVideo ? 36000 : 22000
    );

    const parsed = JSON.parse(response.text || '{}') as MultimodalPriceScanExtraction;
    if (isVideo) {
      parsed.detectedMediaKind = 'AISLE_VIDEO';
      parsed.isFiscalReceipt = false;
    }
    return parsed;
  }

  /**
   * Calcula o Score de Confiabilidade (0% a 100%) e detalha todas as informações faltantes ou ambíguas
   */
  computeItemConfidence(
    extraction: MultimodalPriceScanExtraction,
    item: ScannedProductCandidate,
    resolvedStoreName: string | null,
    resolvedStoreLocation: string | null
  ): {
    confidenceScorePct: number;
    missingInfoFlags: string[];
    confidenceExplanation: string;
  } {
    let score = 100;
    const flags: string[] = [];
    const reasons: string[] = [];

    // 1. Verificação da Loja (Identificada vs. Ambígua vs. Ausente)
    if (!resolvedStoreName || /nao identificad|desconhecid|unknown|null/i.test(resolvedStoreName)) {
      score -= 25;
      flags.push('LOJA_NAO_IDENTIFICADA');
      reasons.push('Loja não identificada na mídia nem na legenda');
    } else if (extraction.storeNameAmbiguous) {
      score -= 12;
      flags.push('AMBIGUIDADE_NOME_LOJA');
      reasons.push(`Possível ambiguidade no nome da loja (${resolvedStoreName})`);
    }

    // 2. Verificação de Localização / Filial da Loja
    if (
      !resolvedStoreLocation ||
      /nao identificad|desconhecid|unknown|null/i.test(resolvedStoreLocation)
    ) {
      score -= 15;
      flags.push('LOCAL_FILIAL_AUSENTE');
      reasons.push('Localização/filial exata da loja ausente');
    }

    // 3. Verificação da Identificação do Produto / Marca / Gramatura
    if (item.isProductIdentificationUncertain) {
      score -= 18;
      flags.push('PRODUTO_IDENTIFICACAO_INCERTA');
      reasons.push(
        item.uncertaintyReason?.trim() ||
          'Nome completo, marca ou gramatura parcialmente ilegível na gôndola/vídeo'
      );
    } else if (
      !/\b\d+(?:[.,]\d+)?\s*(G|KG|ML|L|LT|UN)\b/i.test(item.rawProductDescription) &&
      item.unitType === 'UN'
    ) {
      score -= 8;
      flags.push('GRAMATURA_NAO_EXPLICITA');
      reasons.push('Peso/volume da embalagem não explícito na etiqueta');
    }

    // 4. Nitidez Visual do Quadro/Foto (Motion blur em vídeo de corredor, reflexo, distância)
    const clarity = Math.max(0, Math.min(100, Number(item.productVisualClarityPct || 80)));
    if (clarity < 75) {
      const clarityPenalty = Math.min(20, Math.round((80 - clarity) * 0.45));
      score -= clarityPenalty;
      flags.push('BAIXA_NITIDEZ_OU_MOVIMENTO');
      reasons.push(`Nitidez visual reduzida (${clarity}%) por movimento/distância`);
    }

    // 5. Dualidade de Preço (Clube/Atacado vs. Varejo)
    if (item.promoOrClubPrice && item.promoOrClubPrice > 0 && item.promoOrClubPrice !== item.price) {
      score -= 5;
      flags.push('PRECO_DUPLO_CLUBE_VAREJO');
      reasons.push(
        `Etiqueta com 2 preços (Normal R$ ${item.price.toFixed(2)} / Clube ou Atacado R$ ${item.promoOrClubPrice.toFixed(2)})`
      );
    }

    // 6. Panfleto sem data de validade da promoção
    if (
      extraction.detectedMediaKind === 'MARKET_FLYER' &&
      (!extraction.flyerValidityDateDetected ||
        /nao|unknown|null/i.test(extraction.flyerValidityDateDetected))
    ) {
      score -= 7;
      flags.push('VALIDADE_ENCARTE_AUSENTE');
      reasons.push('Data de validade do panfleto/flyer não visível');
    }

    const finalScore = Math.max(15, Math.min(98, Math.round(score)));
    const explanation =
      reasons.length > 0
        ? `Confiabilidade ${finalScore}% — Faltou/Ressalva: ${reasons.join('; ')}.`
        : `Confiabilidade ${finalScore}% — Loja, local e produto nítidos.`;

    return {
      confidenceScorePct: finalScore,
      missingInfoFlags: flags,
      confidenceExplanation: explanation
    };
  }

  /**
   * Registra a mídia na Tabela de Controle (`argus.media_processing_queue`), salva no bucket `FotosArgus`,
   * executa o processamento (com workaround de fila `QUEUED_RETRY` caso falhe) e persiste os preços coletados!
   */
  async ingestAndProcessPriceScanMedia(params: {
    mediaBuffer: Buffer;
    mimeType: string;
    initialMediaKind: MediaScanKind;
    telegramChatId: number;
    telegramMessageId?: number;
    telegramFileId?: string;
    telegramFileUniqueId?: string;
    userCaption?: string;
    existingQueueJobId?: string;
  }): Promise<PriceScanProcessOutcome> {
    const mediaSha256 = crypto.createHash('sha256').update(params.mediaBuffer).digest('hex');

    // 1. Verifica se essa exata mídia já foi processada com sucesso anteriormente na tabela de controle
    if (!params.existingQueueJobId) {
      const existingJob = await queryArgus<{
        id: string;
        status: QueueJobStatus;
        media_kind: MediaScanKind;
        storage_bucket: string;
        storage_path: string;
        store_name_detected: string | null;
        store_location_detected: string | null;
        overall_confidence_pct: string | null;
        items_extracted_count: number;
      }>(
        `SELECT id, status, media_kind, storage_bucket, storage_path, store_name_detected,
                store_location_detected, overall_confidence_pct::text, items_extracted_count
         FROM argus.media_processing_queue
         WHERE media_sha256 = $1 AND status = 'SUCCEEDED'
         LIMIT 1`,
        [mediaSha256]
      );

      if (existingJob.length > 0) {
        const job = existingJob[0];
        return {
          queueJobId: job.id,
          status: 'SKIPPED_DUPLICATE',
          mediaKind: job.media_kind,
          isFiscalReceipt: false,
          alreadyProcessedDuplicate: true,
          duplicateJobId: job.id,
          storageBucket: job.storage_bucket,
          storagePath: job.storage_path || '',
          storeNameDetected: job.store_name_detected || 'Loja Não Identificada',
          storeLocationDetected: job.store_location_detected,
          overallConfidencePct: Number(job.overall_confidence_pct || 0),
          confidenceWarnings: [
            `Esta mesma mídia (SHA-256 ${mediaSha256.slice(0, 10)}...) já foi processada com sucesso no job #${job.id.slice(0, 8)} (${job.items_extracted_count} produtos coletados).`
          ],
          items: []
        };
      }
    }

    // 2. Salva IMEDIATAMENTE a imagem ou vídeo no bucket `FotosArgus` ANTES do processamento de IA
    //    (garante que se a IA falhar, o arquivo já está seguro no bucket para reprocessamento futuro!)
    const uploadRes = await this.storage.uploadPriceScanMedia(
      params.mediaBuffer,
      mediaSha256.slice(0, 20),
      params.initialMediaKind === 'AISLE_VIDEO' ? 'AISLE_VIDEO' : 'SHELF_PHOTO',
      params.mimeType
    );

    // 3. Cria ou atualiza o registro na Tabela de Controle (`argus.media_processing_queue`) com status PROCESSING
    let queueJobId = params.existingQueueJobId;
    if (!queueJobId) {
      const inserted = await queryArgus<{ id: string }>(
        `INSERT INTO argus.media_processing_queue (
           telegram_chat_id, telegram_message_id, telegram_file_id, telegram_file_unique_id,
           media_kind, mime_type, user_caption, storage_bucket, storage_path,
           original_size_bytes, compressed_size_bytes, media_sha256, status, attempts_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PROCESSING', 1)
         RETURNING id`,
        [
          params.telegramChatId,
          params.telegramMessageId ?? null,
          params.telegramFileId ?? null,
          params.telegramFileUniqueId ?? null,
          params.initialMediaKind,
          params.mimeType,
          params.userCaption ?? null,
          uploadRes.bucket,
          uploadRes.storagePath,
          uploadRes.originalBytes,
          uploadRes.compressedBytes,
          mediaSha256
        ]
      );
      queueJobId = inserted[0].id;
    } else {
      await queryArgus(
        `UPDATE argus.media_processing_queue
         SET status = 'PROCESSING',
             attempts_count = attempts_count + 1,
             storage_path = COALESCE(storage_path, $2)
         WHERE id = $1`,
        [queueJobId, uploadRes.storagePath]
      );
    }

    try {
      // 4. Chama o Gemini Multimodal para analisar a foto/vídeo
      const extraction = await this.analyzeMediaWithGemini(
        params.mediaBuffer,
        params.mimeType,
        params.userCaption
      );

      // Se a mídia era uma foto e a IA detectou que na verdade é um Cupom Fiscal (NFC-e/SAT),
      // sinaliza para o bot delegar ao fluxo de Cupom Fiscal!
      if (extraction.isFiscalReceipt && !params.mimeType.startsWith('video/')) {
        await queryArgus(
          `UPDATE argus.media_processing_queue
           SET media_kind = 'RECEIPT_PHOTO',
               status = 'SUCCEEDED',
               processed_at = NOW(),
               result_summary = $2::jsonb
           WHERE id = $1`,
          [queueJobId, JSON.stringify({ delegatedToReceiptFlow: true })]
        );
        return {
          queueJobId,
          status: 'SUCCEEDED',
          mediaKind: 'RECEIPT_PHOTO',
          isFiscalReceipt: true,
          storageBucket: uploadRes.bucket,
          storagePath: uploadRes.storagePath,
          storeNameDetected: extraction.storeNameDetected || 'Cupom Fiscal',
          storeLocationDetected: extraction.storeLocationDetected,
          overallConfidencePct: 100,
          confidenceWarnings: [],
          items: []
        };
      }

      if (!extraction.items || extraction.items.length === 0) {
        throw new Error(
          'Nenhum produto com etiqueta de preço legível pôde ser extraído desta mídia.'
        );
      }

      // Resolve loja a partir da legenda do usuário ou da detecção visual
      const captionStoreMatch = params.userCaption
        ?.trim()
        .match(/^(?:loja|mercado|supermercado)?\s*[:\-]?\s*([A-Za-zÀ-ÿ0-9\s.'-]{3,45})/i);
      const rawStoreName =
        extraction.storeNameDetected &&
        !/^(null|undefined|n\/a|none|desconhecido|nao identificado)$/i.test(
          extraction.storeNameDetected.trim()
        )
          ? extraction.storeNameDetected.trim()
          : captionStoreMatch
            ? captionStoreMatch[1].trim()
            : null;

      const storeNameLabel = rawStoreName || 'Loja Não Identificada';
      const rawLocation =
        extraction.storeLocationDetected &&
        !/^(null|undefined|n\/a|none|desconhecido|nao identificado)$/i.test(
          extraction.storeLocationDetected.trim()
        )
          ? extraction.storeLocationDetected.trim()
          : null;

      // Se o nome da loja foi identificado, garante vínculo em `argus.stores` para alimentar as views de preços!
      let storeId: string | null = null;
      if (rawStoreName) {
        const syntheticCnpj = this.receiptProcessor.normalizeStoreCnpj(undefined, rawStoreName);
        const stRows = await queryArgus<{ id: string }>(
          `INSERT INTO argus.stores (cnpj, raw_name, trading_name, address, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (cnpj) DO UPDATE SET
             trading_name = EXCLUDED.trading_name
           RETURNING id`,
          [
            syntheticCnpj,
            rawStoreName,
            rawStoreName,
            rawLocation || 'Localização pendente (Coleta de Gôndola/Flyer)',
            env.HOME_LAT - 0.01,
            env.HOME_LNG - 0.01
          ]
        );
        storeId = stRows[0]?.id ?? null;
      }

      const processedItems: ProcessedPriceScanItem[] = [];
      const allWarningsSet = new Set<string>();

      for (const rawItem of extraction.items) {
        if (!rawItem.rawProductDescription || !(rawItem.price > 0)) continue;

        const descWithWeight =
          rawItem.estimatedPackageWeightOrVolume &&
          !rawItem.rawProductDescription.includes(rawItem.estimatedPackageWeightOrVolume)
            ? `${rawItem.rawProductDescription} ${rawItem.estimatedPackageWeightOrVolume}`.trim()
            : rawItem.rawProductDescription.trim();

        const normProd = await this.receiptProcessor.resolveOrCreateCanonicalProduct(
          descWithWeight,
          rawItem.unitType || 'UN'
        );

        const totalBaseUnits =
          rawItem.unitType === 'KG' || rawItem.unitType === 'LT'
            ? 1000
            : Math.max(1, normProd.seenPackageSize);

        const effectivePrice = Number(rawItem.price.toFixed(2));
        const promoPrice =
          rawItem.promoOrClubPrice && rawItem.promoOrClubPrice > 0
            ? Number(rawItem.promoOrClubPrice.toFixed(2))
            : null;
        const normalizedPricePerBaseUnit = Number((effectivePrice / totalBaseUnits).toFixed(6));

        const conf = this.computeItemConfidence(
          extraction,
          rawItem,
          rawStoreName,
          rawLocation
        );

        for (const f of conf.missingInfoFlags) {
          allWarningsSet.add(f);
        }

        const insertedItem = await queryArgus<{ id: string }>(
          `INSERT INTO argus.collected_prices (
             queue_job_id, store_id, canonical_product_id, source_type,
             store_name_detected, store_location_detected,
             raw_product_description, canonical_product_name, category,
             unit_type, base_unit, package_size_in_base_unit,
             collected_price, promo_club_price, normalized_price_per_base_unit,
             confidence_score_pct, missing_info_flags, confidence_explanation, video_timestamp_sec
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING id`,
          [
            queueJobId,
            storeId,
            normProd.canonicalProductId,
            extraction.detectedMediaKind === 'RECEIPT_PHOTO'
              ? 'SHELF_PHOTO'
              : extraction.detectedMediaKind,
            storeNameLabel,
            rawLocation,
            descWithWeight,
            normProd.canonicalName,
            normProd.category,
            rawItem.unitType || 'UN',
            normProd.baseUnit,
            totalBaseUnits,
            effectivePrice,
            promoPrice,
            normalizedPricePerBaseUnit,
            conf.confidenceScorePct,
            conf.missingInfoFlags,
            conf.confidenceExplanation,
            rawItem.videoTimestampSec ?? null
          ]
        );

        processedItems.push({
          id: insertedItem[0].id,
          rawProductDescription: descWithWeight,
          canonicalProductName: normProd.canonicalName,
          category: normProd.category,
          collectedPrice: effectivePrice,
          promoClubPrice: promoPrice,
          unitType: rawItem.unitType || 'UN',
          baseUnit: normProd.baseUnit,
          normalizedPricePerBaseUnit,
          confidenceScorePct: conf.confidenceScorePct,
          missingInfoFlags: conf.missingInfoFlags,
          confidenceExplanation: conf.confidenceExplanation,
          videoTimestampSec: rawItem.videoTimestampSec ?? null
        });
      }

      const overallConfidencePct =
        processedItems.length > 0
          ? Number(
              (
                processedItems.reduce((acc, it) => acc + it.confidenceScorePct, 0) /
                processedItems.length
              ).toFixed(1)
            )
          : 0;

      const warningsList = Array.from(allWarningsSet);

      await queryArgus(
        `UPDATE argus.media_processing_queue
         SET status = 'SUCCEEDED',
             media_kind = $2,
             store_name_detected = $3,
             store_location_detected = $4,
             overall_confidence_pct = $5,
             confidence_warnings = $6,
             items_extracted_count = $7,
             processed_at = NOW(),
             last_error = NULL,
             result_summary = $8::jsonb
         WHERE id = $1`,
        [
          queueJobId,
          extraction.detectedMediaKind,
          storeNameLabel,
          rawLocation,
          overallConfidencePct,
          warningsList,
          processedItems.length,
          JSON.stringify({
            generalVisualNotes: extraction.generalVisualNotes,
            flyerValidityDateDetected: extraction.flyerValidityDateDetected
          })
        ]
      );

      // Sincroniza a planilha de Preços Coletados ("Precos_Coletados") e o espelho local
      await this.reconciler.reconcileAndSyncSheets().catch((err) => {
        logger.warn({ err }, '[ArgusPriceScannerService] Aviso ao sincronizar planilha após coleta');
      });

      return {
        queueJobId,
        status: 'SUCCEEDED',
        mediaKind: extraction.detectedMediaKind,
        isFiscalReceipt: false,
        storageBucket: uploadRes.bucket,
        storagePath: uploadRes.storagePath,
        storeNameDetected: storeNameLabel,
        storeLocationDetected: rawLocation,
        overallConfidencePct,
        confidenceWarnings: warningsList,
        items: processedItems
      };
    } catch (err) {
      // WORKAROUND & FILA DE REPROCESSAMENTO:
      // Caso ocorra erro na IA, timeout ou falha de leitura, mantém a imagem/vídeo salva no bucket FotosArgus
      // e agenda nova tentativa automática na fila (`QUEUED_RETRY`)!
      const errMsg = (err as Error).message || 'Erro desconhecido no processamento multimodal';
      const jobState = await queryArgus<{ attempts_count: number; max_attempts: number }>(
        `SELECT attempts_count, max_attempts FROM argus.media_processing_queue WHERE id = $1`,
        [queueJobId]
      );
      const attempts = jobState[0]?.attempts_count ?? 1;
      const maxAttempts = jobState[0]?.max_attempts ?? 5;
      const isPermanent = attempts >= maxAttempts;

      // Backoff progressivo: 15 min na 1ª falha, 30 min na 2ª, 60 min nas seguintes
      const retryMinutes = attempts === 1 ? 15 : attempts === 2 ? 30 : 60;
      const nextRetryAt = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString();
      const newStatus: QueueJobStatus = isPermanent ? 'FAILED_PERMANENT' : 'QUEUED_RETRY';

      await queryArgus(
        `UPDATE argus.media_processing_queue
         SET status = $2,
             last_error = $3,
             next_retry_at = $4
         WHERE id = $1`,
        [queueJobId, newStatus, errMsg.slice(0, 500), isPermanent ? null : nextRetryAt]
      );

      logger.warn(
        { queueJobId, newStatus, attempts, nextRetryAt, errMsg },
        '[ArgusPriceScannerService] Mídia guardada na fila argus.media_processing_queue para nova tentativa'
      );

      return {
        queueJobId,
        status: newStatus,
        mediaKind: params.initialMediaKind,
        isFiscalReceipt: false,
        storageBucket: uploadRes.bucket,
        storagePath: uploadRes.storagePath,
        storeNameDetected: 'Pendente (Na Fila)',
        storeLocationDetected: null,
        overallConfidencePct: 0,
        confidenceWarnings: [],
        items: [],
        errorMessage: errMsg,
        nextRetryAt: isPermanent ? undefined : nextRetryAt
      };
    }
  }

  /**
   * Permite atualizar manualmente o nome/local da loja de uma coleta já realizada,
   * recalculando e elevando o Score de Confiabilidade dos produtos daquele lote!
   */
  async assignStoreToQueueJob(
    queueJobId: string,
    storeName: string,
    storeLocation?: string
  ): Promise<{ updatedItemsCount: number; newConfidencePct: number }> {
    const cleanStore = storeName.trim();
    const cleanLoc = storeLocation?.trim() || null;
    const syntheticCnpj = this.receiptProcessor.normalizeStoreCnpj(undefined, cleanStore);

    return withArgusTransaction(async (client) => {
      const stRes = await client.query<{ id: string }>(
        `INSERT INTO argus.stores (cnpj, raw_name, trading_name, address, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (cnpj) DO UPDATE SET
           trading_name = EXCLUDED.trading_name,
           address = COALESCE($4, argus.stores.address)
         RETURNING id`,
        [
          syntheticCnpj,
          cleanStore,
          cleanStore,
          cleanLoc || 'Endereço confirmado pelo auditor',
          env.HOME_LAT - 0.01,
          env.HOME_LNG - 0.01
        ]
      );
      const storeId = stRes.rows[0].id;

      // Eleva o score de confiabilidade (+25% se estava sem loja, +15% se informou local)
      const boost = cleanLoc ? 35 : 22;
      const updated = await client.query<{ confidence_score_pct: string }>(
        `UPDATE argus.collected_prices
         SET store_id = $2,
             store_name_detected = $3,
             store_location_detected = COALESCE($4, store_location_detected),
             confidence_score_pct = LEAST(98, confidence_score_pct + $5),
             missing_info_flags = array_remove(array_remove(missing_info_flags, 'LOJA_NAO_IDENTIFICADA'), 'AMBIGUIDADE_NOME_LOJA'),
             confidence_explanation = 'Loja confirmada pelo usuário (' || $3 || '). ' || confidence_explanation
         WHERE queue_job_id = $1
         RETURNING confidence_score_pct::text`,
        [queueJobId, storeId, cleanStore, cleanLoc, boost]
      );

      const newAvg =
        updated.rows.length > 0
          ? Number(
              (
                updated.rows.reduce((a, r) => a + Number(r.confidence_score_pct), 0) /
                updated.rows.length
              ).toFixed(1)
            )
          : 90;

      await client.query(
        `UPDATE argus.media_processing_queue
         SET store_name_detected = $2,
             store_location_detected = COALESCE($3, store_location_detected),
             overall_confidence_pct = $4,
             confidence_warnings = array_remove(array_remove(confidence_warnings, 'LOJA_NAO_IDENTIFICADA'), 'AMBIGUIDADE_NOME_LOJA')
         WHERE id = $1`,
        [queueJobId, cleanStore, cleanLoc, newAvg]
      );

      return {
        updatedItemsCount: updated.rows.length,
        newConfidencePct: newAvg
      };
    });
  }

  /**
   * Busca itens pendentes na fila (`QUEUED_RETRY`) cujo horário `next_retry_at` já chegou
   * (ou todos os `QUEUED_RETRY` quando `forceNow = true`) e tenta reprocessá-los!
   */
  async processDueQueueJobs(
    downloadViaTelegramFileId: (fileId: string) => Promise<Buffer | null>,
    forceNow = false
  ): Promise<PriceScanProcessOutcome[]> {
    const dueJobs = await queryArgus<{
      id: string;
      telegram_chat_id: string;
      telegram_message_id: string | null;
      telegram_file_id: string | null;
      telegram_file_unique_id: string | null;
      media_kind: MediaScanKind;
      mime_type: string | null;
      user_caption: string | null;
      storage_path: string | null;
    }>(
      forceNow
        ? `SELECT id, telegram_chat_id::text, telegram_message_id::text, telegram_file_id,
                  telegram_file_unique_id, media_kind, mime_type, user_caption, storage_path
           FROM argus.media_processing_queue
           WHERE status IN ('QUEUED_RETRY', 'PENDING')
           ORDER BY created_at ASC
           LIMIT 5`
        : `SELECT id, telegram_chat_id::text, telegram_message_id::text, telegram_file_id,
                  telegram_file_unique_id, media_kind, mime_type, user_caption, storage_path
           FROM argus.media_processing_queue
           WHERE status = 'QUEUED_RETRY'
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           ORDER BY next_retry_at ASC
           LIMIT 3`
    );

    const outcomes: PriceScanProcessOutcome[] = [];

    for (const job of dueJobs) {
      // 1. Tenta baixar primeiro do bucket `FotosArgus` (onde salvamos na entrada)
      let buffer: Buffer | null = null;
      if (job.storage_path) {
        buffer = await this.storage.downloadFromStorage(job.storage_path);
      }
      // 2. Fallback: baixa novamente dos servidores do Telegram via `telegram_file_id`
      if (!buffer && job.telegram_file_id) {
        buffer = await downloadViaTelegramFileId(job.telegram_file_id);
      }

      if (!buffer) {
        await queryArgus(
          `UPDATE argus.media_processing_queue
           SET status = 'FAILED_PERMANENT',
               last_error = 'Arquivo não encontrado no bucket FotosArgus nem no Telegram para reprocessamento.'
           WHERE id = $1`,
          [job.id]
        );
        continue;
      }

      const outcome = await this.ingestAndProcessPriceScanMedia({
        mediaBuffer: buffer,
        mimeType: job.mime_type || 'image/jpeg',
        initialMediaKind: job.media_kind,
        telegramChatId: Number(job.telegram_chat_id),
        telegramMessageId: job.telegram_message_id ? Number(job.telegram_message_id) : undefined,
        telegramFileId: job.telegram_file_id ?? undefined,
        telegramFileUniqueId: job.telegram_file_unique_id ?? undefined,
        userCaption: job.user_caption ?? undefined,
        existingQueueJobId: job.id
      });

      outcomes.push(outcome);
    }

    return outcomes;
  }

  /**
   * Retorna resumo da Tabela de Controle (`argus.media_processing_queue`) e últimos preços coletados
   */
  async getQueueAndCollectedSummary() {
    const [statsRows, recentJobs, recentPrices] = await Promise.all([
      queryArgus<{
        succeeded_count: number;
        queued_retry_count: number;
        failed_count: number;
        total_collected_items: number;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded_count,
           COUNT(*) FILTER (WHERE status IN ('QUEUED_RETRY', 'PENDING', 'PROCESSING'))::int AS queued_retry_count,
           COUNT(*) FILTER (WHERE status = 'FAILED_PERMANENT')::int AS failed_count,
           (SELECT COUNT(*)::int FROM argus.collected_prices) AS total_collected_items
         FROM argus.media_processing_queue`
      ),
      queryArgus<{
        id: string;
        media_kind: string;
        status: string;
        store_name_detected: string | null;
        overall_confidence_pct: string | null;
        items_extracted_count: number;
        attempts_count: number;
        next_retry_at: string | null;
        last_error: string | null;
        created_at: string;
      }>(
        `SELECT id, media_kind, status, store_name_detected, overall_confidence_pct::text,
                items_extracted_count, attempts_count, next_retry_at::text, last_error, created_at::text
         FROM argus.media_processing_queue
         ORDER BY created_at DESC
         LIMIT 8`
      ),
      queryArgus<{
        canonical_product_name: string;
        store_name_detected: string;
        collected_price: string;
        promo_club_price: string | null;
        confidence_score_pct: string;
        confidence_explanation: string;
        source_type: string;
        collected_at: string;
      }>(
        `SELECT canonical_product_name, store_name_detected, collected_price::text,
                promo_club_price::text, confidence_score_pct::text, confidence_explanation,
                source_type, collected_at::text
         FROM argus.collected_prices
         ORDER BY collected_at DESC
         LIMIT 8`
      )
    ]);

    return {
      stats: statsRows[0] || {
        succeeded_count: 0,
        queued_retry_count: 0,
        failed_count: 0,
        total_collected_items: 0
      },
      recentJobs,
      recentPrices
    };
  }
}
