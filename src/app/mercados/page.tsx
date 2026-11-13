import React, { Suspense } from 'react';
import ArgusStoresPage from '@/components/ArgusStoresPage';

export default function MercadosPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#090d16] text-xs text-slate-400">
          Carregando B.I. dos mercados...
        </div>
      }
    >
      <ArgusStoresPage />
    </Suspense>
  );
}
