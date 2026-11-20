'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowRightLeft,
  Calendar,
  CheckCircle2,
  ChevronDown,
  History,
  Pencil,
  Save,
  Scale,
  Store,
  TrendingDown,
  TrendingUp,
  X
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from 'recharts';
import { resolvePublicApiUrl } from '@/lib/public-bi-client';
import type {
  BaseUnit,
  ProductCategory,
  RecipeCostEvaluation,
  RecipeMultiStoreComparison,
  RecipeMultiStoreIngredientRow,
  StoreIngredientHistorySummary
} from '@/types/argus';

type CostBasis = 'CASH' | 'PROPORTIONAL';
type HistoryLens = 'WEIGHTED' | 'AVERAGE' | 'MINIMUM';
type ScopeMode = 'FULL' | 'COMMON_ONLY';
type TrendWindow = '6M' | '3M';

interface RecipeStoreComparisonCardProps {
  recipe: RecipeCostEvaluation;
  portionMultiplier?: number;
  onRecipeUpdated?: (updated: RecipeCostEvaluation) => void;
}

const STORE_PALETTE = [
  '#10b981', // emerald
  '#38bdf8', // sky
  '#f59e0b', // amber
  '#a855f7', // purple
  '#f43f5e', // rose
  '#14b8a6'  // teal
];

const SOURCE_LABELS: Record<string, string> = {
  CUPOM_FISCAL: 'Cupom Fiscal',
  MARKET_FLYER: 'Flyer / Panfleto',
  SHELF_PHOTO: 'Foto de Gôndola',
  AISLE_VIDEO: 'Vídeo de Corredor',
  HISTORICO: 'Histórico Consolidado'
};

interface TrendChartDatum {
  period: string;
  sortKey: string;
  totalItems: number;
  [key: string]: string | number;
}

function TrendTooltipContent({
  active,
  payload,
  label,
  storeNames,
  colorMap
}: {
  active?: boolean;
  payload?: Array<{ payload?: TrendChartDatum }>;
  label?: string;
  storeNames: string[];
  colorMap: Record<string, string>;
}) {
  if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
    return null;
  }
  const d = payload[0].payload;
  const rows = storeNames
    .map((name) => ({
      name,
      cost: Number(d[name] ?? 0),
      deltaPct: Number(d[`${name}__delta`] ?? 0),
      color: colorMap[name] || '#10b981'
    }))
    .sort((a, b) => a.cost - b.cost);

  const cheapest = rows[0];
  const second = rows[1];
  const diff = cheapest && second ? Number((second.cost - cheapest.cost).toFixed(2)) : 0;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/95 px-3.5 py-3 shadow-xl text-xs space-y-2 min-w-[230px]">
      <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
        <span className="font-bold text-white">{label}</span>
        <span className="text-[11px] text-slate-400 tabular-nums">
          {storeNames.length} mercados
        </span>
      </div>

      <div className="space-y-1.5 tabular-nums">
        {rows.map((row) => (
          <div key={row.name} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5 text-slate-200 font-medium truncate max-w-[140px]">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: row.color }}
              />
              {row.name}
            </span>
            <div className="text-right shrink-0">
              <span className="font-bold text-white">R$ {row.cost.toFixed(2)}</span>
              <span
                className={`ml-1.5 text-[10px] ${
                  row.deltaPct > 0.5
                    ? 'text-rose-400'
                    : row.deltaPct < -0.5
                      ? 'text-emerald-400'
                      : 'text-slate-400'
                }`}
              >
                ({row.deltaPct > 0 ? '+' : ''}
                {row.deltaPct.toFixed(1)}%)
              </span>
            </div>
          </div>
        ))}
      </div>

      {cheapest && second && (
        <div className="pt-1.5 border-t border-slate-800 flex items-center justify-between text-[11px]">
          <span className="text-slate-400">Mais barato no mês:</span>
          <span className="font-semibold text-emerald-400 tabular-nums">
            {diff <= 0.05 ? 'Empate técnico' : `${cheapest.name} (-R$ ${diff.toFixed(2)})`}
          </span>
        </div>
      )}
    </div>
  );
}

