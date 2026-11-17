import { env } from '../config/env';
import { logger } from '../config/logger';
import { failureAuditService } from './ArgusFailureAuditService';

export interface VisionQualityReport {
  part_index: number;
  width: number;
  height: number;
  blur_score: number;
  is_blurry: boolean;
  detected_rotation_deg: number;
  deskew_angle_deg: number;
  cropped_document: boolean;
  contrast_recovered: boolean;
  warnings: string[];
}

export interface VisionStitchSummary {
  parts_received: number;
  ordered_indices: number[];
  stitch_mode: 'single' | 'feature_overlap' | 'sequential_fallback';
  overlaps_detected: number;
  deduplicated_items_count: number;
}

export interface VisionMathValidation {
  items_sum: number;
  expected_total: number;
  declared_total: number;
  discrepancy_brl: number;
  is_consistent: boolean;
  confidence_warning: boolean;
  suspect_items: string[];
}

export interface VisionProcessOutcome {
  enhancedImageBuffer: Buffer | null;
  binaryImageBuffer: Buffer | null;
  qrCodeUrl: string | null;
  sefazAccessKey: string | null;
  documentType: string;
  qualityReports: VisionQualityReport[];
  stitchSummary: VisionStitchSummary;
  mathValidation: VisionMathValidation;
  rawOcrText: string | null;
}

interface RawVisionApiResponse {
  status: string;
  quality_reports?: VisionQualityReport[];
  stitch_summary?: VisionStitchSummary;
  header?: {
    document_type?: string;
  };
  totals?: {
    sefaz_access_key?: string | null;
    qr_code_url?: string | null;
  };
  math_validation?: VisionMathValidation;
  final_image_base64?: string | null;
  final_binary_base64?: string | null;
  raw_ocr_text?: string | null;
}

export interface VideoShelfItemResult {
  item_id: string;
  nome_produto: string;
  preco_regular: number | null;
  preco_promocional: number | null;
  confianca_deteccao: number;
  confianca_ocr: number;
  timestamp_melhor_frame: number;
  filtros_aplicados: string[];
}

export interface VideoShelfAnalysisResult {
  job_id: string;
  status: 'processing' | 'completed' | 'failed';
  metadata?: {
    duration_sec: number;
    fps: number;
    total_frames: number;
    sampled_keyframes: number;
    discarded_blur_frames: number;
    detector_engine: string;
  } | null;
  items: VideoShelfItemResult[];
}

export class ReceiptVisionClient {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly circuitCooldownMs = 5 * 60 * 1000;

  isEnabled(): boolean {
    return Boolean(env.RECEIPT_VISION_API_URL);
  }

