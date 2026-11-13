import sharp from 'sharp';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  downloadObjectFromSupabaseStorage,
  uploadObjectToSupabaseStorage
} from '../lib/supabase-storage';

export interface CompressedUploadResult {
  uploaded: boolean;
  bucket: string;
  storagePath: string;
  originalBytes: number;
  compressedBytes: number;
  compressionSavingsPct: number;
  contentType: string;
  signedUrl?: string;
  uploadError?: string;
}

/**
 * Serviço de Compressão Ultra-Eficiente e Arquivamento no Supabase Storage (`FotosArgus`).
 * - Usa SDK oficial + fallback REST compatível com JWT e `sb_secret_*`.
 * - Converte fotos de cupons fiscais, gôndolas e panfletos para WebP com `sharp`.
 * - Arquiva vídeos de corredores de mercado (`video/mp4`, `video/webm`, `video/quicktime`).
 */
export class ArgusStorageService {
  private readonly bucketName = env.SUPABASE_STORAGE_BUCKET || 'FotosArgus';

  private isConfigured(): boolean {
    return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  }

  private async uploadBufferToSupabaseRest(
    storagePath: string,
    buffer: Buffer,
    contentType: string
  ): Promise<{ uploaded: boolean; signedUrl?: string; errorReason?: string }> {
    if (!this.isConfigured()) {
      return {
        uploaded: false,
        errorReason: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurada.'
      };
    }
    const res = await uploadObjectToSupabaseStorage({
      bucket: this.bucketName,
      objectPath: storagePath,
      body: buffer,
      contentType,
      generateSignedUrl: true
    });
    if (!res.uploaded && res.errorReason) {
      logger.warn(
        { bucket: this.bucketName, storagePath, reason: res.errorReason },
        '[ArgusStorageService] Falha no upload para o Supabase Storage'
      );
    }
    return { uploaded: res.uploaded, signedUrl: res.signedUrl, errorReason: res.errorReason };
  }

  /**
   * Faz download de uma imagem ou vídeo já arquivado no bucket `FotosArgus`
   * (usado pelo Worker de Fila quando precisa reprocessar um item que falhou anteriormente).
   */
  async downloadFromStorage(storagePath: string): Promise<Buffer | null> {
    if (!this.isConfigured() || !storagePath) return null;
    return downloadObjectFromSupabaseStorage(storagePath, this.bucketName);
  }

  async compressAndUploadReceiptImage(
    rawBuffer: Buffer,
    accessKey: string,
    storeName: string,
    originalMimeType = 'image/jpeg'
  ): Promise<CompressedUploadResult> {
    const originalBytes = rawBuffer.byteLength;
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const safeStoreSlug =
      storeName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
        .slice(0, 28) || 'mercado';

    const isPdf = originalMimeType.includes('pdf');
    let finalBuffer = rawBuffer;
    let ext = 'pdf';
    let contentType = 'application/pdf';

    if (!isPdf) {
      try {
        finalBuffer = await sharp(rawBuffer)
          .rotate()
          .resize({
            width: 1600,
            height: 2400,
            fit: 'inside',
            withoutEnlargement: true
          })
          .webp({
            quality: 74,
            effort: 6,
            smartSubsample: true
          })
          .toBuffer();
        ext = 'webp';
        contentType = 'image/webp';
      } catch {
        finalBuffer = rawBuffer;
        ext = 'jpg';
        contentType = originalMimeType;
      }
    }

    const compressedBytes = finalBuffer.byteLength;
    const compressionSavingsPct =
      originalBytes > 0
        ? Number((((originalBytes - compressedBytes) / originalBytes) * 100).toFixed(1))
        : 0;

    const cleanKey = (accessKey || `${Date.now()}`).replace(/\D/g, '').slice(-20) || `${Date.now()}`;
    const storagePath = `cupons/${yearMonth}/${safeStoreSlug}_${cleanKey}.${ext}`;

    const { uploaded, signedUrl, errorReason } = await this.uploadBufferToSupabaseRest(
      storagePath,
      finalBuffer,
      contentType
    );

    if (uploaded) {
      logger.info(
        {
          bucket: this.bucketName,
          storagePath,
          originalBytes,
          compressedBytes,
          compressionSavingsPct
        },
        '[ArgusStorageService] Foto do cupom comprimida e salva no bucket FotosArgus!'
      );
    }

    return {
      uploaded,
      bucket: this.bucketName,
      storagePath,
      originalBytes,
      compressedBytes,
      compressionSavingsPct,
      contentType,
      signedUrl,
      uploadError: errorReason
    };
  }

  /**
   * Comprime e salva mídias de Coleta de Preços (Fotos de Gôndola, Panfletos/Flyers ou Vídeos de Corredor)
   * no bucket `FotosArgus` ANTES ou DURANTE o processamento na fila resiliente.
   */
  async uploadPriceScanMedia(
    rawBuffer: Buffer,
    uniqueId: string,
    mediaKind: 'SHELF_PHOTO' | 'MARKET_FLYER' | 'AISLE_VIDEO',
    originalMimeType = 'image/jpeg'
  ): Promise<CompressedUploadResult> {
    const originalBytes = rawBuffer.byteLength;
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const cleanId = uniqueId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-28) || `${Date.now()}`;

    const isVideo =
      mediaKind === 'AISLE_VIDEO' ||
      originalMimeType.startsWith('video/') ||
      originalMimeType === 'application/octet-stream';

    let finalBuffer = rawBuffer;
    let ext = 'webp';
    let contentType = 'image/webp';
    let folder = 'gondolas-e-panfletos';

    if (isVideo) {
      folder = 'videos-corredor';
      contentType = originalMimeType.startsWith('video/') ? originalMimeType : 'video/mp4';
      ext = contentType.includes('webm')
        ? 'webm'
        : contentType.includes('quicktime') || contentType.includes('mov')
          ? 'mov'
          : 'mp4';
    } else if (originalMimeType.includes('pdf')) {
      folder = 'panfletos-pdf';
      contentType = 'application/pdf';
      ext = 'pdf';
    } else {
      try {
        finalBuffer = await sharp(rawBuffer)
          .rotate()
          .resize({
            width: 1800,
            height: 2400,
            fit: 'inside',
            withoutEnlargement: true
          })
          .webp({
            quality: 76,
            effort: 6,
            smartSubsample: true
          })
          .toBuffer();
        ext = 'webp';
        contentType = 'image/webp';
      } catch {
        finalBuffer = rawBuffer;
        ext = 'jpg';
        contentType = originalMimeType;
      }
    }

    const compressedBytes = finalBuffer.byteLength;
    const compressionSavingsPct =
      originalBytes > 0
        ? Math.max(0, Number((((originalBytes - compressedBytes) / originalBytes) * 100).toFixed(1)))
        : 0;

    const storagePath = `${folder}/${yearMonth}/scan_${cleanId}.${ext}`;
    const { uploaded, signedUrl, errorReason } = await this.uploadBufferToSupabaseRest(
      storagePath,
      finalBuffer,
      contentType
    );

    return {
      uploaded,
      bucket: this.bucketName,
      storagePath,
      originalBytes,
      compressedBytes,
      compressionSavingsPct,
      contentType,
      signedUrl,
      uploadError: errorReason
    };
  }
}
