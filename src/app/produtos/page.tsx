import React, { Suspense } from 'react';
import ArgusProductsPage from '@/components/ArgusProductsPage';

export default function ProdutosPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#090d16] text-xs text-slate-400">
          Carregando catálogo de produtos escaneados...
        </div>
      }
    >
      <ArgusProductsPage />
    </Suspense>
  );
}
