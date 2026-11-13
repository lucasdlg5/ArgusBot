export interface PublicBiFetchResult<T> {
  data: T;
  sourceLabel: string;
}

const DEFAULT_BOT_API_URL = 'https://moneta-argus-bot.onrender.com';

export function getPublicBotApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_BOT_API_URL || DEFAULT_BOT_API_URL).replace(/\/+$/, '');
}

/**
 * Busca o snapshot público do Argus Vision BI em ordem de frescor:
 * 1) Render Live API (/api/public-snapshot direto do PostgreSQL)
 * 2) Supabase Storage (public-bi/dashboard-live.json)
 * 3) Snapshot estático empacotado no GitHub Pages (/data/dashboard-snapshot.json)
 */
export async function fetchPublicDashboardFallback<T>(
  basePath: string
): Promise<PublicBiFetchResult<T>> {
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
        return { data, sourceLabel: '🟢 Render Live API (PostgreSQL)' };
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
        return { data, sourceLabel: '☁️ Supabase Cloud Live (GitHub Pages)' };
      }
    } catch {
      // Segue para Snapshot Estático
    }
  }

  const snapRes = await fetch(`${basePath}/data/dashboard-snapshot.json?t=${Date.now()}`, {
    cache: 'no-store'
  });
  const data = (await snapRes.json()) as T;
  return { data, sourceLabel: '📦 GitHub Pages Snapshot (Actions CI)' };
}
