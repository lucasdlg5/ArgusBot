'use client';

import React, { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';

interface ArgusWakeupLoadingProps {
  initialSeconds?: number;
  fullScreen?: boolean;
}

export function ArgusWakeupLoading({
  initialSeconds = 95,
  fullScreen = false
}: ArgusWakeupLoadingProps) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);

  useEffect(() => {
    setSecondsLeft(initialSeconds);
    const timer = setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [initialSeconds]);

  const elapsedPct = Math.min(
    100,
    Math.max(4, Math.round(((initialSeconds - secondsLeft) / initialSeconds) * 100))
  );

  return (
    <div
      className={
        fullScreen
          ? 'flex min-h-screen flex-col items-center justify-center bg-[#090d16] px-4 text-slate-200'
          : 'flex flex-col items-center justify-center py-14 px-4 text-slate-200'
      }
    >
      <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-slate-900/90 p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30">
              <Eye className="h-5 w-5 animate-pulse text-emerald-400" />
            </div>
            <div>
              <p className="font-semibold text-white text-sm">
                Conectando ao banco de dados...
              </p>
              <p className="text-[11px] text-emerald-300/90">
                {secondsLeft > 0
                  ? 'Aguardando resposta em tempo real'
                  : 'Finalizando carregamento...'}
              </p>
            </div>
          </div>

          <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 font-mono text-sm font-bold text-emerald-300 tabular-nums">
            {secondsLeft}s
          </span>
        </div>

        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-1000 ease-linear"
            style={{ width: `${elapsedPct}%` }}
          />
        </div>

        <p className="text-xs leading-relaxed text-slate-400">
          Para economizar recursos, o servidor entra em repouso após alguns minutos sem uso.
          Ele está ligando agora para garantir que você veja apenas os{' '}
          <span className="text-slate-200 font-medium">valores reais e atualizados</span> — assim que responder, a página abre sozinha.
        </p>
      </div>
    </div>
  );
}
