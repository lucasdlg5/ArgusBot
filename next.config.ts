import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['sharp', 'pg', 'googleapis', 'pluggy-sdk', 'grammy']
};

export default nextConfig;
