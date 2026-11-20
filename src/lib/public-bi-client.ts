export interface PublicBiFetchResult<T> {
  data: T;
  sourceLabel: string;
  dataVersion?: string;
}

const DEFAULT_BOT_API_URL = 'https://moneta-argus-bot.onrender.com';

export function getPublicBotApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_BOT_API_URL || DEFAULT_BOT_API_URL).replace(/\/+$/, '');
}

/**
 * Resolve a URL de API para leitura ou mutação (PATCH/POST/DELETE):
 * - No GitHub Pages (estático), aponta para o Render Live API.
 * - Em execução local/Node, usa a rota relativa do Next.js (`/api/...`).
 */
export function resolvePublicApiUrl(apiPath: string): string {
  const isGitHubPages =
    typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
  const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return isGitHubPages ? `${getPublicBotApiBaseUrl()}${cleanPath}` : cleanPath;
}

const LOCAL_CACHE_KEY = 'argus_public_snapshot_v2';
const LEGACY_SESSION_CACHE_KEY = 'argus_public_snapshot_v1';

interface PersistedSnapshotEnvelope<T> {
  result: PublicBiFetchResult<T>;
  dataVersion: string;
  cachedAt: number;
}

let clientSnapshotCache: PersistedSnapshotEnvelope<unknown> | null = null;
let inFlightSnapshotPromise: Promise<PublicBiFetchResult<unknown>> | null = null;

function extractDataVersion(data: unknown): string {
  if (data && typeof data === 'object') {
    const rec = data as { dataVersion?: unknown; generatedAt?: unknown };
    if (typeof rec.dataVersion === 'string' && rec.dataVersion.trim()) {
      return rec.dataVersion.trim();
    }
    if (typeof rec.generatedAt === 'string' && rec.generatedAt.trim()) {
      return `gen:${rec.generatedAt.trim()}`;
    }
  }
  return '';
}

function readPersistentCache<T>(): PersistedSnapshotEnvelope<T> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSnapshotEnvelope<T>;
    if (parsed && parsed.result?.data) {
      return parsed;
    }
  } catch {
    // Ignora erro de JSON/storage
  }
  return null;
}

function writePersistentCache<T>(result: PublicBiFetchResult<T>): PersistedSnapshotEnvelope<T> {
  const dataVersion = result.dataVersion || extractDataVersion(result.data);
  const envelope: PersistedSnapshotEnvelope<T> = {
    result: { ...result, dataVersion },
    dataVersion,
    cachedAt: Date.now()
  };
  clientSnapshotCache = envelope as PersistedSnapshotEnvelope<unknown>;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(envelope));
    } catch {
      // Ignora se exceder cota do localStorage
    }
  }
  return envelope;
}

export function getCachedSnapshotVersion(): string {
  if (clientSnapshotCache?.dataVersion) {
    return clientSnapshotCache.dataVersion;
  }
  const disk = readPersistentCache<unknown>();
  if (disk) {
    clientSnapshotCache = disk;
    return disk.dataVersion || '';
  }
  return '';
}

export function invalidatePublicSnapshotCache(): void {
  clientSnapshotCache = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(LOCAL_CACHE_KEY);
      window.sessionStorage.removeItem(LEGACY_SESSION_CACHE_KEY);
    } catch {
      // Ignora
    }
  }
}

/**
 * Consulta ultra-leve (~110 bytes) para checar se entrou dado novo no banco
 * sem reconstruir nem trafegar o snapshot completo.
 */
export async function fetchRemoteSnapshotVersion(timeoutMs = 6000): Promise<string | null> {
  const botApiBase = getPublicBotApiBaseUrl();
  if (!botApiBase) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${botApiBase}/api/snapshot-version?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { status?: string; dataVersion?: string };
    return typeof json.dataVersion === 'string' && json.dataVersion.trim()
      ? json.dataVersion.trim()
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca o snapshot público do Argus Vision BI com estratégia Cache-First + Auto-Revalidação:
 * 1) Cache persistente em memória / localStorage (sobrevive ao F5 sem consultar o banco!)
 * 2) Render Live API (/api/public-snapshot direto do PostgreSQL com Gzip)
 * 3) Supabase Live (fallback em tempo real)
 */
