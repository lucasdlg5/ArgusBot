import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface SupabaseStorageUploadResult {
  uploaded: boolean;
  publicUrl?: string;
  signedUrl?: string;
  errorReason?: string;
}

function isJwtSecretKey(key: string): boolean {
  return key.split('.').length === 3 && key.startsWith('eyJ');
}

function buildAuthHeaders(serviceKey: string): Record<string, string> {
  // Chaves novas da Supabase (`sb_secret_...`) não são JWT e falham se enviadas no header Authorization Bearer.
  if (isJwtSecretKey(serviceKey)) {
    return {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey
    };
  }
  return {
    apikey: serviceKey
  };
}

async function ensureBucketExistsViaRest(
  baseUrl: string,
  bucket: string,
  serviceKey: string,
  isPublic = true
): Promise<void> {
  const headers = {
    ...buildAuthHeaders(serviceKey),
    'Content-Type': 'application/json'
  };

  try {
    const getRes = await fetch(`${baseUrl}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
      method: 'GET',
      headers
    });
    if (getRes.ok) {
      return;
    }
    if (getRes.status === 404 || getRes.status === 400) {
      await fetch(`${baseUrl}/storage/v1/bucket`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: bucket, name: bucket, public: isPublic })
      }).catch(() => {});
    }
  } catch {
    // Best-effort
  }
}

export async function uploadObjectToSupabaseStorage(params: {
  bucket?: string;
  objectPath: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  cacheControl?: string;
  generateSignedUrl?: boolean;
}): Promise<SupabaseStorageUploadResult> {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY.trim();
  const bucket = (params.bucket || env.SUPABASE_STORAGE_BUCKET || 'FotosArgus').trim();

  if (!baseUrl || !serviceKey) {
    return {
      uploaded: false,
      errorReason: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente nas variáveis de ambiente.'
    };
  }

  const cleanPath = params.objectPath.replace(/^\/+/, '');
  const encodedPath = cleanPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

  const bytesBody =
    typeof params.body === 'string'
      ? new TextEncoder().encode(params.body)
      : new Uint8Array(params.body);

  // 1. Tentativa via SDK oficial @supabase/supabase-js (suporta JWT service_role e sb_secret_*)
  try {
    const sb = createClient(baseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { error } = await sb.storage.from(bucket).upload(cleanPath, bytesBody, {
      contentType: params.contentType,
      upsert: true,
      cacheControl: params.cacheControl || '3600'
    });

    if (!error) {
      const publicUrl = `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
      let signedUrl: string | undefined;
      if (params.generateSignedUrl) {
        const { data: signData } = await sb.storage
          .from(bucket)
          .createSignedUrl(cleanPath, 7 * 24 * 3600);
        if (signData?.signedUrl) {
          signedUrl = signData.signedUrl;
        }
      }
      return { uploaded: true, publicUrl, signedUrl };
    }

    logger.warn(
      { bucket, objectPath: cleanPath, sdkError: error.message },
      '[SupabaseStorage] Upload via SDK retornou erro — tentando fallback REST'
    );
  } catch (sdkErr) {
    logger.warn(
      { bucket, objectPath: cleanPath, err: (sdkErr as Error).message },
      '[SupabaseStorage] Exceção no SDK — tentando fallback REST'
    );
  }

  // 2. Fallback REST direto (garantindo criação do bucket se necessário e header compatível com tipo de chave)
  await ensureBucketExistsViaRest(baseUrl, bucket, serviceKey, true);

  const uploadUrl = `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  try {
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(serviceKey),
        'Content-Type': params.contentType,
        'x-upsert': 'true',
        ...(params.cacheControl ? { 'Cache-Control': params.cacheControl } : {})
      },
      body: bytesBody
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const isMimeError =
        res.status === 415 || errBody.toLowerCase().includes('mime type');

      if (isMimeError) {
        const updateRes = await fetch(
          `${baseUrl}/storage/v1/bucket/${encodeURIComponent(bucket)}`,
          {
            method: 'PUT',
            headers: {
              ...buildAuthHeaders(serviceKey),
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ public: true, allowed_mime_types: null })
          }
        ).catch(() => null);

        if (updateRes?.ok) {
          const retryRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              ...buildAuthHeaders(serviceKey),
              'Content-Type': params.contentType,
              'x-upsert': 'true',
              ...(params.cacheControl ? { 'Cache-Control': params.cacheControl } : {})
            },
            body: bytesBody
          });
          if (retryRes.ok) {
            const publicUrl = `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
            return { uploaded: true, publicUrl };
          }
        }
      }

      const reason = `HTTP ${res.status} ao enviar '${cleanPath}' para bucket '${bucket}': ${errBody}`;
      logger.warn({ status: res.status, errBody, bucket, objectPath: cleanPath }, `[SupabaseStorage] ${reason}`);
      return { uploaded: false, errorReason: reason };
    }

    const publicUrl = `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
    let signedUrl: string | undefined;

    if (params.generateSignedUrl) {
      try {
        const signRes = await fetch(
          `${baseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
          {
            method: 'POST',
            headers: {
              ...buildAuthHeaders(serviceKey),
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
        // URL assinada opcional
      }
    }

    return { uploaded: true, publicUrl, signedUrl };
  } catch (err) {
    const reason = (err as Error).message || 'Erro de rede no upload ao Supabase Storage';
    logger.error({ err, bucket, objectPath: cleanPath }, `[SupabaseStorage] ${reason}`);
    return { uploaded: false, errorReason: reason };
  }
}

export async function downloadObjectFromSupabaseStorage(
  objectPath: string,
  bucketOverride?: string
): Promise<Buffer | null> {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY.trim();
  const bucket = (bucketOverride || env.SUPABASE_STORAGE_BUCKET || 'FotosArgus').trim();
  if (!baseUrl || !serviceKey || !objectPath) return null;

  const cleanPath = objectPath.replace(/^\/+/, '');
  try {
    const sb = createClient(baseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await sb.storage.from(bucket).download(cleanPath);
    if (!error && data) {
      return Buffer.from(await data.arrayBuffer());
    }
  } catch {
    // Segue para fallback REST
  }

  const encodedPath = cleanPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const downloadUrl = `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  try {
    const res = await fetch(downloadUrl, {
      method: 'GET',
      headers: buildAuthHeaders(serviceKey)
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn({ err, bucket, objectPath: cleanPath }, '[SupabaseStorage] Falha ao baixar mídia do bucket');
    return null;
  }
}