  /**
   * Envia 1 ou múltiplas partes da mesma nota fiscal para o microsserviço OpenCV
   * (crop 4 pontos, correção 180°, deskew, remoção de sombras/bleed-through, CLAHE,
   * costura vertical SIFT/AKAZE e decodificação de QR Code).
   * Retorna null em caso de indisponibilidade para manter fallback transparente.
   */
  async processImages(
    images: Array<{ buffer: Buffer; mimeType?: string; filename?: string }>
  ): Promise<VisionProcessOutcome | null> {
    if (!this.isEnabled() || images.length === 0) {
      return null;
    }

    if (Date.now() < this.circuitOpenUntil) {
      logger.warn(
        { retryAfterSec: Math.ceil((this.circuitOpenUntil - Date.now()) / 1000) },
        '[ReceiptVisionClient] Circuit breaker aberto (OpenCV indisponível); usando fallback local imediato'
      );
      return null;
    }

    const endpoint = `${env.RECEIPT_VISION_API_URL}/v1/receipts/process`;
    const totalBytes = images.reduce((acc, im) => acc + im.buffer.length, 0);
    const startedAt = Date.now();
    logger.info(
      { endpoint, parts: images.length, totalBytes },
      '[INÍCIO] [ReceiptVisionClient] [1/2] Enviando imagem(ns) para microsserviço OpenCV (até 3 tentativas)'
    );

    const buildFormData = () => {
      const form = new FormData();
      images.forEach((img, idx) => {
        const mime = img.mimeType || 'image/jpeg';
        const ext = mime.includes('png') ? 'png' : 'jpg';
        const name = img.filename || `receipt_part_${idx + 1}.${ext}`;
        const blob = new Blob([new Uint8Array(img.buffer)], { type: mime });
        form.append('files', blob, name);
      });
      form.append('include_images_base64', 'true');
      form.append('extract_semantic', 'false');
      form.append('async_mode', 'false');
      return form;
    };

    return failureAuditService.executeWithRetryAndAudit<VisionProcessOutcome | null>({
      serviceName: 'ReceiptVisionClient',
      operationName: 'opencv_preprocess',
      maxAttempts: 3,
      baseDelayMs: 1200,
      endpointUrl: endpoint,
      payloadSummary: {
        parts: images.length,
        totalBytes,
        filenames: images.map((im, i) => im.filename || `part_${i + 1}`),
        mimeTypes: images.map((im) => im.mimeType || 'image/jpeg')
      },
      extractHttpStatus: (err) =>
        err && typeof err === 'object' && 'httpStatus' in err
          ? Number((err as { httpStatus: number }).httpStatus)
          : null,
      fn: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), env.RECEIPT_VISION_TIMEOUT_MS);

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            body: buildFormData(),
            signal: controller.signal
          });

          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            const httpErr = new Error(
              `HTTP ${res.status} de ${endpoint}: ${errBody.slice(0, 220)}`
            ) as Error & { httpStatus?: number };
            httpErr.httpStatus = res.status;
            throw httpErr;
          }

          const data = (await res.json()) as RawVisionApiResponse;
          const outcome: VisionProcessOutcome = {
            enhancedImageBuffer: data.final_image_base64
              ? Buffer.from(data.final_image_base64, 'base64')
              : null,
            binaryImageBuffer: data.final_binary_base64
              ? Buffer.from(data.final_binary_base64, 'base64')
              : null,
            qrCodeUrl: data.totals?.qr_code_url ?? null,
            sefazAccessKey: data.totals?.sefaz_access_key ?? null,
            documentType: data.header?.document_type ?? 'unknown',
            qualityReports: Array.isArray(data.quality_reports) ? data.quality_reports : [],
            stitchSummary: data.stitch_summary ?? {
              parts_received: images.length,
              ordered_indices: images.map((_, i) => i),
              stitch_mode: images.length > 1 ? 'sequential_fallback' : 'single',
              overlaps_detected: 0,
              deduplicated_items_count: 0
            },
            mathValidation: data.math_validation ?? {
              items_sum: 0,
              expected_total: 0,
              declared_total: 0,
              discrepancy_brl: 0,
              is_consistent: true,
              confidence_warning: false,
              suspect_items: []
            },
            rawOcrText: data.raw_ocr_text ?? null
          };

          logger.info(
            {
              elapsedMs: Date.now() - startedAt,
              stitchMode: outcome.stitchSummary.stitch_mode,
              overlaps: outcome.stitchSummary.overlaps_detected,
              hasQrUrl: Boolean(outcome.qrCodeUrl),
              hasSefazKey: Boolean(outcome.sefazAccessKey),
              docType: outcome.documentType
            },
            '[FIM] [ReceiptVisionClient] [2/2] Pré-processamento OpenCV concluído com sucesso'
          );

          this.consecutiveFailures = 0;
          this.circuitOpenUntil = 0;
          return outcome;
        } finally {
          clearTimeout(timer);
        }
      },
      fallbackValue: () => {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= 2) {
          this.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
        }
        logger.warn(
          {
            endpoint,
            elapsedMs: Date.now() - startedAt,
            consecutiveFailures: this.consecutiveFailures,
            circuitOpenMin: this.consecutiveFailures >= 2 ? 5 : 0
          },
          '[FIM-FALLBACK] [ReceiptVisionClient] [2/2] 3 tentativas esgotadas (auditoria salva no banco); seguindo fallback local'
        );
        return null;
      }
    });
  }

  /**
   * Envia vídeo de gôndola (.mp4/.mov/.avi) para o pipeline OpenCV (Anti-Blur + CLAHE LAB + Tracking)
   * em POST /api/v1/videos/analyze e acompanha o job até concluir.
   */
  async analyzeShelfVideo(
    videoBuffer: Buffer,
    mimeType = 'video/mp4',
    filename = 'shelf_video.mp4'
  ): Promise<VideoShelfAnalysisResult | null> {
    if (!this.isEnabled()) return null;

    const analyzeUrl = `${env.RECEIPT_VISION_API_URL}/api/v1/videos/analyze`;
    const startedAt = Date.now();
    logger.info(
      { analyzeUrl, bytes: videoBuffer.length, mimeType },
      '[INÍCIO] [ReceiptVisionClient] [1/2] Enviando vídeo de gôndola para análise OpenCV'
    );

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(videoBuffer)], { type: mimeType }), filename);

    try {
      const submitRes = await fetch(analyzeUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(env.RECEIPT_VISION_TIMEOUT_MS)
      });
      if (!submitRes.ok) {
        logger.warn({ status: submitRes.status }, '[ReceiptVisionClient] Falha ao enviar vídeo');
        return null;
      }
      const submitted = (await submitRes.json()) as { job_id: string };
      const statusUrl = `${env.RECEIPT_VISION_API_URL}/api/v1/videos/status/${submitted.job_id}`;

      // Polling leve por até 45s
      for (let i = 0; i < 18; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const pollRes = await fetch(statusUrl, { signal: AbortSignal.timeout(10000) });
        if (!pollRes.ok) continue;
        const statusData = (await pollRes.json()) as VideoShelfAnalysisResult;
        if (statusData.status === 'completed') {
          logger.info(
            {
              elapsedMs: Date.now() - startedAt,
              keyframes: statusData.metadata?.sampled_keyframes,
              discardedBlur: statusData.metadata?.discarded_blur_frames,
              items: statusData.items.length
            },
            '[FIM] [ReceiptVisionClient] [2/2] Análise de vídeo de gôndola concluída'
          );
          return statusData;
        }
        if (statusData.status === 'failed') {
          return null;
        }
      }
      return null;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[ReceiptVisionClient] Erro no pipeline de vídeo OpenCV; seguindo fallback Gemini'
      );
      return null;
    }
  }
}

export const receiptVisionClient = new ReceiptVisionClient();