function formatShortDate(iso: string | null): string {
  if (!iso) return 'Sem leitura';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'Sem leitura';
  return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildFallbackMultiStoreComparison(
  recipe: RecipeCostEvaluation
): RecipeMultiStoreComparison | null {
  if (recipe.multiStoreComparison && recipe.multiStoreComparison.stores.length > 0) {
    return recipe.multiStoreComparison;
  }

  if (recipe.storeQuotes.length === 0) {
    if (!recipe.historicalStoreComparison) return null;
    const h = recipe.historicalStoreComparison;
    return {
      stores: [h.neSupermercado, h.mercadoSouza].sort(
        (a, b) => a.weightedCashCost - b.weightedCashCost
      ),
      winnerWeightedCashStore:
        h.winnerWeightedCash === 'MERCADO_SOUZA'
          ? 'Mercado Souza'
          : h.winnerWeightedCash === 'NE_SUPERMERCADO'
            ? 'NE Supermercado'
            : null,
      winnerWeightedProportionalStore:
        h.winnerWeightedProportional === 'MERCADO_SOUZA'
          ? 'Mercado Souza'
          : h.winnerWeightedProportional === 'NE_SUPERMERCADO'
            ? 'NE Supermercado'
            : null,
      savingsWeightedCash: h.savingsWeightedCash,
      savingsWeightedPct: h.savingsWeightedPct,
      savingsWeightedProportional: h.savingsWeightedProportional,
      items: h.items.map((it) => {
        const cheaper =
          it.cheaperStoreWeighted === 'MERCADO_SOUZA'
            ? 'Mercado Souza'
            : it.cheaperStoreWeighted === 'NE_SUPERMERCADO'
              ? 'NE Supermercado'
              : null;
        return {
          productId: it.productId,
          productName: it.productName,
          category: it.category,
          baseUnit: it.baseUnit,
          requiredBaseQty: it.requiredBaseQty,
          standardPackageSize: it.standardPackageSize,
          packagesNeeded: it.packagesNeeded,
          byStore: {
            'Mercado Souza': it.mercadoSouza,
            'NE Supermercado': it.neSupermercado
          },
          cheapestStoreName: cheaper,
          savingsVsSecondBest: Math.abs(it.weightedCashDiff)
        };
      }),
      timeline: h.timeline.map((pt) => ({
        periodLabel: pt.periodLabel,
        sortKey: pt.sortKey,
        byStoreCash: {
          'Mercado Souza': pt.mercadoSouzaCash,
          'NE Supermercado': pt.neSupermercadoCash
        },
        byStoreProportional: {
          'Mercado Souza': pt.mercadoSouzaProportional,
          'NE Supermercado': pt.neSupermercadoProportional
        },
        byStoreRealItems: {
          'Mercado Souza': pt.mercadoSouzaRealItems,
          'NE Supermercado': pt.neSupermercadoRealItems
        }
      }))
    };
  }

  const storeNames = recipe.storeQuotes.map((sq) => sq.storeName);
  const items: RecipeMultiStoreIngredientRow[] = recipe.ingredientsBreakdown.map((ing) => {
    const byStore: Record<string, StoreIngredientHistorySummary> = {};
    const realList: Array<{ storeName: string; cash: number }> = [];

    for (const sq of recipe.storeQuotes) {
      const qItem = sq.items.find((it) => it.productId === ing.productId);
      const cash = qItem ? qItem.cashOutlayCost : ing.cashOutlayCost;
      const prop = qItem ? qItem.proportionalCost : ing.proportionalCost;
      const pkg = qItem ? qItem.packagePrice : ing.bestPackagePrice ?? cash;
      const hasReal = Boolean(qItem?.hasRealPrice);
      byStore[sq.storeName] = {
        storeName: sq.storeName,
        hasRealHistory: hasReal,
        observationsCount: hasReal ? 1 : 0,
        latestPackagePrice: pkg,
        weightedPackagePrice: pkg,
        avgHistoricalPackagePrice: pkg,
        minHistoricalPackagePrice: pkg,
        maxHistoricalPackagePrice: pkg,
        latestProportionalCost: prop,
        weightedProportionalCost: prop,
        avgProportionalCost: prop,
        minProportionalCost: prop,
        maxProportionalCost: prop,
        latestCashCost: cash,
        weightedCashCost: cash,
        avgCashCost: cash,
        minCashCost: cash,
        maxCashCost: cash,
        lastSeenAt: null,
        pricePoints: []
      };
      if (hasReal) realList.push({ storeName: sq.storeName, cash });
    }

    realList.sort((a, b) => a.cash - b.cash);
    return {
      productId: ing.productId,
      productName: ing.productName,
      category: ing.category || 'Mercearia',
      baseUnit: ing.baseUnit,
      requiredBaseQty: ing.requiredBaseQty,
      standardPackageSize: ing.standardPackageSize,
      packagesNeeded: ing.packagesNeeded,
      byStore,
      cheapestStoreName: realList[0]?.storeName ?? null,
      savingsVsSecondBest:
        realList.length >= 2 ? Number((realList[1].cash - realList[0].cash).toFixed(2)) : 0
    };
  });

  const stores = storeNames
    .map((storeName) => {
      const matched = items.filter((i) => i.byStore[storeName]?.hasRealHistory).length;
      const wCash = Number(
        items.reduce((s, i) => s + (i.byStore[storeName]?.weightedCashCost ?? 0), 0).toFixed(2)
      );
      const wProp = Number(
        items
          .reduce((s, i) => s + (i.byStore[storeName]?.weightedProportionalCost ?? 0), 0)
          .toFixed(2)
      );
      return {
        storeName,
        matchedIngredientsCount: matched,
        totalIngredientsCount: items.length,
        coveragePct: items.length > 0 ? Number(((matched / items.length) * 100).toFixed(1)) : 0,
        totalObservationsCount: matched,
        lastObservedAt: null,
        weightedCashCost: wCash,
        weightedProportionalCost: wProp,
        avgHistoricalCashCost: wCash,
        avgHistoricalProportionalCost: wProp,
        minHistoricalCashCost: wCash,
        minHistoricalProportionalCost: wProp,
        maxHistoricalCashCost: wCash,
        maxHistoricalProportionalCost: wProp,
        latestCashCost: wCash,
        latestProportionalCost: wProp
      };
    })
    .sort((a, b) => a.weightedCashCost - b.weightedCashCost);

  const cheapest = stores[0];
  const highest = stores[stores.length - 1];
  const savingsWeightedCash =
    cheapest && highest ? Number((highest.weightedCashCost - cheapest.weightedCashCost).toFixed(2)) : 0;

  return {
    stores,
    winnerWeightedCashStore: cheapest?.storeName ?? null,
    winnerWeightedProportionalStore:
      [...stores].sort((a, b) => a.weightedProportionalCost - b.weightedProportionalCost)[0]
        ?.storeName ?? null,
    savingsWeightedCash,
    savingsWeightedPct:
      highest && highest.weightedCashCost > 0
        ? Number(((savingsWeightedCash / highest.weightedCashCost) * 100).toFixed(1))
        : 0,
    savingsWeightedProportional:
      cheapest && highest
        ? Number(
            (highest.weightedProportionalCost - cheapest.weightedProportionalCost).toFixed(2)
          )
        : 0,
    items,
    timeline: []
  };
}

export default function RecipeStoreComparisonCard({
  recipe,
  portionMultiplier = 1,
  onRecipeUpdated
}: RecipeStoreComparisonCardProps) {
  const [costBasis, setCostBasis] = useState<CostBasis>('PROPORTIONAL');
  const [historyLens, setHistoryLens] = useState<HistoryLens>('WEIGHTED');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('FULL');
  const [trendWindow, setTrendWindow] = useState<TrendWindow>('6M');
  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string[] | null>(null);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [editingIngredient, setEditingIngredient] = useState<{
    productId: string;
    productName: string;
    category: ProductCategory;
    baseUnit: BaseUnit;
    standardPackageSize: string;
    quantityInBaseUnit: string;
    manualPackagePrice: string;
    manualStoreName: string;
  } | null>(null);
  const [savingIngredient, setSavingIngredient] = useState(false);
  const [saveIngredientError, setSaveIngredientError] = useState<string | null>(null);

  const comparison = useMemo(() => buildFallbackMultiStoreComparison(recipe), [recipe]);
  const scaledPortions = Math.max(1, Math.round(recipe.servings * portionMultiplier));

  const allStoreNames = useMemo(
    () => (comparison ? comparison.stores.map((s) => s.storeName) : []),
    [comparison]
  );

  const visibleStoreNames = useMemo(() => {
    if (!selectedStoreFilter || selectedStoreFilter.length === 0) return allStoreNames;
    const valid = allStoreNames.filter((n) => selectedStoreFilter.includes(n));
    return valid.length > 0 ? valid : allStoreNames;
  }, [allStoreNames, selectedStoreFilter]);

  const storeColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    allStoreNames.forEach((name, idx) => {
      map[name] = STORE_PALETTE[idx % STORE_PALETTE.length];
    });
    return map;
  }, [allStoreNames]);

  const openEditIngredient = (item: RecipeMultiStoreIngredientRow) => {
    setSaveIngredientError(null);
    const firstWithReal = visibleStoreNames
      .map((sName) => item.byStore[sName])
      .find((s) => s?.hasRealHistory);
    setEditingIngredient({
      productId: item.productId,
      productName: item.productName,
      category: item.category || 'Mercearia',
      baseUnit: item.baseUnit,
      standardPackageSize: String(item.standardPackageSize),
      quantityInBaseUnit: String(item.requiredBaseQty),
      manualPackagePrice: firstWithReal ? String(firstWithReal.weightedPackagePrice) : '',
      manualStoreName: firstWithReal?.storeName || visibleStoreNames[0] || allStoreNames[0] || ''
    });
  };

  const handleSaveIngredient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingIngredient) return;
    setSavingIngredient(true);
    setSaveIngredientError(null);

    try {
      const stdPkg = Number(editingIngredient.standardPackageSize);
      const qtyInBase = Number(editingIngredient.quantityInBaseUnit);
      const manualPriceRaw = editingIngredient.manualPackagePrice.trim();
      const manualPrice = manualPriceRaw ? Number(manualPriceRaw.replace(',', '.')) : null;

      if (!editingIngredient.productName.trim()) {
        throw new Error('Informe o nome do ingrediente.');
      }
      if (!Number.isFinite(stdPkg) || stdPkg <= 0) {
        throw new Error('Informe um tamanho de pacote padrão válido (> 0).');
      }
      if (!Number.isFinite(qtyInBase) || qtyInBase <= 0) {
        throw new Error('Informe uma quantidade na receita válida (> 0).');
      }
      if (manualPrice !== null && (!Number.isFinite(manualPrice) || manualPrice < 0)) {
        throw new Error('Informe um preço de referência válido.');
      }

      const res = await fetch(resolvePublicApiUrl('/api/recipes'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipeId: recipe.recipeId,
          productId: editingIngredient.productId,
          productName: editingIngredient.productName.trim(),
          category: editingIngredient.category,
          baseUnit: editingIngredient.baseUnit,
          standardPackageSize: stdPkg,
          quantityInBaseUnit: qtyInBase,
          manualPackagePrice: manualPrice && manualPrice > 0 ? manualPrice : null,
          manualStoreName: editingIngredient.manualStoreName
        })
      });
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        recipe?: RecipeCostEvaluation;
      };
      if (!res.ok || json.status === 'error' || !json.recipe) {
        throw new Error(json.message || 'Falha ao salvar alterações do ingrediente.');
      }

      setEditingIngredient(null);
      onRecipeUpdated?.(json.recipe);
    } catch (err) {
      setSaveIngredientError((err as Error).message || 'Erro ao atualizar ingrediente.');
    } finally {
      setSavingIngredient(false);
    }
  };

  const toggleStoreInFilter = (storeName: string) => {
    setSelectedStoreFilter((prev) => {
      if (!prev || prev.length === 0) {
        return allStoreNames.filter((n) => n !== storeName);
      }
      if (prev.includes(storeName)) {
        const next = prev.filter((n) => n !== storeName);
        return next.length === 0 ? null : next;
      }
      const next = [...prev, storeName];
      return next.length >= allStoreNames.length ? null : next;
    });
  };

  const computed = useMemo(() => {
    if (!comparison || visibleStoreNames.length === 0) return null;

    const visibleItems =
      scopeMode === 'COMMON_ONLY'
        ? comparison.items.filter((it) =>
            visibleStoreNames.every((st) => it.byStore[st]?.hasRealHistory)
          )
        : comparison.items;

    const pickItemCost = (
      summary: StoreIngredientHistorySummary | undefined,
      lens: HistoryLens,
      basis: CostBasis
    ): number => {
      if (!summary) return 0;
      if (basis === 'CASH') {
        if (lens === 'WEIGHTED') return summary.weightedCashCost * portionMultiplier;
        if (lens === 'AVERAGE') return summary.avgCashCost * portionMultiplier;
        return summary.minCashCost * portionMultiplier;
      }
      if (lens === 'WEIGHTED') return summary.weightedProportionalCost * portionMultiplier;
      if (lens === 'AVERAGE') return summary.avgProportionalCost * portionMultiplier;
      return summary.minProportionalCost * portionMultiplier;
    };

    const storeTotals = visibleStoreNames
      .map((storeName) => {
        const meta = comparison.stores.find((s) => s.storeName === storeName);
        const total = Number(
          visibleItems
            .reduce(
              (acc, it) => acc + pickItemCost(it.byStore[storeName], historyLens, costBasis),
              0
            )
            .toFixed(2)
        );
        const matchedCount = visibleItems.filter((it) => it.byStore[storeName]?.hasRealHistory).length;
        const winCount = visibleItems.filter((it) => {
          const realStores = visibleStoreNames
            .map((st) => ({
              st,
              has: Boolean(it.byStore[st]?.hasRealHistory),
              cost: pickItemCost(it.byStore[st], historyLens, costBasis)
            }))
            .filter((x) => x.has);
          if (realStores.length < 2) return false;
          realStores.sort((a, b) => a.cost - b.cost);
          return (
            realStores[0].st === storeName && realStores[1].cost - realStores[0].cost > 0.05
          );
        }).length;

        return {
          storeName,
          total,
          matchedCount,
          totalItems: visibleItems.length,
          observationsCount: meta?.totalObservationsCount ?? matchedCount,
          lastObservedAt: meta?.lastObservedAt ?? null,
          winCount
        };
      })
      .sort((a, b) => a.total - b.total);

    const cheapestStore = storeTotals[0];
    const mostExpensiveStore = storeTotals[storeTotals.length - 1];
    const absDiff =
      cheapestStore && mostExpensiveStore
        ? Number((mostExpensiveStore.total - cheapestStore.total).toFixed(2))
        : 0;
    const diffPct =
      mostExpensiveStore && mostExpensiveStore.total > 0
        ? Number(((absDiff / mostExpensiveStore.total) * 100).toFixed(1))
        : 0;

    const sumForLens = (
      storeName: string,
      mode: 'MIN' | 'AVG' | 'WEIGHTED' | 'MAX'
    ): number => {
      return Number(
        visibleItems
          .reduce((acc, it) => {
            const s = it.byStore[storeName];
            if (!s) return acc;
            if (costBasis === 'CASH') {
              if (mode === 'MIN') return acc + s.minCashCost * portionMultiplier;
              if (mode === 'AVG') return acc + s.avgCashCost * portionMultiplier;
              if (mode === 'WEIGHTED') return acc + s.weightedCashCost * portionMultiplier;
              return acc + s.maxCashCost * portionMultiplier;
            }
            if (mode === 'MIN') return acc + s.minProportionalCost * portionMultiplier;
            if (mode === 'AVG') return acc + s.avgProportionalCost * portionMultiplier;
            if (mode === 'WEIGHTED') return acc + s.weightedProportionalCost * portionMultiplier;
            return acc + s.maxProportionalCost * portionMultiplier;
          }, 0)
          .toFixed(2)
      );
    };

    const historicalRangeChart = (['MIN', 'AVG', 'WEIGHTED', 'MAX'] as const).map((mode) => {
      const labelMap = {
        MIN: 'Mínima Histórica',
        AVG: 'Média Histórica',
        WEIGHTED: 'Atual (70/30)',
        MAX: 'Máxima Histórica'
      };
      const row: Record<string, string | number> = { metric: labelMap[mode] };
      for (const st of visibleStoreNames) {
        row[st] = sumForLens(st, mode);
      }
      return row;
    });

    const fullTimeline = comparison.timeline ?? [];
    const windowedTimeline =
      trendWindow === '3M' && fullTimeline.length > 3 ? fullTimeline.slice(-3) : fullTimeline;

    const rawTimelineData: Array<Record<string, string | number>> = windowedTimeline.map((pt) => {
      const entry: Record<string, string | number> = {
        period: pt.periodLabel,
        sortKey: pt.sortKey,
        totalItems: visibleItems.length
      };

      for (const st of visibleStoreNames) {
        if (scopeMode === 'COMMON_ONLY') {
          let sum = 0;
          for (const it of visibleItems) {
            const s = it.byStore[st];
            if (!s) continue;
            const pts = s.pricePoints.filter((p) => p.observedAt.slice(0, 7) <= pt.sortKey);
            if (pts.length > 0) {
              const latest = pts[pts.length - 1];
              sum +=
                costBasis === 'CASH'
                  ? it.packagesNeeded * latest.packagePrice
                  : it.requiredBaseQty * latest.basePrice;
            } else {
              sum += costBasis === 'CASH' ? s.weightedCashCost : s.weightedProportionalCost;
            }
          }
          entry[st] = Number((sum * portionMultiplier).toFixed(2));
        } else {
          const val =
            costBasis === 'CASH'
              ? pt.byStoreCash[st] ?? 0
              : pt.byStoreProportional[st] ?? 0;
          entry[st] = Number((val * portionMultiplier).toFixed(2));
        }
      }
      return entry;
    });

    const firstPt = rawTimelineData[0];
    const timelineData: TrendChartDatum[] = rawTimelineData.map((pt) => {
      const out: TrendChartDatum = {
        period: String(pt.period),
        sortKey: String(pt.sortKey),
        totalItems: Number(pt.totalItems)
      };
      for (const st of visibleStoreNames) {
        const val = Number(pt[st] ?? 0);
        const startVal = firstPt ? Number(firstPt[st] ?? 0) : 0;
        out[st] = val;
        out[`${st}__delta`] =
          startVal > 0 ? Number((((val - startVal) / startVal) * 100).toFixed(1)) : 0;
      }
      return out;
    });

    const allSeriesVals = timelineData.flatMap((pt) =>
      visibleStoreNames.map((st) => Number(pt[st] ?? 0))
    );
    const combinedPeriodAvg =
      allSeriesVals.length > 0
        ? Number((allSeriesVals.reduce((s, v) => s + v, 0) / allSeriesVals.length).toFixed(2))
        : 0;

    return {
      visibleItems,
      storeTotals,
      cheapestStore,
      mostExpensiveStore,
      absDiff,
      diffPct,
      historicalRangeChart,
      timelineData,
      combinedPeriodAvg,
      pickItemCost
    };
  }, [comparison, visibleStoreNames, scopeMode, historyLens, costBasis, portionMultiplier, trendWindow]);

  if (!comparison || !computed || computed.storeTotals.length === 0) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-bold text-white">Comparativo de Preços entre Mercados</h3>
            <p className="text-xs text-slate-400 mt-1">
              Ainda não há registros de preços no banco de dados para comparar esta receita entre mercados. Envie cupons fiscais ou panfletos pelo bot para popular o histórico.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const showIndividualColumns = visibleStoreNames.length <= 3;

  return (
    <section
      aria-label="Comparativo histórico da receita entre todos os mercados cadastrados"
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5"
    >
      {/* CABEÇALHO E CONTROLES */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            Comparativo entre Mercados ({allStoreNames.length} cadastrados)
          </span>
          <h3 className="text-base lg:text-lg font-bold text-white mt-0.5 flex flex-wrap items-center gap-2">
            <span>Ranking de Custos — {recipe.recipeName}</span>
            <span className="text-xs font-normal text-slate-400">
              ({scaledPortions} porções)
            </span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Compara preços ponderados, médias e mínimas históricas considerando todos os supermercados do seu histórico.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
            <button
              type="button"
              onClick={() => setCostBasis('CASH')}
              className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap ${
                costBasis === 'CASH'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Embalagens Fechadas
            </button>
            <button
              type="button"
              onClick={() => setCostBasis('PROPORTIONAL')}
              className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap ${
                costBasis === 'PROPORTIONAL'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Uso Proporcional
            </button>
          </div>

          <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
            {(
              [
                { id: 'WEIGHTED', label: 'Atual (70/30)' },
                { id: 'AVERAGE', label: 'Média Hist.' },
                { id: 'MINIMUM', label: 'Mínima Hist.' }
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setHistoryLens(opt.id)}
                className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap ${
                  historyLens === opt.id
                    ? 'bg-sky-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
            <button
              type="button"
              onClick={() => setScopeMode('FULL')}
              className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap ${
                scopeMode === 'FULL'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Receita Completa
            </button>
            <button
              type="button"
              onClick={() => setScopeMode('COMMON_ONLY')}
              className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap ${
                scopeMode === 'COMMON_ONLY'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Itens em Comum
            </button>
          </div>
        </div>
      </div>

      {/* FILTRO DE MERCADOS (QUANDO HOUVER MAIS DE 2 MERCADOS) */}
      {allStoreNames.length > 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-400 mr-1">Mercados exibidos:</span>
          <button
            type="button"
            onClick={() => setSelectedStoreFilter(null)}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              !selectedStoreFilter
                ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-white'
            }`}
          >
            Todos ({allStoreNames.length})
          </button>
          {allStoreNames.map((st) => {
            const active = visibleStoreNames.includes(st);
            return (
              <button
                key={st}
                type="button"
                onClick={() => toggleStoreInFilter(st)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  active
                    ? 'border-slate-600 bg-slate-800/80 text-white'
                    : 'border-slate-800 bg-slate-950 text-slate-500 hover:text-slate-300'
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: storeColorMap[st] }}
                />
                {st}
              </button>
            );
          })}
        </div>
      )}

      {/* RANKING DINÂMICO DE MERCADOS */}
      <div
        className={`grid grid-cols-1 gap-4 ${
          computed.storeTotals.length === 2
            ? 'md:grid-cols-2'
            : 'md:grid-cols-2 xl:grid-cols-3'
        }`}
      >
        {computed.storeTotals.map((st, idx) => {
          const isLeader = idx === 0 && computed.absDiff > 0.05;
          const diffFromLeader = Number((st.total - (computed.cheapestStore?.total ?? 0)).toFixed(2));
          const color = storeColorMap[st.storeName] || '#10b981';

          return (
            <div
              key={st.storeName}
              className={`rounded-xl border p-4 space-y-2 transition-colors ${
                isLeader
                  ? 'border-emerald-500/60 bg-emerald-950/20'
                  : 'border-slate-800 bg-slate-950/70'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-white min-w-0 truncate">
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <Store className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  <span className="truncate">{st.storeName}</span>
                </span>
                {isLeader ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-300 shrink-0">
                    <CheckCircle2 className="h-3 w-3" />
                    1º Mais barato
                  </span>
                ) : (
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-300 shrink-0 tabular-nums">
                    {idx + 1}º lugar
                  </span>
                )}
              </div>

              <div className="flex items-baseline justify-between gap-2">
                <p className="text-2xl font-bold text-white tabular-nums">
                  R$ {st.total.toFixed(2)}
                </p>
                {diffFromLeader > 0.05 ? (
                  <span className="text-xs font-semibold text-amber-300 tabular-nums">
                    +R$ {diffFromLeader.toFixed(2)}
                  </span>
                ) : (
                  computed.storeTotals.length >= 2 &&
                  computed.absDiff > 0.05 && (
                    <span className="text-xs font-semibold text-emerald-400 tabular-nums">
                      Economiza até R$ {computed.absDiff.toFixed(2)} ({computed.diffPct}%)
                    </span>
                  )
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-400 tabular-nums">
                <span>
                  {st.matchedCount}/{st.totalItems} itens com leitura ({st.observationsCount} obs.)
                </span>
                <span>{st.winCount} item(ns) mais barato(s)</span>
              </div>
              <p className="text-[10px] text-slate-500">
                Última leitura: {formatShortDate(st.lastObservedAt)}
              </p>
            </div>
          );
        })}
      </div>

      {/* GRÁFICO DE TENDÊNCIA HISTÓRICA MULTI-MERCADOS */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold text-white flex items-center gap-2">
              <History className="h-3.5 w-3.5 text-emerald-400" />
              <span>
                Tendência Histórica ({trendWindow === '6M' ? 'Últimos 6 Meses' : 'Últimos 3 Meses'})
              </span>
            </h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Variação mensal do custo da receita ({costBasis === 'CASH' ? 'Embalagens Fechadas' : 'Uso Proporcional'}) nos mercados selecionados
            </p>
          </div>

          <div
            role="group"
            aria-label="Janela da tendência histórica"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1 text-xs self-start sm:self-auto"
          >
            <button
              type="button"
              onClick={() => setTrendWindow('6M')}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors whitespace-nowrap shrink-0 ${
                trendWindow === '6M'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              6 Meses
            </button>
            <button
              type="button"
              onClick={() => setTrendWindow('3M')}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors whitespace-nowrap shrink-0 ${
                trendWindow === '3M'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              3 Meses
            </button>
          </div>
        </div>

        {computed.timelineData.length >= 2 ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={computed.timelineData}
                margin={{ top: 12, right: 16, left: -6, bottom: 4 }}
              >
                <defs>
                  {visibleStoreNames.map((st, idx) => {
                    const color = storeColorMap[st] || STORE_PALETTE[idx % STORE_PALETTE.length];
                    return (
                      <linearGradient
                        key={st}
                        id={`gradStore-${recipe.recipeId}-${idx}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                      </linearGradient>
                    );
                  })}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="period"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  axisLine={{ stroke: '#1e293b' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  tickFormatter={(v) => `R$${v}`}
                  domain={['auto', 'auto']}
                  axisLine={false}
                  tickLine={false}
                />
                <RechartsTooltip
                  content={
                    <TrendTooltipContent
                      storeNames={visibleStoreNames}
                      colorMap={storeColorMap}
                    />
                  }
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                {computed.combinedPeriodAvg > 0 && (
                  <ReferenceLine
                    y={computed.combinedPeriodAvg}
                    stroke="#64748b"
                    strokeDasharray="4 4"
                    label={{
                      value: `Média R$ ${computed.combinedPeriodAvg.toFixed(2)}`,
                      position: 'insideTopRight',
                      fill: '#94a3b8',
                      fontSize: 10
                    }}
                  />
                )}
                {visibleStoreNames.map((st, idx) => {
                  const color = storeColorMap[st] || STORE_PALETTE[idx % STORE_PALETTE.length];
                  return (
                    <Area
                      key={st}
                      type="monotone"
                      dataKey={st}
                      stroke={color}
                      strokeWidth={2.5}
                      fill={`url(#gradStore-${recipe.recipeId}-${idx})`}
                      dot={{ r: 3.5, fill: '#020617', stroke: color, strokeWidth: 2 }}
                      activeDot={{ r: 5.5, fill: color, stroke: '#020617', strokeWidth: 2 }}
                    />
                  );
                })}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-48 flex flex-col items-center justify-center text-center px-4 rounded-lg border border-slate-800/80 bg-slate-900/40">
            <Calendar className="h-5 w-5 text-slate-500 mb-2" />
            <p className="text-xs font-medium text-slate-300">
              Histórico concentrado em 1 período ({computed.timelineData[0]?.period ?? 'Atual'})
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              Conforme novos cupons e panfletos forem registrados ao longo dos meses, a curva comparativa entre os mercados aparecerá aqui.
            </p>
          </div>
        )}
      </div>

      {/* GRÁFICO DE BARRAS: FAIXA DE CUSTO HISTÓRICO */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2">
        <div>
          <h4 className="text-xs font-semibold text-white">
            Faixa de Custo Histórico ({costBasis === 'CASH' ? 'Embalagens Fechadas' : 'Uso Proporcional'})
          </h4>
          <p className="text-[11px] text-slate-400">
            Comparação entre mínima, média, atual ponderada e máxima registrada em cada mercado
          </p>
        </div>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={computed.historicalRangeChart}
              margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="metric" tick={{ fill: '#94a3b8', fontSize: 11 }} />
              <YAxis
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                tickFormatter={(v) => `R$${v}`}
              />
              <RechartsTooltip
                contentStyle={{
                  backgroundColor: '#090d16',
                  borderColor: '#334155',
                  borderRadius: '8px',
                  fontSize: '12px'
                }}
                formatter={(value: unknown) => [`R$ ${Number(value).toFixed(2)}`, undefined]}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              {visibleStoreNames.map((st, idx) => (
                <Bar
                  key={st}
                  dataKey={st}
                  fill={storeColorMap[st] || STORE_PALETTE[idx % STORE_PALETTE.length]}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* TABELA INGREDIENTE A INGREDIENTE COM HISTÓRICO EXPANSÍVEL */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-white">
            Detalhamento por Ingrediente (clique em uma linha para abrir todos os mercados e leituras)
          </h4>
          <span className="text-[11px] text-slate-400 tabular-nums">
            {computed.visibleItems.length} ingrediente(s) · {visibleStoreNames.length} mercado(s)
          </span>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden">
          <div className="hidden md:grid md:grid-cols-12 gap-2 px-3.5 py-2.5 border-b border-slate-800 text-[11px] font-semibold text-slate-400">
            <div className={showIndividualColumns && visibleStoreNames.length === 3 ? 'col-span-4' : 'col-span-4'}>
              Ingrediente da Receita
            </div>
            {showIndividualColumns ? (
              <>
                {visibleStoreNames.map((st) => (
                  <div
                    key={st}
                    className={`${
                      visibleStoreNames.length === 3
                        ? 'col-span-2'
                        : visibleStoreNames.length === 2
                          ? 'col-span-3'
                          : 'col-span-6'
                    } text-right truncate`}
                    title={st}
                  >
                    {st}
                  </div>
                ))}
                <div className="col-span-2 text-right">Melhor Opção</div>
              </>
            ) : (
              <>
                <div className="col-span-3 text-right">Menor Preço</div>
                <div className="col-span-3 text-right">2º Lugar</div>
                <div className="col-span-2 text-right">Diferença</div>
              </>
            )}
          </div>

          <div className="divide-y divide-slate-800/70">
            {computed.visibleItems.map((item) => {
              const isRowExpanded = expandedProductId === item.productId;
              const storeCosts = visibleStoreNames
                .map((st) => {
                  const s = item.byStore[st];
                  return {
                    storeName: st,
                    summary: s,
                    cost: computed.pickItemCost(s, historyLens, costBasis),
                    hasReal: Boolean(s?.hasRealHistory)
                  };
                })
                .sort((a, b) => a.cost - b.cost);

              const realCosts = storeCosts.filter((sc) => sc.hasReal);
              const bestReal = realCosts[0];
              const secondReal = realCosts[1];
              const diff =
                bestReal && secondReal
                  ? Number((secondReal.cost - bestReal.cost).toFixed(2))
                  : 0;

              const mergedTimelineRows = visibleStoreNames
                .flatMap((st) =>
                  (item.byStore[st]?.pricePoints ?? []).map((pt) => ({
                    store: st,
                    ...pt
                  }))
                )
                .sort(
                  (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime()
                );

              return (
                <div key={item.productId}>
                  <button
                    type="button"
                    aria-expanded={isRowExpanded}
                    onClick={() =>
                      setExpandedProductId((prev) =>
                        prev === item.productId ? null : item.productId
                      )
                    }
                    className="w-full text-left px-3.5 py-2.5 hover:bg-slate-900/70 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center text-xs">
                      <div className="md:col-span-4 flex items-center gap-2 min-w-0">
                        <motion.span
                          animate={{ rotate: isRowExpanded ? 180 : 0 }}
                          transition={{ type: 'spring', stiffness: 340, damping: 24 }}
                          className="text-slate-400 shrink-0"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </motion.span>
                        <div className="min-w-0">
                          <p className="font-semibold text-white truncate">{item.productName}</p>
                          <p className="text-[11px] text-slate-400 tabular-nums">
                            {(item.requiredBaseQty * portionMultiplier).toFixed(0)} {item.baseUnit} ·{' '}
                            {Math.ceil(item.packagesNeeded * portionMultiplier)} emb. padrão
                          </p>
                        </div>
                      </div>

                      {showIndividualColumns ? (
                        <>
                          {visibleStoreNames.map((st) => {
                            const s = item.byStore[st];
                            const cost = computed.pickItemCost(s, historyLens, costBasis);
                            const isBestHere =
                              bestReal &&
                              bestReal.storeName === st &&
                              realCosts.length >= 2 &&
                              diff > 0.05;
                            const colSpan =
                              visibleStoreNames.length === 3
                                ? 'md:col-span-2'
                                : visibleStoreNames.length === 2
                                  ? 'md:col-span-3'
                                  : 'md:col-span-6';
                            const rangeMin = s
                              ? (costBasis === 'CASH'
                                  ? s.minCashCost
                                  : s.minProportionalCost) * portionMultiplier
                              : 0;
                            const rangeMax = s
                              ? (costBasis === 'CASH'
                                  ? s.maxCashCost
                                  : s.maxProportionalCost) * portionMultiplier
                              : 0;

                            return (
                              <div key={st} className={`${colSpan} md:text-right tabular-nums`}>
                                {s?.hasRealHistory ? (
                                  <>
                                    <p
                                      className={`font-bold ${
                                        isBestHere ? 'text-emerald-300' : 'text-slate-200'
                                      }`}
                                    >
                                      R$ {cost.toFixed(2)}
                                    </p>
                                    <p className="text-[10px] text-slate-400">
                                      {s.observationsCount} leit. · mín R$ {rangeMin.toFixed(2)}–
                                      {rangeMax.toFixed(2)}
                                    </p>
                                  </>
                                ) : (
                                  <>
                                    <p className="text-slate-400">R$ {cost.toFixed(2)} (est.)</p>
                                    <p className="text-[10px] text-amber-300/90">Sem leitura</p>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </>
                      ) : (
                        <>
                          <div className="md:col-span-3 md:text-right tabular-nums">
                            {bestReal ? (
                              <>
                                <p className="font-bold text-emerald-300">
                                  R$ {bestReal.cost.toFixed(2)}
                                </p>
                                <p className="text-[10px] text-slate-300 truncate">
                                  {bestReal.storeName}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="text-slate-400">
                                  R$ {(storeCosts[0]?.cost ?? 0).toFixed(2)} (est.)
                                </p>
                                <p className="text-[10px] text-amber-300/90">Sem leitura</p>
                              </>
                            )}
                          </div>
                          <div className="md:col-span-3 md:text-right tabular-nums">
                            {secondReal ? (
                              <>
                                <p className="font-semibold text-slate-200">
                                  R$ {secondReal.cost.toFixed(2)}
                                </p>
                                <p className="text-[10px] text-slate-400 truncate">
                                  {secondReal.storeName}
                                </p>
                              </>
                            ) : (
                              <span className="text-[11px] text-slate-500">—</span>
                            )}
                          </div>
                        </>
                      )}

                      <div className="md:col-span-2 md:text-right tabular-nums text-[11px] font-semibold">
                        {realCosts.length < 2 ? (
                          <span className="text-slate-400 font-normal">
                            {bestReal ? bestReal.storeName : 'Parcial'}
                          </span>
                        ) : diff <= 0.05 ? (
                          <span className="text-slate-300">Empate</span>
                        ) : (
                          <span className="text-emerald-400">
                            {bestReal.storeName.split(' ')[0]} -R$ {diff.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>

                  <AnimatePresence initial={false}>
                    {isRowExpanded && (
                      <motion.div
                        key={`hist-row-${item.productId}`}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden bg-slate-900/50 border-t border-slate-800/70"
                      >
                        <div className="px-4 py-3 space-y-3 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">
                            <span>
                              Preços e leituras para{' '}
                              <strong className="text-white">{item.productName}</strong>
                            </span>
                            <div className="flex items-center gap-2.5">
                              <span className="text-slate-400 tabular-nums">
                                Pacote padrão: {item.standardPackageSize} {item.baseUnit}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEditIngredient(item);
                                }}
                                className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 px-2.5 py-1 text-[11px] font-semibold text-sky-200 transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                                Editar
                              </button>
                            </div>
                          </div>

                          {/* Preço atual por mercado (útil especialmente com 3+ mercados) */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {storeCosts.map((sc) => (
                              <div
                                key={sc.storeName}
                                className="rounded-lg border border-slate-800/90 bg-slate-950/70 px-3 py-2 flex items-center justify-between gap-2 text-[11px] tabular-nums"
                              >
                                <span className="inline-flex items-center gap-1.5 text-slate-200 font-medium truncate">
                                  <span
                                    className="h-2 w-2 rounded-full shrink-0"
                                    style={{ backgroundColor: storeColorMap[sc.storeName] }}
                                  />
                                  {sc.storeName}
                                </span>
                                <span
                                  className={
                                    sc.hasReal
                                      ? 'font-bold text-white shrink-0'
                                      : 'text-slate-400 shrink-0'
                                  }
                                >
                                  R$ {sc.cost.toFixed(2)} {!sc.hasReal && '(est.)'}
                                </span>
                              </div>
                            ))}
                          </div>

                          {mergedTimelineRows.length === 0 ? (
                            <p className="text-[11px] text-slate-400">
                              Sem observações individuais detalhadas registradas para este item.
                            </p>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                              {mergedTimelineRows.slice(0, 6).map((obs, obsIdx) => (
                                <div
                                  key={`${obs.store}-${obs.observedAt}-${obsIdx}`}
                                  className="rounded-lg border border-slate-800 bg-slate-950/75 px-3 py-2 flex items-center justify-between gap-2 tabular-nums"
                                >
                                  <div className="min-w-0">
                                    <p
                                      className="text-[11px] font-semibold truncate"
                                      style={{ color: storeColorMap[obs.store] || '#cbd5e1' }}
                                    >
                                      {obs.store}
                                    </p>
                                    <p className="text-[10px] text-slate-400">
                                      {formatShortDate(obs.observedAt)} ·{' '}
                                      {SOURCE_LABELS[obs.sourceType] ?? obs.sourceType}
                                    </p>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <p className="text-xs font-bold text-white">
                                      R$ {obs.packagePrice.toFixed(2)}
                                    </p>
                                    <p className="text-[10px] text-slate-400">
                                      {Math.ceil(item.packagesNeeded * portionMultiplier)}x = R${' '}
                                      {(
                                        obs.packagePrice *
                                        Math.ceil(item.packagesNeeded * portionMultiplier)
                                      ).toFixed(2)}
                                    </p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* MODAL POPUP DE EDIÇÃO DO INGREDIENTE */}
      {editingIngredient && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
          onClick={() => !savingIngredient && setEditingIngredient(null)}
        >
          <form
            onSubmit={handleSaveIngredient}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Pencil className="h-4 w-4 text-sky-400" />
                  Editar Ingrediente da Receita
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Ajuste unidade, tamanho do pacote padrão, quantidade usada ou preço de referência sem recarregar a página.
                </p>
              </div>
              <button
                type="button"
                disabled={savingIngredient}
                onClick={() => setEditingIngredient(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {saveIngredientError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                {saveIngredientError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <label className="space-y-1 sm:col-span-2">
                <span className="text-slate-300 font-medium">Nome do Ingrediente</span>
                <input
                  type="text"
                  required
                  value={editingIngredient.productName}
                  onChange={(e) =>
                    setEditingIngredient((prev) =>
                      prev ? { ...prev, productName: e.target.value } : prev
                    )
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-sky-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">Categoria</span>
                <select
                  value={editingIngredient.category}
                  onChange={(e) =>
                    setEditingIngredient((prev) =>
                      prev
                        ? { ...prev, category: e.target.value as ProductCategory }
                        : prev
                    )
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-sky-500 focus:outline-none"
                >
                  {[
                    'Mercearia',
                    'Carnes',
                    'Laticínios',
                    'Hortifruti',
                    'Bebidas',
                    'Limpeza',
                    'Higiene',
                    'Besteiras/Impulso'
                  ].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">Unidade Base</span>
                <select
                  value={editingIngredient.baseUnit}
                  onChange={(e) =>
                    setEditingIngredient((prev) =>
                      prev ? { ...prev, baseUnit: e.target.value as BaseUnit } : prev
                    )
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-sky-500 focus:outline-none"
                >
                  <option value="g">g (gramas)</option>
                  <option value="ml">ml (mililitros)</option>
                  <option value="un">un (unidades)</option>
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">
                  Pacote Padrão ({editingIngredient.baseUnit})
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={editingIngredient.standardPackageSize}
                  onChange={(e) =>
                    setEditingIngredient((prev) =>
                      prev ? { ...prev, standardPackageSize: e.target.value } : prev
                    )
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white tabular-nums focus:border-sky-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">
                  Qtd. usada na Receita ({editingIngredient.baseUnit})
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={editingIngredient.quantityInBaseUnit}
                  onChange={(e) =>
                    setEditingIngredient((prev) =>
                      prev ? { ...prev, quantityInBaseUnit: e.target.value } : prev
                    )
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white tabular-nums focus:border-sky-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">
                  Preço do Pacote (R$) — opcional
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Ex: 2.50"
                  value={editingIngredient.manualPackagePrice}
                  onChange={(e) =>
                    setEditingIngredient((prev) =>
                      prev ? { ...prev, manualPackagePrice: e.target.value } : prev
                    )
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white tabular-nums placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">Mercado do Preço</span>
                <select
                  value={editingIngredient.manualStoreName}
                  onChange={(e) =>
                    setEditingIngredient((prev) =>
                      prev ? { ...prev, manualStoreName: e.target.value } : prev
                    )
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-sky-500 focus:outline-none"
                >
                  {(allStoreNames.length > 0
                    ? allStoreNames
                    : ['NE Supermercado', 'Mercado Souza']
                  ).map((stName) => (
                    <option key={stName} value={stName}>
                      {stName}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300 tabular-nums">
              Cálculo previsto:{' '}
              <strong className="text-emerald-300">
                {Math.max(
                  1,
                  Math.ceil(
                    (Number(editingIngredient.quantityInBaseUnit) || 1) /
                      Math.max(0.01, Number(editingIngredient.standardPackageSize) || 1)
                  )
                )}{' '}
                emb. padrão
              </strong>{' '}
              de {editingIngredient.standardPackageSize || '1'} {editingIngredient.baseUnit} para atender{' '}
              {editingIngredient.quantityInBaseUnit || '1'} {editingIngredient.baseUnit} na receita.
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={savingIngredient}
                onClick={() => setEditingIngredient(null)}
                className="rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 text-xs font-medium text-slate-300 hover:text-white"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={savingIngredient}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors"
              >
                <Save className="h-3.5 w-3.5" />
                {savingIngredient ? 'Salvando...' : 'Salvar e Recalcular'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