export async function fetchPublicDashboardFallback<T>(
  basePath: string,
  options?: { forceRefresh?: boolean }
): Promise<PublicBiFetchResult<T>> {
  if (!options?.forceRefresh) {
    if (clientSnapshotCache?.result?.data) {
      return clientSnapshotCache.result as PublicBiFetchResult<T>;
    }
    const persisted = readPersistentCache<T>();
    if (persisted?.result?.data) {
      clientSnapshotCache = persisted as PersistedSnapshotEnvelope<unknown>;
      return persisted.result;
    }
  }

  if (!options?.forceRefresh && inFlightSnapshotPromise) {
    return (await inFlightSnapshotPromise) as PublicBiFetchResult<T>;
  }

  const runFetch = async (): Promise<PublicBiFetchResult<T>> => {
    const botApiBase = getPublicBotApiBaseUrl();
    if (botApiBase) {
      const maxAttempts = 6;
      const attemptTimeoutMs = 15000;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
        try {
          const resBot = await fetch(`${botApiBase}/api/public-snapshot?t=${Date.now()}`, {
            cache: 'no-store',
            signal: controller.signal
          });
          clearTimeout(timer);
          if (resBot.ok) {
            const data = (await resBot.json()) as T;
            const dataVersion = extractDataVersion(data);
            const resObj: PublicBiFetchResult<T> = {
              data,
              sourceLabel: '🟢 PostgreSQL (Tempo Real)',
              dataVersion
            };
            writePersistentCache(resObj);
            return resObj;
          }
          lastError = new Error(`HTTP ${resBot.status} do servidor`);
        } catch (err) {
          clearTimeout(timer);
          lastError = err;
        }

        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1500));
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
            const resObj: PublicBiFetchResult<T> = {
              data,
              sourceLabel: '☁️ Nuvem (Tempo Real)',
              dataVersion: extractDataVersion(data)
            };
            writePersistentCache(resObj);
            return resObj;
          }
        } catch {
          // segue para erro explícito abaixo
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error('O servidor demorou para responder. Recarregue a página em alguns segundos.');
    }

    const snapRes = await fetch(`${basePath}/data/dashboard-snapshot.json?t=${Date.now()}`, {
      cache: 'no-store'
    });
    const data = (await snapRes.json()) as T;
    const resObj: PublicBiFetchResult<T> = {
      data,
      sourceLabel: '📦 Snapshot Local',
      dataVersion: extractDataVersion(data)
    };
    writePersistentCache(resObj);
    return resObj;
  };

  inFlightSnapshotPromise = runFetch().finally(() => {
    inFlightSnapshotPromise = null;
  });

  return (await inFlightSnapshotPromise) as PublicBiFetchResult<T>;
}

/**
 * Inscreve a página para receber atualizações automáticas assim que entrar um dado novo no banco:
 * - Verifica /api/snapshot-version (~110 bytes) em background sem travar a UI.
 * - Só baixa /api/public-snapshot novamente quando `dataVersion` realmente mudar.
 * - Também sincroniza instantaneamente entre abas abertas via evento `storage`.
 */
export function subscribeToLiveSnapshotUpdates<T>(
  basePath: string,
  onUpdate: (fresh: PublicBiFetchResult<T>) => void,
  options?: { intervalMs?: number; initialCheckDelayMs?: number }
): () => void {
  if (typeof window === 'undefined') return () => {};

  const intervalMs = options?.intervalMs ?? 15000;
  const initialCheckDelayMs = options?.initialCheckDelayMs ?? 2500;
  let active = true;
  let checking = false;

  const checkForUpdates = async () => {
    if (!active || checking) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const remoteVersion = await fetchRemoteSnapshotVersion(6000);
      if (!active || !remoteVersion) return;
      const localVersion = getCachedSnapshotVersion();
      if (remoteVersion !== localVersion) {
        const fresh = await fetchPublicDashboardFallback<T>(basePath, { forceRefresh: true });
        if (active) {
          onUpdate(fresh);
        }
      }
    } catch {
      // Silencioso em background — mantém cache exibido na tela
    } finally {
      checking = false;
    }
  };

  const initialTimer = window.setTimeout(() => {
    void checkForUpdates();
  }, initialCheckDelayMs);

  const pollTimer = window.setInterval(() => {
    void checkForUpdates();
  }, intervalMs);

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      void checkForUpdates();
    }
  };

  const onStorageSync = (ev: StorageEvent) => {
    if (ev.key !== LOCAL_CACHE_KEY || !ev.newValue) return;
    try {
      const parsed = JSON.parse(ev.newValue) as PersistedSnapshotEnvelope<T>;
      if (parsed?.result?.data) {
        clientSnapshotCache = parsed as PersistedSnapshotEnvelope<unknown>;
        if (active) {
          onUpdate(parsed.result);
        }
      }
    } catch {
      // Ignora JSON inválido
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('storage', onStorageSync);

  return () => {
    active = false;
    window.clearTimeout(initialTimer);
    window.clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('storage', onStorageSync);
  };
}
