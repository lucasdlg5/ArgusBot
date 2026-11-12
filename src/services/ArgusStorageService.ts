import sharp from 'sharp';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface CompressedUploadResult {
  uploaded: boolean;
  bucket: string;
  storagePath: string;
  originalBytes: number;
  compressedBytes: number;
  compressionSavingsPct: number;
  contentType: string;
  signedUrl?: string;
}

/**
 * Serviço de Compressão Ultra-Eficiente e Arquivamento no Supabase Storage (`FotosArgus`).
 * - Usa chamadas diretas à API REST do Supabase Storage (`/storage/v1/object/...`), evitando
 *   dependência de WebSocket (`@supabase/realtime-js`) no Node.js 20.
 * - Converte fotos de cupons fiscais, gôndolas e panfletos para WebP com `sharp`.
 * - Arquiva vídeos de corredores de mercado (`video/mp4`, `video/webm`, `video/quicktime`) para
 *   processamento imediato ou reprocessamento posterior via fila resiliente.
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
  ): Promise<{ uploaded: boolean; signedUrl?: string }> {
    if (!this.isConfigured()) {
      return { uploaded: false };
    }

    const baseUrl = env.SUPABASE_URL.replace(/\/$/, '');
    const encodedPath = storagePath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const uploadUrl = `${baseUrl}/storage/v1/object/${encodeURIComponent(this.bucketName)}/${encodedPath}`;

    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': contentType,
          'x-upsert': 'true'
        },
        body: new Uint8Array(buffer)
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        logger.warn(
          { status: res.status, errBody, bucket: this.bucketName, storagePath },
          '[ArgusStorageService] Aviso no upload REST para o bucket FotosArgus'
        );
        return { uploaded: false };
      }

      // Gera URL assinada temporária (7 dias) via REST
      let signedUrl: string | undefined;
      try {
        const signRes = await fetch(
          `${baseUrl}/storage/v1/object/sign/${encodeURIComponent(this.bucketName)}/${encodedPath}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ expiresIn: 7 * 24 * 3600 })
          }
        );
        if (signRes.ok) {
          const signData = (await signRes.json()) as { signedURL?: string };
          if (signData.signedURL) {
            signedUrl = `${baseUrl}/storage/v1${signData.signedURL}`;
          }
        }
      } catch {
        // URL assinada é opcional
      }

      return { uploaded: true, signedUrl };
    } catch (err) {
      logger.error({ err, storagePath }, '[ArgusStorageService] Erro de rede no upload para FotosArgus');
      return { uploaded: false };
    }
  }

  /**
   * Faz download de uma imagem ou vídeo já arquivado no bucket `FotosArgus`
   * (usado pelo Worker de Fila quando precisa reprocessar um item que falhou anteriormente).
   */
  async downloadFromStorage(storagePath: string): Promise<Buffer | null> {
    if (!this.isConfigured() || !storagePath) return null;
    const baseUrl = env.SUPABASE_URL.replace(/\/$/, '');
    const encodedPath = storagePath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const downloadUrl = `${baseUrl}/storage/v1/object/${encodeURIComponent(this.bucketName)}/${encodedPath}`;

    try {
      const res = await fetch(downloadUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY
        }
      });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      logger.warn({ err, storagePath }, '[ArgusStorageService] Falha ao baixar mídia do bucket FotosArgus');
      return null;
    }
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

    const { uploaded, signedUrl } = await this.uploadBufferToSupabaseRest(
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
      signedUrl
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
    const { uploaded, signedUrl } = await this.uploadBufferToSupabaseRest(
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
      signedUrl
    };
  }
}
