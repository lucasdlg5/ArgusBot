import React from 'react';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#090d16] p-6 text-slate-200">
      <div className="max-w-md rounded-2xl border border-emerald-500/30 bg-slate-900/90 p-6 text-center shadow-2xl">
        <h1 className="text-xl font-bold text-white">404 — Página não encontrada</h1>
        <p className="mt-2 text-xs text-slate-400">
          O recurso solicitado não existe no painel Argus Vision BI.
        </p>
        <a
          href="/ArgusBot/"
          className="mt-4 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-500"
        >
          Voltar ao Painel Principal
        </a>
      </div>
    </div>
  );
}
