import type { NextConfig } from 'next';

const isStaticExport = process.env.STATIC_EXPORT === 'true';
const basePath = isStaticExport ? (process.env.NEXT_PUBLIC_BASE_PATH ?? '/ArgusBot') : '';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(isStaticExport
    ? {
        output: 'export',
        trailingSlash: true,
        basePath,
        assetPrefix: basePath ? `${basePath}/` : undefined,
        images: {
          unoptimized: true
        }
      }
    : {
        output: 'standalone',
        serverExternalPackages: ['sharp', 'pg', 'googleapis', 'pluggy-sdk', 'grammy']
      }),
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET:
      process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET ||
      process.env.SUPABASE_STORAGE_BUCKET ||
      'FotosArgus'
  }
};

export default nextConfig;
