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

export class ReceiptVisionClient {
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

          return outcome;
        } finally {
          clearTimeout(timer);
        }
      },
      fallbackValue: () => {
        logger.warn(
          { endpoint, elapsedMs: Date.now() - startedAt },
          '[FIM-FALLBACK] [ReceiptVisionClient] [2/2] 3 tentativas esgotadas (auditoria salva no banco); seguindo fallback local'
        );
        return null;
      }
    });
  }
}

export const receiptVisionClient = new ReceiptVisionClient();
