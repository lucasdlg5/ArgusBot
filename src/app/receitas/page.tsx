import React, { Suspense } from 'react';
import ArgusRecipesPage from '@/components/ArgusRecipesPage';

export default function ReceitasPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#090d16] text-xs text-slate-400">
          Carregando laboratório de receitas...
        </div>
      }
    >
      <ArgusRecipesPage />
    </Suspense>
  );
}
