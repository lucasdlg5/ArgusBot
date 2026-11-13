import React, { Suspense } from 'react';
import ArgusReceiptsPage from '@/components/ArgusReceiptsPage';

export default function NotasPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center text-sm">
          Carregando notas fiscais...
        </div>
      }
    >
      <ArgusReceiptsPage />
    </Suspense>
  );
}
