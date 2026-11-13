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
  Scale,
  Store,
  TrendingDown,
  TrendingUp
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
import { CANONICAL_STORE_NE, CANONICAL_STORE_SOUZA, classifyStoreForCurrentSweep } from '@/lib/store-normalization';
import type {
  RecipeCostEvaluation,
  RecipeStorePairComparisonItem,
  RecipeTwoStoreComparison
} from '@/types/argus';

type CostBasis = 'CASH' | 'PROPORTIONAL';
type HistoryLens = 'WEIGHTED' | 'AVERAGE' | 'MINIMUM';
type ScopeMode = 'FULL' | 'COMMON_ONLY';
type TrendWindow = '6M' | '3M';

interface RecipeStoreComparisonCardProps {
  recipe: RecipeCostEvaluation;
  portionMultiplier?: number;
}

const PT_MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

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
  'Mercado Souza': number;
  'NE Supermercado': number;
  souzaReal: number;
  neReal: number;
  totalItems: number;
  souzaBaseDeltaPct: number;
  neBaseDeltaPct: number;
}

function TrendTooltipContent({
  active,
  payload,
  label
}: {
  active?: boolean;
  payload?: Array<{ payload?: TrendChartDatum }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
    return null;
  }
  const d = payload[0].payload;
  const souzaCost = d['Mercado Souza'];
  const neCost = d['NE Supermercado'];
  const diff = Number((souzaCost - neCost).toFixed(2));
  const absDiff = Math.abs(diff);
  const maxVal = Math.max(souzaCost, neCost);
  const diffPct = maxVal > 0 ? ((absDiff / maxVal) * 100).toFixed(1) : '0.0';
  const winnerLabel =
    absDiff <= 0.05
      ? 'Empate técnico'
      : diff > 0
        ? `NE Supermercado -R$ ${absDiff.toFixed(2)} (${diffPct}%)`
        : `Mercado Souza -R$ ${absDiff.toFixed(2)} (${diffPct}%)`;

  const formatDelta = (pct: number) =>
    `${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs. início`;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/95 px-3.5 py-3 shadow-xl text-xs space-y-2 min-w-[230px]">
      <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
        <span className="font-bold text-white">{label}</span>
        <span className="text-[11px] text-slate-400 tabular-nums">
          {Math.min(d.souzaReal, d.neReal)}/{d.totalItems} itens c/ leitura
        </span>
      </div>

      <div className="space-y-1.5 tabular-nums">
        <div className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-sky-300 font-medium">
            <span className="h-2 w-2 rounded-full bg-sky-400" />
            Mercado Souza
          </span>
          <div className="text-right">
            <span className="font-bold text-white">R$ {souzaCost.toFixed(2)}</span>
            <span
              className={`ml-1.5 text-[10px] ${
                d.souzaBaseDeltaPct > 0.5
                  ? 'text-rose-400'
                  : d.souzaBaseDeltaPct < -0.5
                    ? 'text-emerald-400'
                    : 'text-slate-400'
              }`}
            >
              ({formatDelta(d.souzaBaseDeltaPct)})
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-emerald-300 font-medium">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            NE Supermercado
          </span>
          <div className="text-right">
            <span className="font-bold text-white">R$ {neCost.toFixed(2)}</span>
            <span
              className={`ml-1.5 text-[10px] ${
                d.neBaseDeltaPct > 0.5
                  ? 'text-rose-400'
                  : d.neBaseDeltaPct < -0.5
                    ? 'text-emerald-400'
                    : 'text-slate-400'
              }`}
            >
              ({formatDelta(d.neBaseDeltaPct)})
            </span>
          </div>
        </div>
      </div>

      <div className="pt-1.5 border-t border-slate-800 flex items-center justify-between text-[11px]">
        <span className="text-slate-400">Mais barato no mês:</span>
        <span
          className={`font-semibold tabular-nums ${
            absDiff <= 0.05
              ? 'text-slate-200'
              : diff > 0
                ? 'text-emerald-400'
                : 'text-sky-400'
          }`}
        >
          {winnerLabel}
        </span>
      </div>
    </div>
  );
}

