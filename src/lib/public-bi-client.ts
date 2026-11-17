export interface PublicBiFetchResult<T> {
  data: T;
  sourceLabel: string;
}

const DEFAULT_BOT_API_URL = 'https://moneta-argus-bot.onrender.com';

export function getPublicBotApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_BOT_API_URL || DEFAULT_BOT_API_URL).replace(/\/+$/, '');
}

/**
 * Resolve a URL de API para leitura ou mutação (PATCH):
 * - No GitHub Pages (estático), aponta para o Render Live API.
 * - Em execução local/Node, usa a rota relativa do Next.js (`/api/...`).
 */
export function resolvePublicApiUrl(apiPath: string): string {
  const isGitHubPages =
    typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
  const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return isGitHubPages ? `${getPublicBotApiBaseUrl()}${cleanPath}` : cleanPath;
}

const SNAPSHOT_CACHE_TTL_MS = 45000;
let clientSnapshotCache: { result: PublicBiFetchResult<unknown>; expiresAt: number } | null = null;
let inFlightSnapshotPromise: Promise<PublicBiFetchResult<unknown>> | null = null;

export function invalidatePublicSnapshotCache(): void {
  clientSnapshotCache = null;
}

/**
 * Busca o snapshot público do Argus Vision BI em ordem de frescor:
 * 1) Cache em memória (45s) para navegação instantânea entre abas
 * 2) Render Live API (/api/public-snapshot direto do PostgreSQL com Gzip)
 * 3) Supabase Storage (public-bi/dashboard-live.json)
 * 4) Snapshot estático empacotado no GitHub Pages (/data/dashboard-snapshot.json)
 */
export async function fetchPublicDashboardFallback<T>(
  basePath: string,
  options?: { forceRefresh?: boolean }
): Promise<PublicBiFetchResult<T>> {
  const now = Date.now();
  if (!options?.forceRefresh && clientSnapshotCache && clientSnapshotCache.expiresAt > now) {
    return clientSnapshotCache.result as PublicBiFetchResult<T>;
  }

  if (!options?.forceRefresh && inFlightSnapshotPromise) {
    return inFlightSnapshotPromise as Promise<PublicBiFetchResult<T>>;
  }

  const runFetch = async (): Promise<PublicBiFetchResult<T>> => {
    const botApiBase = getPublicBotApiBaseUrl();
    if (botApiBase) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const resBot = await fetch(`${botApiBase}/api/public-snapshot?t=${Date.now()}`, {
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timer);
        if (resBot.ok) {
          const data = (await resBot.json()) as T;
          const resObj = { data, sourceLabel: '🟢 Render Live API (PostgreSQL)' };
          clientSnapshotCache = { result: resObj, expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS };
          return resObj;
        }
      } catch {
        // Segue para Supabase Storage ou Snapshot Estático
      }
    }

    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
    const bucket = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'FotosArgus';
    if (supabaseUrl) {
      try {
        const liveUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(
          bucket
        )}/public-bi/dashboard-live.json?t=${Date.now()}`;
        const resLive = await fetch(liveUrl, { cache: 'no-store' });
        if (resLive.ok) {
          const data = (await resLive.json()) as T;
          const resObj = { data, sourceLabel: '☁️ Supabase Cloud Live (GitHub Pages)' };
          clientSnapshotCache = { result: resObj, expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS };
          return resObj;
        }
      } catch {
        // Segue para Snapshot Estático
      }
    }

    const snapRes = await fetch(`${basePath}/data/dashboard-snapshot.json?t=${Date.now()}`, {
      cache: 'no-store'
    });
    const data = (await snapRes.json()) as T;
    const resObj = { data, sourceLabel: '📦 GitHub Pages Snapshot (Actions CI)' };
    clientSnapshotCache = { result: resObj, expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS };
    return resObj;
  };

  inFlightSnapshotPromise = runFetch();
  try {
    return (await inFlightSnapshotPromise) as PublicBiFetchResult<T>;
  } finally {
    inFlightSnapshotPromise = null;
  }
}
