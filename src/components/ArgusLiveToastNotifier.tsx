'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Package, Receipt, Sparkles, Utensils, X } from 'lucide-react';
import {
  LIVE_NEW_ITEMS_EVENT,
  type LiveNewItemNotification
} from '@/lib/public-bi-client';

const TOAST_DURATION_MS = 10000;

export function ArgusLiveToastNotifier() {
  const router = useRouter();
  const [toasts, setToasts] = useState<LiveNewItemNotification[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const hoveredRef = useRef<Set<string>>(new Set());

  const dismissToast = (uid: string) => {
    const timer = timersRef.current.get(uid);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(uid);
    }
    hoveredRef.current.delete(uid);
    setToasts((prev) => prev.filter((t) => t.uid !== uid));
  };

  const scheduleDismiss = (uid: string, delayMs = TOAST_DURATION_MS) => {
    const prevTimer = timersRef.current.get(uid);
    if (prevTimer) window.clearTimeout(prevTimer);
    const id = window.setTimeout(() => {
      if (!hoveredRef.current.has(uid)) {
        dismissToast(uid);
      }
    }, delayMs);
    timersRef.current.set(uid, id);
  };

  useEffect(() => {
    const onNewItems = (ev: Event) => {
      const custom = ev as CustomEvent<{ items?: LiveNewItemNotification[] }>;
      const incoming = custom.detail?.items || [];
      if (incoming.length === 0) return;

      setToasts((prev) => {
        const existingUids = new Set(prev.map((t) => t.uid));
        const fresh = incoming.filter((item) => !existingUids.has(item.uid));
        if (fresh.length === 0) return prev;
        fresh.forEach((item) => scheduleDismiss(item.uid));
        return [...fresh, ...prev].slice(0, 3);
      });
    };

    window.addEventListener(LIVE_NEW_ITEMS_EVENT, onNewItems);
    return () => {
      window.removeEventListener(LIVE_NEW_ITEMS_EVENT, onNewItems);
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const renderIcon = (kind: LiveNewItemNotification['kind']) => {
    if (kind === 'PRODUCT') return <Package className="h-4 w-4 text-sky-300" />;
    if (kind === 'RECIPE') return <Utensils className="h-4 w-4 text-amber-300" />;
    return <Receipt className="h-4 w-4 text-emerald-300" />;
  };

  return (
    <div
      aria-live="polite"
      className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2.5 w-[calc(100vw-2.5rem)] max-w-sm pointer-events-none"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.uid}
            layout
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            onMouseEnter={() => {
              hoveredRef.current.add(toast.uid);
              const t = timersRef.current.get(toast.uid);
              if (t) window.clearTimeout(t);
            }}
            onMouseLeave={() => {
              hoveredRef.current.delete(toast.uid);
              scheduleDismiss(toast.uid, 3500);
            }}
            onClick={() => {
              dismissToast(toast.uid);
              router.push(toast.href);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dismissToast(toast.uid);
                router.push(toast.href);
              }
            }}
            className="pointer-events-auto group relative overflow-hidden rounded-2xl border border-emerald-400/50 bg-slate-900/95 backdrop-blur-md p-3.5 shadow-2xl shadow-emerald-950/60 cursor-pointer hover:border-emerald-300 hover:bg-slate-800/95 transition-colors"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/15">
                {renderIcon(toast.kind)}
              </div>

              <div className="min-w-0 flex-1 pr-5">
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                    <Sparkles className="h-2.5 w-2.5" />
                    Novo
                  </span>
                  <p className="text-xs font-bold text-white truncate">{toast.title}</p>
                </div>
                <p className="mt-1 text-xs text-slate-300 line-clamp-2">{toast.subtitle}</p>
                <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 group-hover:text-emerald-300">
                  Ver item agora
                  <ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </p>
              </div>

              <button
                type="button"
                aria-label="Fechar notificação"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissToast(toast.uid);
                }}
                className="absolute top-2.5 right-2.5 rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