function formatShortDate(iso: string | null): string {
  if (!iso) return 'Sem leitura';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'Sem leitura';
  return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildFallbackComparisonFromQuotes(recipe: RecipeCostEvaluation): RecipeTwoStoreComparison | null {
  const souzaQuote = recipe.storeQuotes.find(
    (sq) => classifyStoreForCurrentSweep(sq.storeName).canonicalName === CANONICAL_STORE_SOUZA
  );
  const neQuote = recipe.storeQuotes.find(
    (sq) => classifyStoreForCurrentSweep(sq.storeName).canonicalName === CANONICAL_STORE_NE
  );

  if (!souzaQuote && !neQuote) return null;

  const items: RecipeStorePairComparisonItem[] = recipe.ingredientsBreakdown.map((ing) => {
    const sItem = souzaQuote?.items.find((it) => it.productId === ing.productId);
    const nItem = neQuote?.items.find((it) => it.productId === ing.productId);

    const makeSummary = (
      storeName: string,
      qItem: typeof sItem
    ): RecipeStorePairComparisonItem['mercadoSouza'] => {
      const cash = qItem ? qItem.cashOutlayCost : ing.cashOutlayCost;
      const prop = qItem ? qItem.proportionalCost : ing.proportionalCost;
      const pkg = qItem ? qItem.packagePrice : ing.bestPackagePrice ?? cash;
      const hasReal = Boolean(qItem?.hasRealPrice);
      return {
        storeName,
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
    };

    const souza = makeSummary('Mercado Souza', sItem);
    const ne = makeSummary('NE Supermercado', nItem);
    let cheaper: RecipeStorePairComparisonItem['cheaperStoreWeighted'] = 'INSUFFICIENT_DATA';
    if (souza.hasRealHistory && ne.hasRealHistory) {
      cheaper =
        Math.abs(souza.weightedCashCost - ne.weightedCashCost) <= 0.05
          ? 'TIE'
          : souza.weightedCashCost < ne.weightedCashCost
            ? 'MERCADO_SOUZA'
            : 'NE_SUPERMERCADO';
    }

    return {
      productId: ing.productId,
      productName: ing.productName,
      category: ing.category || 'Mercearia',
      baseUnit: ing.baseUnit,
      requiredBaseQty: ing.requiredBaseQty,
      standardPackageSize: ing.standardPackageSize,
      packagesNeeded: ing.packagesNeeded,
      mercadoSouza: souza,
      neSupermercado: ne,
      cheaperStoreWeighted: cheaper,
      weightedCashDiff: Number((souza.weightedCashCost - ne.weightedCashCost).toFixed(2)),
      weightedProportionalDiff: Number(
        (souza.weightedProportionalCost - ne.weightedProportionalCost).toFixed(2)
      )
    };
  });

  const sumTotals = (storeName: string, key: 'mercadoSouza' | 'neSupermercado') => {
    const matched = items.filter((i) => i[key].hasRealHistory).length;
    const wCash = Number(items.reduce((s, i) => s + i[key].weightedCashCost, 0).toFixed(2));
    const wProp = Number(items.reduce((s, i) => s + i[key].weightedProportionalCost, 0).toFixed(2));
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
  };

  const mercadoSouza = sumTotals('Mercado Souza', 'mercadoSouza');
  const neSupermercado = sumTotals('NE Supermercado', 'neSupermercado');
  const sharedItems = items.filter((i) => i.mercadoSouza.hasRealHistory && i.neSupermercado.hasRealHistory);
  const diffCash = Number((mercadoSouza.weightedCashCost - neSupermercado.weightedCashCost).toFixed(2));
  const diffProp = Number(
    (mercadoSouza.weightedProportionalCost - neSupermercado.weightedProportionalCost).toFixed(2)
  );
  const maxCash = Math.max(mercadoSouza.weightedCashCost, neSupermercado.weightedCashCost);

  return {
    mercadoSouza,
    neSupermercado,
    commonOnly: {
      sharedIngredientsCount: sharedItems.length,
      mercadoSouzaWeightedCash: Number(
        sharedItems.reduce((s, i) => s + i.mercadoSouza.weightedCashCost, 0).toFixed(2)
      ),
      neSupermercadoWeightedCash: Number(
        sharedItems.reduce((s, i) => s + i.neSupermercado.weightedCashCost, 0).toFixed(2)
      ),
      mercadoSouzaWeightedProportional: Number(
        sharedItems.reduce((s, i) => s + i.mercadoSouza.weightedProportionalCost, 0).toFixed(2)
      ),
      neSupermercadoWeightedProportional: Number(
        sharedItems.reduce((s, i) => s + i.neSupermercado.weightedProportionalCost, 0).toFixed(2)
      ),
      mercadoSouzaAvgCash: Number(
        sharedItems.reduce((s, i) => s + i.mercadoSouza.avgCashCost, 0).toFixed(2)
      ),
      neSupermercadoAvgCash: Number(
        sharedItems.reduce((s, i) => s + i.neSupermercado.avgCashCost, 0).toFixed(2)
      ),
      mercadoSouzaMinCash: Number(
        sharedItems.reduce((s, i) => s + i.mercadoSouza.minCashCost, 0).toFixed(2)
      ),
      neSupermercadoMinCash: Number(
        sharedItems.reduce((s, i) => s + i.neSupermercado.minCashCost, 0).toFixed(2)
      )
    },
    winnerWeightedCash:
      Math.abs(diffCash) <= 0.05 ? 'TIE' : diffCash > 0 ? 'NE_SUPERMERCADO' : 'MERCADO_SOUZA',
    savingsWeightedCash: Number(Math.abs(diffCash).toFixed(2)),
    savingsWeightedPct: maxCash > 0 ? Number(((Math.abs(diffCash) / maxCash) * 100).toFixed(1)) : 0,
    winnerWeightedProportional:
      Math.abs(diffProp) <= 0.05 ? 'TIE' : diffProp > 0 ? 'NE_SUPERMERCADO' : 'MERCADO_SOUZA',
    savingsWeightedProportional: Number(Math.abs(diffProp).toFixed(2)),
    items,
    timeline: []
  };
}

export default function RecipeStoreComparisonCard({
  recipe,
  portionMultiplier = 1
}: RecipeStoreComparisonCardProps) {
  const [costBasis, setCostBasis] = useState<CostBasis>('CASH');
  const [historyLens, setHistoryLens] = useState<HistoryLens>('WEIGHTED');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('FULL');
  const [trendWindow, setTrendWindow] = useState<TrendWindow>('6M');
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  const comparison = useMemo(
    () => recipe.historicalStoreComparison ?? buildFallbackComparisonFromQuotes(recipe),
    [recipe]
  );

  const scaledPortions = Math.max(1, Math.round(recipe.servings * portionMultiplier));

  const computed = useMemo(() => {
    if (!comparison) return null;

    const visibleItems =
      scopeMode === 'COMMON_ONLY'
        ? comparison.items.filter(
            (it) => it.mercadoSouza.hasRealHistory && it.neSupermercado.hasRealHistory
          )
        : comparison.items;

    const pickItemCost = (
      summary: RecipeStorePairComparisonItem['mercadoSouza'],
      lens: HistoryLens,
      basis: CostBasis
    ): number => {
      if (basis === 'CASH') {
        if (lens === 'WEIGHTED') return summary.weightedCashCost * portionMultiplier;
        if (lens === 'AVERAGE') return summary.avgCashCost * portionMultiplier;
        return summary.minCashCost * portionMultiplier;
      }
      if (lens === 'WEIGHTED') return summary.weightedProportionalCost * portionMultiplier;
      if (lens === 'AVERAGE') return summary.avgProportionalCost * portionMultiplier;
      return summary.minProportionalCost * portionMultiplier;
    };

    const souzaTotal = Number(
      visibleItems
        .reduce((acc, it) => acc + pickItemCost(it.mercadoSouza, historyLens, costBasis), 0)
        .toFixed(2)
    );
    const neTotal = Number(
      visibleItems
        .reduce((acc, it) => acc + pickItemCost(it.neSupermercado, historyLens, costBasis), 0)
        .toFixed(2)
    );

    const diff = Number((souzaTotal - neTotal).toFixed(2));
    const absDiff = Number(Math.abs(diff).toFixed(2));
    const higherTotal = Math.max(souzaTotal, neTotal);
    const diffPct = higherTotal > 0 ? Number(((absDiff / higherTotal) * 100).toFixed(1)) : 0;
    const winner: 'MERCADO_SOUZA' | 'NE_SUPERMERCADO' | 'TIE' =
      absDiff <= 0.05 ? 'TIE' : diff > 0 ? 'NE_SUPERMERCADO' : 'MERCADO_SOUZA';

    let souzaItemWins = 0;
    let neItemWins = 0;
    let tiedItems = 0;
    let missingItems = 0;

    for (const it of visibleItems) {
      if (!it.mercadoSouza.hasRealHistory || !it.neSupermercado.hasRealHistory) {
        missingItems += 1;
        continue;
      }
      const sVal = pickItemCost(it.mercadoSouza, historyLens, costBasis);
      const nVal = pickItemCost(it.neSupermercado, historyLens, costBasis);
      if (Math.abs(sVal - nVal) <= 0.05) {
        tiedItems += 1;
      } else if (sVal < nVal) {
        souzaItemWins += 1;
      } else {
        neItemWins += 1;
      }
    }

    const sumForLens = (
      side: 'mercadoSouza' | 'neSupermercado',
      mode: 'MIN' | 'AVG' | 'WEIGHTED' | 'MAX'
    ) => {
      return Number(
        visibleItems
          .reduce((acc, it) => {
            const s = it[side];
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

    const historicalRangeChart = [
      {
        metric: 'Mínima Histórica',
        'Mercado Souza': sumForLens('mercadoSouza', 'MIN'),
        'NE Supermercado': sumForLens('neSupermercado', 'MIN')
      },
      {
        metric: 'Média Histórica',
        'Mercado Souza': sumForLens('mercadoSouza', 'AVG'),
        'NE Supermercado': sumForLens('neSupermercado', 'AVG')
      },
      {
        metric: 'Atual (70/30)',
        'Mercado Souza': sumForLens('mercadoSouza', 'WEIGHTED'),
        'NE Supermercado': sumForLens('neSupermercado', 'WEIGHTED')
      },
      {
        metric: 'Máxima Histórica',
        'Mercado Souza': sumForLens('mercadoSouza', 'MAX'),
        'NE Supermercado': sumForLens('neSupermercado', 'MAX')
      }
    ];

    // Constrói série temporal mensal responsiva a Escopo (Completa vs Em Comum), Base (Caixa vs Proporcional) e Janela (6M vs 3M)
    const monthsCount = trendWindow === '6M' ? 6 : 3;
    const allDates: string[] = [];
    for (const it of visibleItems) {
      for (const pt of it.mercadoSouza.pricePoints) allDates.push(pt.observedAt);
      for (const pt of it.neSupermercado.pricePoints) allDates.push(pt.observedAt);
    }

    let rawTimeline: Array<{
      period: string;
      sortKey: string;
      'Mercado Souza': number;
      'NE Supermercado': number;
      souzaReal: number;
      neReal: number;
      totalItems: number;
    }> = [];

    if (allDates.length > 0) {
      const anchorMs = Math.max(
        Date.now(),
        ...allDates.map((d) => new Date(d).getTime()).filter((t) => !Number.isNaN(t))
      );
      const anchorDate = new Date(anchorMs);
      const anchorY = anchorDate.getUTCFullYear();
      const anchorM = anchorDate.getUTCMonth();

      const rollingKeys: string[] = [];
      for (let offset = monthsCount - 1; offset >= 0; offset--) {
        const dt = new Date(Date.UTC(anchorY, anchorM - offset, 15));
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        rollingKeys.push(`${y}-${m}`);
      }

      const toMonthKey = (iso: string) => iso.slice(0, 7);
      const toMonthLabel = (ymKey: string) => {
        const [yStr, mStr] = ymKey.split('-');
        const mIdx = Math.max(0, Math.min(11, Number(mStr) - 1));
        return `${PT_MONTHS[mIdx]}/${yStr.slice(-2)}`;
      };

      const hasInWindow = allDates.some(
        (d) => toMonthKey(d) >= rollingKeys[0] && toMonthKey(d) <= rollingKeys[rollingKeys.length - 1]
      );
      const targetKeys = hasInWindow
        ? rollingKeys
        : Array.from(new Set(allDates.map(toMonthKey))).sort().slice(-monthsCount);

      rawTimeline = targetKeys.map((pKey) => {
        let souzaSum = 0;
        let neSum = 0;
        let souzaReal = 0;
        let neReal = 0;

        for (const it of visibleItems) {
          const sPts = it.mercadoSouza.pricePoints.filter((p) => toMonthKey(p.observedAt) <= pKey);
          if (sPts.length > 0) {
            const latest = sPts[sPts.length - 1];
            souzaSum +=
              costBasis === 'CASH'
                ? it.packagesNeeded * latest.packagePrice
                : it.requiredBaseQty * latest.basePrice;
            souzaReal += 1;
          } else {
            const first = it.mercadoSouza.pricePoints[0];
            souzaSum += first
              ? costBasis === 'CASH'
                ? it.packagesNeeded * first.packagePrice
                : it.requiredBaseQty * first.basePrice
              : costBasis === 'CASH'
                ? it.mercadoSouza.weightedCashCost
                : it.mercadoSouza.weightedProportionalCost;
          }

          const nPts = it.neSupermercado.pricePoints.filter((p) => toMonthKey(p.observedAt) <= pKey);
          if (nPts.length > 0) {
            const latest = nPts[nPts.length - 1];
            neSum +=
              costBasis === 'CASH'
                ? it.packagesNeeded * latest.packagePrice
                : it.requiredBaseQty * latest.basePrice;
            neReal += 1;
          } else {
            const first = it.neSupermercado.pricePoints[0];
            neSum += first
              ? costBasis === 'CASH'
                ? it.packagesNeeded * first.packagePrice
                : it.requiredBaseQty * first.basePrice
              : costBasis === 'CASH'
                ? it.neSupermercado.weightedCashCost
                : it.neSupermercado.weightedProportionalCost;
          }
        }

        return {
          period: toMonthLabel(pKey),
          sortKey: pKey,
          'Mercado Souza': Number((souzaSum * portionMultiplier).toFixed(2)),
          'NE Supermercado': Number((neSum * portionMultiplier).toFixed(2)),
          souzaReal,
          neReal,
          totalItems: visibleItems.length
        };
      });
    } else if (comparison.timeline.length > 0) {
      rawTimeline = comparison.timeline.slice(-monthsCount).map((pt) => ({
        period: pt.periodLabel,
        sortKey: pt.sortKey,
        'Mercado Souza': Number(
          ((costBasis === 'CASH' ? pt.mercadoSouzaCash : pt.mercadoSouzaProportional) * portionMultiplier).toFixed(2)
        ),
        'NE Supermercado': Number(
          ((costBasis === 'CASH' ? pt.neSupermercadoCash : pt.neSupermercadoProportional) * portionMultiplier).toFixed(2)
        ),
        souzaReal: pt.mercadoSouzaRealItems,
        neReal: pt.neSupermercadoRealItems,
        totalItems: visibleItems.length
      }));
    }

    const firstPt = rawTimeline[0];
    const timelineData: TrendChartDatum[] = rawTimeline.map((pt) => ({
      ...pt,
      souzaBaseDeltaPct:
        firstPt && firstPt['Mercado Souza'] > 0
          ? Number(
              (((pt['Mercado Souza'] - firstPt['Mercado Souza']) / firstPt['Mercado Souza']) * 100).toFixed(1)
            )
          : 0,
      neBaseDeltaPct:
        firstPt && firstPt['NE Supermercado'] > 0
          ? Number(
              (((pt['NE Supermercado'] - firstPt['NE Supermercado']) / firstPt['NE Supermercado']) * 100).toFixed(1)
            )
          : 0
    }));

    const lastPt = timelineData[timelineData.length - 1];
    const souzaStart = firstPt?.['Mercado Souza'] ?? souzaTotal;
    const souzaEnd = lastPt?.['Mercado Souza'] ?? souzaTotal;
    const neStart = firstPt?.['NE Supermercado'] ?? neTotal;
    const neEnd = lastPt?.['NE Supermercado'] ?? neTotal;

    const souzaTrendPct =
      souzaStart > 0 ? Number((((souzaEnd - souzaStart) / souzaStart) * 100).toFixed(1)) : 0;
    const neTrendPct = neStart > 0 ? Number((((neEnd - neStart) / neStart) * 100).toFixed(1)) : 0;

    const allSeriesValues = timelineData.flatMap((pt) => [pt['Mercado Souza'], pt['NE Supermercado']]);
    const periodMinCost = allSeriesValues.length > 0 ? Math.min(...allSeriesValues) : 0;
    const periodMaxCost = allSeriesValues.length > 0 ? Math.max(...allSeriesValues) : 0;
    const combinedPeriodAvg =
      allSeriesValues.length > 0
        ? Number((allSeriesValues.reduce((s, v) => s + v, 0) / allSeriesValues.length).toFixed(2))
        : 0;

    let souzaMonthsWon = 0;
    let neMonthsWon = 0;
    let tiedMonths = 0;
    for (const pt of timelineData) {
      const mDiff = pt['Mercado Souza'] - pt['NE Supermercado'];
      if (Math.abs(mDiff) <= 0.05) tiedMonths += 1;
      else if (mDiff < 0) souzaMonthsWon += 1;
      else neMonthsWon += 1;
    }

    return {
      visibleItems,
      souzaTotal,
      neTotal,
      absDiff,
      diffPct,
      winner,
      souzaItemWins,
      neItemWins,
      tiedItems,
      missingItems,
      historicalRangeChart,
      timelineData,
      trendStats: {
        souzaStart,
        souzaEnd,
        souzaTrendPct,
        neStart,
        neEnd,
        neTrendPct,
        periodMinCost,
        periodMaxCost,
        combinedPeriodAvg,
        souzaMonthsWon,
        neMonthsWon,
        tiedMonths
      },
      souzaPerPortion: Number((souzaTotal / scaledPortions).toFixed(2)),
      nePerPortion: Number((neTotal / scaledPortions).toFixed(2)),
      pickItemCost
    };
  }, [comparison, costBasis, historyLens, scopeMode, trendWindow, portionMultiplier, scaledPortions]);

  if (!comparison || !computed) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex items-start gap-3">
          <Scale className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-bold text-white">
              Comparativo Histórico: Mercado Souza vs. NE Supermercado
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Ainda não há registros de preços no banco de dados para comparar esta receita entre o Mercado Souza e o NE Supermercado. Envie cupons fiscais ou panfletos pelo bot para popular o histórico.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const totalDbObservations =
    comparison.mercadoSouza.totalObservationsCount + comparison.neSupermercado.totalObservationsCount;

  const lensLabel =
    historyLens === 'WEIGHTED'
      ? 'Atual Ponderado (70% recente / 30% anterior)'
      : historyLens === 'AVERAGE'
        ? 'Média Histórica Completa'
        : 'Menor Preço Histórico Registrado';

  return (
    <section
      aria-label="Comparativo histórico da receita entre Mercado Souza e NE Supermercado"
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5"
    >
      {/* CABEÇALHO + CONTROLES ANALÍTICOS */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
            <span className="text-emerald-400 font-medium">Histórico do Banco de Dados</span>
            <span aria-hidden="true">·</span>
            <span>{totalDbObservations} leituras registradas</span>
            <span aria-hidden="true">·</span>
            <span>{scaledPortions} porções ({portionMultiplier}x)</span>
          </div>
          <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 text-emerald-400 shrink-0" />
            <span>Mercado Souza vs. NE Supermercado — {recipe.recipeName}</span>
          </h3>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Seletor Base de Custo */}
          <div
            role="group"
            aria-label="Base de cálculo do custo"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs"
          >
            <button
              type="button"
              onClick={() => setCostBasis('CASH')}
              className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap shrink-0 ${
                costBasis === 'CASH'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Embalagens (Caixa)
            </button>
            <button
              type="button"
              onClick={() => setCostBasis('PROPORTIONAL')}
              className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap shrink-0 ${
                costBasis === 'PROPORTIONAL'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Uso Proporcional
            </button>
          </div>

          {/* Seletor Lente Histórica */}
          <div
            role="group"
            aria-label="Lente do histórico de preços"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs"
          >
            {(
              [
                { id: 'WEIGHTED', label: 'Atual' },
                { id: 'AVERAGE', label: 'Média Hist.' },
                { id: 'MINIMUM', label: 'Mínima Hist.' }
              ] as Array<{ id: HistoryLens; label: string }>
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setHistoryLens(opt.id)}
                className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap shrink-0 ${
                  historyLens === opt.id
                    ? 'bg-slate-800 text-white font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Seletor Cobertura / Itens em Comum */}
          {comparison.commonOnly.sharedIngredientsCount > 0 &&
            comparison.commonOnly.sharedIngredientsCount < comparison.items.length && (
              <div
                role="group"
                aria-label="Escopo de itens comparados"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs"
              >
                <button
                  type="button"
                  onClick={() => setScopeMode('FULL')}
                  className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap shrink-0 ${
                    scopeMode === 'FULL'
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Receita Completa ({comparison.items.length})
                </button>
                <button
                  type="button"
                  onClick={() => setScopeMode('COMMON_ONLY')}
                  className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap shrink-0 ${
                    scopeMode === 'COMMON_ONLY'
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Em Comum ({comparison.commonOnly.sharedIngredientsCount})
                </button>
              </div>
            )}
        </div>
      </div>

      {/* PLACAR HEAD-TO-HEAD: MERCADO SOUZA vs. NE SUPERMERCADO */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* MERCADO SOUZA */}
        <div
          className={`lg:col-span-5 rounded-xl border p-4 flex flex-col justify-between transition-colors ${
            computed.winner === 'MERCADO_SOUZA'
              ? 'border-sky-500/50 bg-sky-950/20'
              : 'border-slate-800 bg-slate-950/60'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-sky-300 flex items-center gap-1.5">
                <Store className="h-3.5 w-3.5" />
                <span>Mercado Souza</span>
              </p>
              <p className="text-xs text-slate-400 mt-1 tabular-nums">
                {comparison.mercadoSouza.matchedIngredientsCount}/
                {comparison.mercadoSouza.totalIngredientsCount} itens no histórico ·{' '}
                {comparison.mercadoSouza.totalObservationsCount} leituras
              </p>
            </div>
            {computed.winner === 'MERCADO_SOUZA' && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-sky-300 shrink-0">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Mais econômico
              </span>
            )}
          </div>

          <div className="mt-4 flex items-baseline justify-between gap-2">
            <motion.p
              key={`souza-${computed.souzaTotal}-${costBasis}-${historyLens}`}
              initial={{ opacity: 0.4, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16 }}
              className="text-2xl font-bold text-white tabular-nums"
            >
              R$ {computed.souzaTotal.toFixed(2)}
            </motion.p>
            <span className="text-xs text-slate-300 tabular-nums">
              R$ {computed.souzaPerPortion.toFixed(2)}/porção
            </span>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 tabular-nums">
            <span>
              Vence em <strong className="text-sky-300">{computed.souzaItemWins}</strong> item(ns)
            </span>
            <span>Última leitura: {formatShortDate(comparison.mercadoSouza.lastObservedAt)}</span>
          </div>
        </div>

        {/* DIFERENÇA CENTRAL */}
        <div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-950/75 p-4 flex flex-col items-center justify-center text-center gap-1.5">
          <span className="text-[11px] font-medium text-slate-400">{lensLabel.split('(')[0].trim()}</span>
          {computed.winner === 'TIE' ? (
            <>
              <p className="text-lg font-bold text-slate-200 tabular-nums">Empate</p>
              <p className="text-[11px] text-slate-400">Diferença inferior a R$ 0,05</p>
            </>
          ) : (
            <>
              <div className="inline-flex items-center gap-1 text-emerald-400 font-bold text-lg tabular-nums">
                <TrendingDown className="h-4 w-4" />
                <span>R$ {computed.absDiff.toFixed(2)}</span>
              </div>
              <p className="text-xs font-semibold text-white">
                {computed.winner === 'NE_SUPERMERCADO' ? 'NE Supermercado' : 'Mercado Souza'} vence
              </p>
              <p className="text-[11px] text-slate-400 tabular-nums">
                {computed.diffPct}% de economia direta
              </p>
            </>
          )}
        </div>

        {/* NE SUPERMERCADO */}
        <div
          className={`lg:col-span-5 rounded-xl border p-4 flex flex-col justify-between transition-colors ${
            computed.winner === 'NE_SUPERMERCADO'
              ? 'border-emerald-500/50 bg-emerald-950/20'
              : 'border-slate-800 bg-slate-950/60'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-emerald-300 flex items-center gap-1.5">
                <Store className="h-3.5 w-3.5" />
                <span>NE Supermercado</span>
              </p>
              <p className="text-xs text-slate-400 mt-1 tabular-nums">
                {comparison.neSupermercado.matchedIngredientsCount}/
                {comparison.neSupermercado.totalIngredientsCount} itens no histórico ·{' '}
                {comparison.neSupermercado.totalObservationsCount} leituras
              </p>
            </div>
            {computed.winner === 'NE_SUPERMERCADO' && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300 shrink-0">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Mais econômico
              </span>
            )}
          </div>

          <div className="mt-4 flex items-baseline justify-between gap-2">
            <motion.p
              key={`ne-${computed.neTotal}-${costBasis}-${historyLens}`}
              initial={{ opacity: 0.4, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16 }}
              className="text-2xl font-bold text-white tabular-nums"
            >
              R$ {computed.neTotal.toFixed(2)}
            </motion.p>
            <span className="text-xs text-slate-300 tabular-nums">
              R$ {computed.nePerPortion.toFixed(2)}/porção
            </span>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 tabular-nums">
            <span>
              Vence em <strong className="text-emerald-300">{computed.neItemWins}</strong> item(ns)
            </span>
            <span>Última leitura: {formatShortDate(comparison.neSupermercado.lastObservedAt)}</span>
          </div>
        </div>
      </div>

      {/* AVISO DE COBERTURA PARCIAL QUANDO APLICÁVEL */}
      {computed.missingItems > 0 && scopeMode === 'FULL' && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-950/15 px-3.5 py-2.5 text-xs text-amber-200">
          <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <p>
            {computed.missingItems} ingrediente(s) ainda não possuem leitura histórica em um dos dois mercados; no modo Receita Completa eles usam o preço de referência do outro mercado. Alterne para{' '}
            <button
              type="button"
              onClick={() => setScopeMode('COMMON_ONLY')}
              className="font-semibold underline text-amber-300 hover:text-amber-200"
            >
              Em Comum ({comparison.commonOnly.sharedIngredientsCount} itens)
            </button>{' '}
            para comparar apenas os itens com registro nos dois mercados.
          </p>
        </div>
      )}

      {/* TENDÊNCIA HISTÓRICA DE CUSTO NOS ÚLTIMOS 6 MESES (RECHARTS AREACHART) */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-white flex items-center gap-1.5">
              <History className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>
                Tendência Histórica de Preços ({trendWindow === '6M' ? 'Últimos 6 Meses' : 'Últimos 3 Meses'})
              </span>
            </h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Flutuação mensal do custo de &ldquo;{recipe.recipeName}&rdquo; ({costBasis === 'CASH' ? 'Embalagens Fechadas' : 'Uso Proporcional'}) nos dois mercados
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

        {/* 4 KPIs DE OSCILAÇÃO DO PERÍODO */}
        {computed.timelineData.length >= 2 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="rounded-lg border border-slate-800/90 bg-slate-900/50 px-3 py-2.5">
              <p className="text-[11px] text-sky-300">Oscilação · Mercado Souza</p>
              <div className="mt-1 flex items-center gap-1.5 font-bold tabular-nums">
                {computed.trendStats.souzaTrendPct > 0 ? (
                  <TrendingUp className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                )}
                <span
                  className={
                    computed.trendStats.souzaTrendPct > 0.5
                      ? 'text-rose-300'
                      : computed.trendStats.souzaTrendPct < -0.5
                        ? 'text-emerald-300'
                        : 'text-slate-200'
                  }
                >
                  {computed.trendStats.souzaTrendPct > 0 ? '+' : ''}
                  {computed.trendStats.souzaTrendPct}%
                </span>
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                R$ {computed.trendStats.souzaStart.toFixed(2)} → R${' '}
                {computed.trendStats.souzaEnd.toFixed(2)}
              </p>
            </div>

            <div className="rounded-lg border border-slate-800/90 bg-slate-900/50 px-3 py-2.5">
              <p className="text-[11px] text-emerald-300">Oscilação · NE Supermercado</p>
              <div className="mt-1 flex items-center gap-1.5 font-bold tabular-nums">
                {computed.trendStats.neTrendPct > 0 ? (
                  <TrendingUp className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                )}
                <span
                  className={
                    computed.trendStats.neTrendPct > 0.5
                      ? 'text-rose-300'
                      : computed.trendStats.neTrendPct < -0.5
                        ? 'text-emerald-300'
                        : 'text-slate-200'
                  }
                >
                  {computed.trendStats.neTrendPct > 0 ? '+' : ''}
                  {computed.trendStats.neTrendPct}%
                </span>
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                R$ {computed.trendStats.neStart.toFixed(2)} → R${' '}
                {computed.trendStats.neEnd.toFixed(2)}
              </p>
            </div>

            <div className="rounded-lg border border-slate-800/90 bg-slate-900/50 px-3 py-2.5">
              <p className="text-[11px] text-slate-400">Amplitude no Período</p>
              <p className="mt-1 font-bold text-white tabular-nums">
                R$ {computed.trendStats.periodMinCost.toFixed(2)} – R${' '}
                {computed.trendStats.periodMaxCost.toFixed(2)}
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                Média geral: R$ {computed.trendStats.combinedPeriodAvg.toFixed(2)}
              </p>
            </div>

            <div className="rounded-lg border border-slate-800/90 bg-slate-900/50 px-3 py-2.5">
              <p className="text-[11px] text-slate-400">Liderança Mensal</p>
              <p className="mt-1 font-bold text-white tabular-nums">
                <span className="text-emerald-300">{computed.trendStats.neMonthsWon}m NE</span>
                <span className="text-slate-500"> · </span>
                <span className="text-sky-300">{computed.trendStats.souzaMonthsWon}m Souza</span>
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                {computed.trendStats.tiedMonths > 0
                  ? `${computed.trendStats.tiedMonths} empate(s) nos ${computed.timelineData.length} meses`
                  : `${computed.timelineData.length} meses comparados`}
              </p>
            </div>
          </div>
        )}

        {computed.timelineData.length >= 2 ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={computed.timelineData}
                margin={{ top: 12, right: 16, left: -6, bottom: 4 }}
              >
                <defs>
                  <linearGradient id={`gradSouza-${recipe.recipeId}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#38bdf8" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id={`gradNe-${recipe.recipeId}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
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
                <RechartsTooltip content={<TrendTooltipContent />} />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                {computed.trendStats.combinedPeriodAvg > 0 && (
                  <ReferenceLine
                    y={computed.trendStats.combinedPeriodAvg}
                    stroke="#64748b"
                    strokeDasharray="4 4"
                    label={{
                      value: `Média R$ ${computed.trendStats.combinedPeriodAvg.toFixed(2)}`,
                      position: 'insideTopRight',
                      fill: '#94a3b8',
                      fontSize: 10
                    }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="Mercado Souza"
                  stroke="#38bdf8"
                  strokeWidth={2.5}
                  fill={`url(#gradSouza-${recipe.recipeId})`}
                  dot={{ r: 4, fill: '#020617', stroke: '#38bdf8', strokeWidth: 2 }}
                  activeDot={{ r: 6, fill: '#38bdf8', stroke: '#020617', strokeWidth: 2 }}
                />
                <Area
                  type="monotone"
                  dataKey="NE Supermercado"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  fill={`url(#gradNe-${recipe.recipeId})`}
                  dot={{ r: 4, fill: '#020617', stroke: '#10b981', strokeWidth: 2 }}
                  activeDot={{ r: 6, fill: '#10b981', stroke: '#020617', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-56 flex flex-col items-center justify-center text-center px-4 rounded-lg border border-slate-800/80 bg-slate-900/40">
            <Calendar className="h-5 w-5 text-slate-500 mb-2" />
            <p className="text-xs font-medium text-slate-300">
              Histórico temporal concentrado em 1 período ({computed.timelineData[0]?.period ?? 'Atual'})
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              À medida que novos cupons ou flyers forem registrados ao longo dos meses, a tendência de 6 meses entre Mercado Souza e NE Supermercado será traçada aqui.
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
            Comparação entre mínima, média, atual ponderada e máxima registrada no banco nos últimos meses
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
              <Bar dataKey="Mercado Souza" fill="#38bdf8" radius={[4, 4, 0, 0]} />
              <Bar dataKey="NE Supermercado" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* TABELA INGREDIENTE A INGREDIENTE COM HISTÓRICO EXPANSÍVEL */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-white">
            Detalhamento por Ingrediente (clique em uma linha para abrir as leituras históricas)
          </h4>
          <span className="text-[11px] text-slate-400 tabular-nums">
            {computed.souzaItemWins} Souza · {computed.neItemWins} NE · {computed.tiedItems} empates
          </span>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden">
          <div className="hidden md:grid md:grid-cols-12 gap-2 px-3.5 py-2.5 border-b border-slate-800 text-[11px] font-semibold text-slate-400">
            <div className="col-span-4">Ingrediente da Receita</div>
            <div className="col-span-3 text-right">Mercado Souza</div>
            <div className="col-span-3 text-right">NE Supermercado</div>
            <div className="col-span-2 text-right">Diferença</div>
          </div>

          <div className="divide-y divide-slate-800/70">
            {computed.visibleItems.map((item) => {
              const isRowExpanded = expandedProductId === item.productId;
              const sCost = computed.pickItemCost(item.mercadoSouza, historyLens, costBasis);
              const nCost = computed.pickItemCost(item.neSupermercado, historyLens, costBasis);
              const bothReal =
                item.mercadoSouza.hasRealHistory && item.neSupermercado.hasRealHistory;
              const rowDiff = Number((sCost - nCost).toFixed(2));
              const absRowDiff = Math.abs(rowDiff);

              const souzaRangeMin =
                (costBasis === 'CASH'
                  ? item.mercadoSouza.minCashCost
                  : item.mercadoSouza.minProportionalCost) * portionMultiplier;
              const souzaRangeMax =
                (costBasis === 'CASH'
                  ? item.mercadoSouza.maxCashCost
                  : item.mercadoSouza.maxProportionalCost) * portionMultiplier;
              const neRangeMin =
                (costBasis === 'CASH'
                  ? item.neSupermercado.minCashCost
                  : item.neSupermercado.minProportionalCost) * portionMultiplier;
              const neRangeMax =
                (costBasis === 'CASH'
                  ? item.neSupermercado.maxCashCost
                  : item.neSupermercado.maxProportionalCost) * portionMultiplier;

              const mergedTimelineRows = [
                ...item.mercadoSouza.pricePoints.map((pt) => ({
                  store: 'Mercado Souza',
                  ...pt
                })),
                ...item.neSupermercado.pricePoints.map((pt) => ({
                  store: 'NE Supermercado',
                  ...pt
                }))
              ].sort(
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

                      <div className="md:col-span-3 md:text-right tabular-nums">
                        {item.mercadoSouza.hasRealHistory ? (
                          <>
                            <p
                              className={`font-bold ${
                                bothReal && sCost < nCost - 0.05
                                  ? 'text-sky-300'
                                  : 'text-slate-200'
                              }`}
                            >
                              R$ {sCost.toFixed(2)}
                            </p>
                            <p className="text-[10px] text-slate-400">
                              {item.mercadoSouza.observationsCount} leit. · mín R${' '}
                              {souzaRangeMin.toFixed(2)}–{souzaRangeMax.toFixed(2)}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-slate-400">R$ {sCost.toFixed(2)} (est.)</p>
                            <p className="text-[10px] text-amber-300/90">Sem leitura no histórico</p>
                          </>
                        )}
                      </div>

                      <div className="md:col-span-3 md:text-right tabular-nums">
                        {item.neSupermercado.hasRealHistory ? (
                          <>
                            <p
                              className={`font-bold ${
                                bothReal && nCost < sCost - 0.05
                                  ? 'text-emerald-300'
                                  : 'text-slate-200'
                              }`}
                            >
                              R$ {nCost.toFixed(2)}
                            </p>
                            <p className="text-[10px] text-slate-400">
                              {item.neSupermercado.observationsCount} leit. · mín R${' '}
                              {neRangeMin.toFixed(2)}–{neRangeMax.toFixed(2)}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-slate-400">R$ {nCost.toFixed(2)} (est.)</p>
                            <p className="text-[10px] text-amber-300/90">Sem leitura no histórico</p>
                          </>
                        )}
                      </div>

                      <div className="md:col-span-2 md:text-right tabular-nums text-[11px] font-semibold">
                        {!bothReal ? (
                          <span className="text-slate-400 font-normal">Parcial</span>
                        ) : absRowDiff <= 0.05 ? (
                          <span className="text-slate-300">Empate</span>
                        ) : rowDiff > 0 ? (
                          <span className="text-emerald-400">
                            NE -R$ {absRowDiff.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-sky-400">
                            Souza -R$ {absRowDiff.toFixed(2)}
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
                        <div className="px-4 py-3 space-y-2.5 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">
                            <span>
                              Registros históricos no banco para{' '}
                              <strong className="text-white">{item.productName}</strong>
                            </span>
                            <span className="text-slate-400 tabular-nums">
                              Pacote padrão: {item.standardPackageSize} {item.baseUnit}
                            </span>
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
                                      className={`text-[11px] font-semibold truncate ${
                                        obs.store === 'NE Supermercado'
                                          ? 'text-emerald-300'
                                          : 'text-sky-300'
                                      }`}
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
    </section>
  );
}
