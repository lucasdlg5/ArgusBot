'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface TriggerHighlightOptions {
  scrollElementPrefix?: string;
  onFocusFirst?: (firstId: string) => void;
  scrollDelayMs?: number;
}

/**
 * Hook compartilhado para destacar visualmente itens recém-chegados (ao vivo ou via ?highlight=)
 * por alguns segundos, com mapa de timers por ID, cleanup automático no unmount e controle
 * de execução única por parâmetro de URL (evitando conflito com buscas/filtros manuais).
 */
export function useLiveHighlight(durationMs = 12000) {
  const [highlightedIds, setHighlightedIds] = useState<Record<string, boolean>>({});
  const timersRef = useRef<Map<string, number>>(new Map());
  const handledUrlHighlightRef = useRef<string | null>(null);

  const triggerHighlight = useCallback(
    (ids: string[], options?: TriggerHighlightOptions) => {
      if (ids.length === 0) return;

      setHighlightedIds((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = true;
        return next;
      });

      const firstId = ids[0];
      if (firstId) {
        options?.onFocusFirst?.(firstId);
        if (options?.scrollElementPrefix) {
          const prefix = options.scrollElementPrefix;
          const delay = options.scrollDelayMs ?? 220;
          window.setTimeout(() => {
            const el = document.getElementById(`${prefix}${firstId}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, delay);
        }
      }

      for (const id of ids) {
        const existing = timersRef.current.get(id);
        if (existing) window.clearTimeout(existing);
        const timerId = window.setTimeout(() => {
          timersRef.current.delete(id);
          setHighlightedIds((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, durationMs);
        timersRef.current.set(id, timerId);
      }
    },
    [durationMs]
  );

  const claimUrlHighlight = useCallback((highlightParam: string): boolean => {
    if (!highlightParam) {
      handledUrlHighlightRef.current = null;
      return false;
    }
    if (handledUrlHighlightRef.current === highlightParam) {
      return false;
    }
    handledUrlHighlightRef.current = highlightParam;
    return true;
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  return {
    highlightedIds,
    triggerHighlight,
    claimUrlHighlight
  };
}
