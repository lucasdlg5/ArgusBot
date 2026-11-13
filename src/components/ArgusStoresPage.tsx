'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { fetchPublicDashboardFallback } from '@/lib/public-bi-client';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowUpDown,
  Award,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  Flame,
  MapPin,
  Package,
  Receipt,
  Search,
  ShoppingBag,
  Store,
  Tag,
  TrendingDown,
  TrendingUp,
  Utensils,
  Wallet,
  X
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from 'recharts';
import type { StoreBiDetail } from '@/types/argus';

interface StoresApiResponse {
  status: string;
  generatedAt?: string;
  storesBi: StoreBiDetail[];
}

type StoreSortKey = 'TOTAL_SPENT' | 'CURRENT_MONTH' | 'DAILY_RATE' | 'RECEIPTS' | 'NAME';

function formatCurrency(val: number): string {
  return `R$ ${val.toFixed(2)}`;
}

function formatDatePt(iso: string | null): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function formatDateTimePt(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function describeCompetitiveness(idx: number | null): {
  label: string;
  colorClass: string;
} {
  if (idx === null || !Number.isFinite(idx)) {
    return { label: 'Sem índice comparativo ainda', colorClass: 'text-slate-400' };
  }
  if (idx <= 96) {
    return {
      label: `Índice ${idx} · Muito competitivo (abaixo da média)`,
      colorClass: 'text-emerald-400'
    };
  }
  if (idx >= 104) {
    return {
      label: `Índice ${idx} · Acima da média regional`,
      colorClass: 'text-rose-400'
    };
  }
  return {
    label: `Índice ${idx} · Na média regional`,
    colorClass: 'text-amber-300'
  };
}

export default function ArgusStoresPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlStoreId = searchParams.get('id');

  const [stores, setStores] = useState<StoreBiDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<StoreSortKey>('TOTAL_SPENT');

  const loadStores = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const isGitHubPages =
        typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');

      if (!isGitHubPages) {
        const res = await fetch(`/api/stores?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as StoresApiResponse;
          setStores(json.storesBi || []);
          return;
        }
      }

      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      const { data: payload } = await fetchPublicDashboardFallback<StoresApiResponse>(basePath);
      setStores(payload.storesBi || []);
    } catch (err) {
      setErrorMsg((err as Error).message || 'Falha ao carregar B.I. dos mercados.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStores();
  }, [loadStores]);

  const selectedStore = useMemo(() => {
    if (!urlStoreId) return null;
    return (
      stores.find((s) => s.storeId === urlStoreId) ||
      stores.find(
        (s) => s.tradingName.toLowerCase() === decodeURIComponent(urlStoreId).toLowerCase()
      ) ||
      null
    );
  }, [stores, urlStoreId]);

  const filteredStores = useMemo(() => {
    const term = searchQuery.trim().toLowerCase();
    const list = stores.filter((st) => {
      if (!term) return true;
      return (
        st.tradingName.toLowerCase().includes(term) ||
        st.rawName.toLowerCase().includes(term) ||
        st.address.toLowerCase().includes(term) ||
        st.cnpj.toLowerCase().includes(term) ||
        (st.mostConsumedProduct?.productName.toLowerCase().includes(term) ?? false)
      );
    });

    const sorted = [...list];
    switch (sortBy) {
      case 'CURRENT_MONTH':
        sorted.sort((a, b) => b.currentMonthSpent - a.currentMonthSpent);
        break;
      case 'DAILY_RATE':
        sorted.sort((a, b) => b.dailySpendRateHistorical - a.dailySpendRateHistorical);
        break;
      case 'RECEIPTS':
        sorted.sort((a, b) => b.receiptsCount - a.receiptsCount);
        break;
      case 'NAME':
        sorted.sort((a, b) => a.tradingName.localeCompare(b.tradingName, 'pt-BR'));
        break;
      case 'TOTAL_SPENT':
      default:
        sorted.sort(
          (a, b) =>
            b.totalSpentAllTime - a.totalSpentAllTime || b.receiptsCount - a.receiptsCount
        );
        break;
    }
    return sorted;
  }, [stores, searchQuery, sortBy]);

  const networkTotals = useMemo(() => {
    const totalAllTime = stores.reduce((acc, s) => acc + s.totalSpentAllTime, 0);
    const totalCurrentMonth = stores.reduce((acc, s) => acc + s.currentMonthSpent, 0);
    const totalReceipts = stores.reduce((acc, s) => acc + s.receiptsCount, 0);
    const totalCollected = stores.reduce((acc, s) => acc + s.collectedPricesCount, 0);
    const currentMonthLabel = stores[0]?.currentMonthLabel || 'Mês atual';

    return {
      storesCount: stores.length,
      totalAllTime,
      totalCurrentMonth,
      totalReceipts,
      totalCollected,
      currentMonthLabel
    };
  }, [stores]);

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* TOPBAR DE NAVEGAÇÃO */}
        <header className="flex flex-col gap-4 border-b border-slate-800/80 pb-5 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Painel Executivo
              </Link>
              <span className="text-slate-700" aria-hidden="true">
                /
              </span>
              <Link
                href="/produtos"
                className="inline-flex items-center gap-1.5 text-slate-400 hover:text-sky-300 transition-colors"
              >
                <Package className="h-3.5 w-3.5" />
                Produtos Escaneados
              </Link>
              <span className="text-slate-700" aria-hidden="true">
                /
              </span>
              <Link
                href="/receitas"
                className="inline-flex items-center gap-1.5 text-slate-400 hover:text-amber-300 transition-colors"
              >
                <Utensils className="h-3.5 w-3.5" />
                Receitas &amp; Cadeia Fria
              </Link>
            </div>

            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2.5 pt-1">
              <Store className="h-6 w-6 text-emerald-400 shrink-0" />
              {selectedStore ? `B.I. do Mercado: ${selectedStore.tradingName}` : 'Mercados & Inteligência por Loja'}
            </h1>
            <p className="text-xs text-slate-400">
              {selectedStore
                ? 'Raio-X financeiro completo da loja: total já gasto, frequência diária, mês atual, produto mais consumido e histórico de cupons.'
                : 'Selecione um mercado abaixo para abrir seu painel individual de Business Intelligence.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {selectedStore ? (
              <>
                <Link
                  href="/mercados"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:border-slate-500 px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Todos os Mercados
                </Link>
                <Link
                  href={`/produtos?store=${encodeURIComponent(selectedStore.storeId)}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-3.5 py-2 text-xs font-semibold text-slate-950 transition-colors"
                >
                  <Package className="h-3.5 w-3.5" />
                  Produtos deste Mercado
                </Link>
              </>
            ) : (
              <Link
                href="/produtos"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 hover:border-emerald-500/50 hover:text-emerald-300 px-4 py-2 text-xs font-medium text-slate-200 transition-colors"
              >
                <Package className="h-4 w-4 text-emerald-400" />
                Ver Catálogo Completo de Produtos
              </Link>
            )}
          </div>
        </header>

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-56 rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse"
              />
            ))}
          </div>
        ) : selectedStore ? (
          /* ===================================================================
             VISÃO B.I. INDIVIDUAL DO MERCADO SELECIONADO
          =================================================================== */
          <motion.div
            key={selectedStore.storeId}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-6"
          >
            {/* Identidade da Loja & Troca Rápida */}
            <section className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    {selectedStore.address}
                  </span>
                  <span className="text-slate-600" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-mono text-slate-400">CNPJ: {selectedStore.cnpj}</span>
                  {selectedStore.rawName &&
                    selectedStore.rawName !== selectedStore.tradingName && (
                      <>
                        <span className="text-slate-600" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-slate-400">Razão/Origem: {selectedStore.rawName}</span>
                      </>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span
                    className={
                      describeCompetitiveness(selectedStore.overallCompetitivenessIndex).colorClass
                    }
                  >
                    {describeCompetitiveness(selectedStore.overallCompetitivenessIndex).label}
                  </span>
                  <span className="text-slate-600" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-slate-400 tabular-nums">
                    Primeira compra: {formatDatePt(selectedStore.firstPurchaseAt)} · Última:{' '}
                    {formatDatePt(selectedStore.lastPurchaseAt)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <label htmlFor="store-switcher" className="text-xs text-slate-400">
                  Trocar mercado:
                </label>
                <select
                  id="store-switcher"
                  value={selectedStore.storeId}
                  onChange={(e) =>
                    router.push(`/mercados?id=${encodeURIComponent(e.target.value)}`)
                  }
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                >
                  {stores.map((st) => (
                    <option key={st.storeId} value={st.storeId} className="bg-slate-950">
                      {st.tradingName} ({formatCurrency(st.totalSpentAllTime)})
                    </option>
                  ))}
                </select>
              </div>
            </section>

            {/* 4 KPI CARDS DE B.I. DO MERCADO */}
            <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {/* KPI 1: Total já gasto */}
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/15 p-4">
                <div className="flex items-center justify-between text-xs text-emerald-300">
                  <span>Quanto já foi gasto (Total)</span>
                  <Wallet className="h-4 w-4 text-emerald-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-white tabular-nums">
                  {formatCurrency(selectedStore.totalSpentAllTime)}
                </p>
                <p className="mt-1.5 text-[11px] text-slate-300 tabular-nums">
                  {selectedStore.receiptsCount} cupom(ns) · Ticket médio{' '}
                  {formatCurrency(selectedStore.avgTicket)}
                </p>
                {selectedStore.totalDiscountAllTime > 0 && (
                  <p className="mt-0.5 text-[11px] text-emerald-400 tabular-nums">
                    Descontos acumulados: {formatCurrency(selectedStore.totalDiscountAllTime)}
                  </p>
                )}
              </div>

              {/* KPI 2: Gasto Mensal do Mês Atual */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between text-xs text-slate-300">
                  <span>Gasto Mensal ({selectedStore.currentMonthLabel})</span>
                  <Calendar className="h-4 w-4 text-sky-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-white tabular-nums">
                  {formatCurrency(selectedStore.currentMonthSpent)}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
                  <span className="text-slate-400">
                    {selectedStore.currentMonthReceiptsCount} cupom(ns) neste mês
                  </span>
                  {selectedStore.momSpendDeltaPct !== null && (
                    <span
                      className={`inline-flex items-center gap-0.5 font-semibold ${
                        selectedStore.momSpendDeltaPct > 0
                          ? 'text-rose-400'
                          : selectedStore.momSpendDeltaPct < 0
                            ? 'text-emerald-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {selectedStore.momSpendDeltaPct > 0 ? (
                        <TrendingUp className="h-3 w-3" />
                      ) : (
                        <TrendingDown className="h-3 w-3" />
                      )}
                      {selectedStore.momSpendDeltaPct > 0 ? '+' : ''}
                      {selectedStore.momSpendDeltaPct.toFixed(1)}% vs mês ant. (
                      {formatCurrency(selectedStore.previousMonthSpent)})
                    </span>
                  )}
                </div>
              </div>

              {/* KPI 3: Frequência Diária de Gasto */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between text-xs text-slate-300">
                  <span>Frequência Diária de Gasto</span>
                  <Clock className="h-4 w-4 text-amber-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-amber-300 tabular-nums">
                  {formatCurrency(selectedStore.dailySpendRateHistorical)}/dia
                </p>
                <p className="mt-1.5 text-[11px] text-slate-300 tabular-nums">
                  Ritmo no mês atual:{' '}
                  <strong className="text-white">
                    {formatCurrency(selectedStore.dailySpendRateCurrentMonth)}/dia
                  </strong>
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400 tabular-nums">
                  {selectedStore.avgDaysBetweenVisits !== null
                    ? `1 ida a cada ${selectedStore.avgDaysBetweenVisits} dias (${selectedStore.visitsPerWeek} visitas/sem)`
                    : `${selectedStore.visitsPerWeek} visitas/sem · ${selectedStore.activeSpanDays} dias de janela`}
                </p>
              </div>

              {/* KPI 4: Produto Mais Consumido */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between text-xs text-slate-300">
                  <span>Produto Mais Consumido</span>
                  <Award className="h-4 w-4 text-emerald-400" />
                </div>
                {selectedStore.mostConsumedProduct ? (
                  <>
                    <p
                      className="mt-2 text-base font-bold text-white leading-snug line-clamp-2"
                      title={selectedStore.mostConsumedProduct.productName}
                    >
                      {selectedStore.mostConsumedProduct.productName}
                    </p>
                    <p className="mt-1 text-[11px] text-emerald-400 tabular-nums">
                      {selectedStore.mostConsumedProduct.timesPurchased}x comprado ·{' '}
                      {formatCurrency(selectedStore.mostConsumedProduct.totalSpent)} gastos
                    </p>
                    {selectedStore.highestSpendProduct &&
                      selectedStore.highestSpendProduct.canonicalProductId !==
                        selectedStore.mostConsumedProduct.canonicalProductId && (
                        <p className="mt-0.5 text-[11px] text-slate-400 truncate">
                          Maior desembolso: {selectedStore.highestSpendProduct.productName} (
                          {formatCurrency(selectedStore.highestSpendProduct.totalSpent)})
                        </p>
                      )}
                  </>
                ) : (
                  <p className="mt-2 text-sm text-slate-400">
                    Ainda sem itens de cupom vinculados a esta loja.
                  </p>
                )}
              </div>
            </section>

            {/* GRÁFICOS: EVOLUÇÃO MENSAL & FREQUÊNCIA POR DIA DA SEMANA */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Evolução Mensal */}
              <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-5">
                <div className="mb-4">
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-emerald-400" />
                    Evolução Mensal de Gastos (Últimos 6 Meses)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Total desembolsado por mês exclusivamente no {selectedStore.tradingName}
                  </p>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={selectedStore.monthlySeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="monthLabel" stroke="#94a3b8" fontSize={11} />
                      <YAxis stroke="#94a3b8" fontSize={11} />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: '#0f172a',
                          borderColor: '#1e293b',
                          borderRadius: '8px',
                          fontSize: '12px'
                        }}
                        formatter={(val: number, _name, item) => {
                          const p = item?.payload as
                            | { receiptsCount?: number; avgTicket?: number }
                            | undefined;
                          return [
                            `R$ ${Number(val).toFixed(2)} (${p?.receiptsCount ?? 0} cupons · Ticket R$ ${(
                              p?.avgTicket ?? 0
                            ).toFixed(2)})`,
                            'Gasto Mensal'
                          ];
                        }}
                      />
                      <Bar
                        dataKey="totalSpent"
                        name="Gasto Mensal (R$)"
                        fill="#10b981"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Frequência por Dia da Semana */}
              <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-5">
                <div className="mb-4">
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <Flame className="h-4 w-4 text-amber-400" />
                    Frequência Semanal de Gasto (Dom–Sáb)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Em quais dias da semana você mais compra e gasta neste mercado
                  </p>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={selectedStore.weekdaySeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="weekdayLabel" stroke="#94a3b8" fontSize={11} />
                      <YAxis stroke="#94a3b8" fontSize={11} />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: '#0f172a',
                          borderColor: '#1e293b',
                          borderRadius: '8px',
                          fontSize: '12px'
                        }}
                        formatter={(val: number, _name, item) => {
                          const p = item?.payload as
                            | { receiptsCount?: number; avgSpentPerVisit?: number }
                            | undefined;
                          return [
                            `R$ ${Number(val).toFixed(2)} (${p?.receiptsCount ?? 0} compras · Média R$ ${(
                              p?.avgSpentPerVisit ?? 0
                            ).toFixed(2)}/ida)`,
                            'Total no Dia'
                          ];
                        }}
                      />
                      <Bar
                        dataKey="totalSpent"
                        name="Gasto por Dia da Semana (R$)"
                        fill="#f59e0b"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </section>

            {/* CATEGORIAS + MEIOS DE PAGAMENTO */}
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Distribuição por Corredor / Categoria */}
              <div className="lg:col-span-7 rounded-xl border border-slate-800/90 bg-slate-900/60 p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-bold text-white">
                    Distribuição de Gastos por Corredor &amp; Competitividade
                  </h2>
                  <p className="text-xs text-slate-400">
                    Categorias onde seu dinheiro está indo neste mercado e comparação regional (índice 100 = média)
                  </p>
                </div>

                {selectedStore.categoryBreakdown.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4">
                    Nenhuma categoria auditada em itens de cupom para este mercado ainda.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {selectedStore.categoryBreakdown.map((cat) => (
                      <div key={cat.category} className="space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-white">
                            {cat.category}{' '}
                            <span className="text-slate-400 font-normal">
                              ({cat.itemsCount} itens)
                            </span>
                          </span>
                          <div className="flex items-center gap-3 tabular-nums">
                            {cat.competitivenessIndex !== null && (
                              <span
                                className={`text-[11px] font-semibold ${
                                  cat.competitivenessIndex <= 96
                                    ? 'text-emerald-400'
                                    : cat.competitivenessIndex >= 104
                                      ? 'text-rose-400'
                                      : 'text-amber-300'
                                }`}
                              >
                                Índice {cat.competitivenessIndex}
                              </span>
                            )}
                            <span className="font-semibold text-white">
                              {formatCurrency(cat.totalSpent)} ({cat.sharePct.toFixed(1)}%)
                            </span>
                          </div>
                        </div>
                        <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${Math.min(100, cat.sharePct)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Meios de Pagamento + Resumo de Preços Coletados */}
              <div className="lg:col-span-5 rounded-xl border border-slate-800/90 bg-slate-900/60 p-5 space-y-4">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-sky-400" />
                    Formas de Pagamento Utilizadas
                  </h2>
                  <p className="text-xs text-slate-400">
                    Como as compras deste mercado foram pagas ({selectedStore.receiptsCount} cupons)
                  </p>
                </div>

                {selectedStore.paymentBreakdown.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4">
                    Sem histórico de pagamentos registrado.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {selectedStore.paymentBreakdown.map((pm) => (
                      <div key={pm.method} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-200">
                            {pm.method}{' '}
                            <span className="text-slate-400 font-normal">
                              ({pm.receiptsCount}x)
                            </span>
                          </span>
                          <span className="font-semibold text-white tabular-nums">
                            {formatCurrency(pm.totalSpent)} ({pm.sharePct.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-sky-400"
                            style={{ width: `${Math.min(100, pm.sharePct)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="border-t border-slate-800 pt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-[11px] text-slate-400">Itens em Cupons</p>
                    <p className="mt-1 text-lg font-bold text-white tabular-nums">
                      {selectedStore.itemsPurchasedCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-[11px] text-slate-400">Preços de Gôndola/Flyer</p>
                    <p className="mt-1 text-lg font-bold text-sky-300 tabular-nums">
                      {selectedStore.collectedPricesCount}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* RANKING DOS PRODUTOS MAIS CONSUMIDOS NESTE MERCADO */}
            <section className="rounded-xl border border-slate-800/90 bg-slate-900/60 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <ShoppingBag className="h-4 w-4 text-emerald-400" />
                    Produtos Mais Consumidos no {selectedStore.tradingName}
                  </h2>
                  <p className="text-xs text-slate-400">
                    Ordenado pela frequência de compra e volume financeiro no histórico real
                  </p>
                </div>
                <Link
                  href={`/produtos?store=${encodeURIComponent(selectedStore.storeId)}`}
                  className="text-xs font-semibold text-emerald-400 hover:text-emerald-300"
                >
                  Ver todas as leituras deste mercado →
                </Link>
              </div>

              {selectedStore.topProducts.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">
                  Nenhum item comprado em cupons fiscais registrado para este mercado ainda.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/70 text-[11px] uppercase tracking-wider text-slate-400">
                        <th className="py-3 px-4">#</th>
                        <th className="py-3 px-4">Produto</th>
                        <th className="py-3 px-4">Marca Principal</th>
                        <th className="py-3 px-4 text-right">Compras</th>
                        <th className="py-3 px-4 text-right">Preço Médio Unit.</th>
                        <th className="py-3 px-4 text-right">Total Gasto</th>
                        <th className="py-3 px-4 text-right">Última Compra</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {selectedStore.topProducts.map((prod, idx) => (
                        <tr
                          key={prod.canonicalProductId}
                          className="hover:bg-slate-900/80 transition-colors"
                        >
                          <td className="py-3 px-4 font-mono text-slate-500 tabular-nums">
                            {idx + 1}º
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-semibold text-white">{prod.productName}</p>
                            <p className="text-[11px] text-slate-400">{prod.category}</p>
                          </td>
                          <td className="py-3 px-4 text-sky-300 font-medium">
                            <span className="inline-flex items-center gap-1">
                              <Tag className="h-3 w-3 shrink-0" />
                              {prod.topBrand}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-white tabular-nums">
                            {prod.timesPurchased}x
                          </td>
                          <td className="py-3 px-4 text-right text-slate-300 tabular-nums">
                            {formatCurrency(prod.avgUnitPrice)}
                          </td>
                          <td className="py-3 px-4 text-right font-bold text-emerald-400 tabular-nums">
                            {formatCurrency(prod.totalSpent)}
                          </td>
                          <td className="py-3 px-4 text-right text-slate-400 tabular-nums">
                            {formatDatePt(prod.lastPurchasedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* HISTÓRICO DE CUPONS FISCAIS DO MERCADO */}
            <section className="rounded-xl border border-slate-800/90 bg-slate-900/60 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Receipt className="h-4 w-4 text-emerald-400" />
                  Histórico de Cupons Fiscais ({selectedStore.recentReceipts.length})
                </h2>
              </div>

              {selectedStore.recentReceipts.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">
                  Nenhum cupom NFC-e cadastrado para este estabelecimento.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/70 text-[11px] uppercase tracking-wider text-slate-400">
                        <th className="py-3 px-4">Data e Hora</th>
                        <th className="py-3 px-4">Pagamento</th>
                        <th className="py-3 px-4 text-right">Itens</th>
                        <th className="py-3 px-4 text-right">Desconto</th>
                        <th className="py-3 px-4">Open Finance</th>
                        <th className="py-3 px-4 text-right">Valor Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {selectedStore.recentReceipts.map((rec) => (
                        <tr
                          key={rec.receiptId}
                          className="hover:bg-slate-900/80 transition-colors"
                        >
                          <td className="py-3 px-4 text-slate-200 tabular-nums">
                            {formatDateTimePt(rec.purchaseDate)}
                          </td>
                          <td className="py-3 px-4 text-slate-300">{rec.paymentMethod}</td>
                          <td className="py-3 px-4 text-right text-slate-300 tabular-nums">
                            {rec.itemsCount}
                          </td>
                          <td className="py-3 px-4 text-right text-amber-300 tabular-nums">
                            {rec.discountAmount > 0 ? formatCurrency(rec.discountAmount) : '—'}
                          </td>
                          <td className="py-3 px-4">
                            {rec.reconciled ? (
                              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Conciliado Pluggy
                              </span>
                            ) : (
                              <span className="text-slate-400">Pendente / Dinheiro</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-bold text-white tabular-nums">
                            {formatCurrency(rec.totalAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </motion.div>
        ) : (
          /* ===================================================================
             DIRETÓRIO DE MERCADOS
          =================================================================== */
          <div className="space-y-6">
            {/* KPIs CONSOLIDADOS DA REDE DE MERCADOS */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                <p className="text-xs text-slate-400">Mercados Mapeados</p>
                <p className="mt-1.5 text-2xl font-bold text-white tabular-nums">
                  {networkTotals.storesCount}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  Clique em qualquer loja para abrir o B.I.
                </p>
              </div>

              <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                <p className="text-xs text-slate-400">Total Já Gasto (Histórico)</p>
                <p className="mt-1.5 text-2xl font-bold text-emerald-400 tabular-nums">
                  {formatCurrency(networkTotals.totalAllTime)}
                </p>
                <p className="mt-1 text-[11px] text-slate-400 tabular-nums">
                  Soma em todos os estabelecimentos
                </p>
              </div>

              <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                <p className="text-xs text-slate-400">
                  Mês Atual ({networkTotals.currentMonthLabel})
                </p>
                <p className="mt-1.5 text-2xl font-bold text-sky-300 tabular-nums">
                  {formatCurrency(networkTotals.totalCurrentMonth)}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  Consolidado do mês vigente
                </p>
              </div>

              <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                <p className="text-xs text-slate-400">Cupons &amp; Leituras</p>
                <p className="mt-1.5 text-2xl font-bold text-amber-300 tabular-nums">
                  {networkTotals.totalReceipts}
                </p>
                <p className="mt-1 text-[11px] text-slate-400 tabular-nums">
                  +{networkTotals.totalCollected} preços de gôndola/flyers
                </p>
              </div>
            </section>

            {/* BUSCA & ORDENAÇÃO */}
            <section className="rounded-xl border border-slate-800/90 bg-slate-900/50 p-4 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  aria-label="Buscar mercado por nome, endereço, CNPJ ou produto"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && searchQuery) {
                      e.preventDefault();
                      setSearchQuery('');
                    }
                  }}
                  placeholder="Buscar mercado (ex: Souza, NE), endereço ou produto..."
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-9 pr-8 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                />
                {searchQuery.length > 0 && (
                  <button
                    type="button"
                    aria-label="Limpar busca de mercados"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
                <ArrowUpDown className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                <select
                  aria-label="Ordenar mercados"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as StoreSortKey)}
                  className="bg-transparent text-xs text-slate-200 focus:outline-none"
                >
                  <option value="TOTAL_SPENT" className="bg-slate-950">
                    Maior gasto total
                  </option>
                  <option value="CURRENT_MONTH" className="bg-slate-950">
                    Maior gasto no mês atual
                  </option>
                  <option value="DAILY_RATE" className="bg-slate-950">
                    Maior frequência diária (R$/dia)
                  </option>
                  <option value="RECEIPTS" className="bg-slate-950">
                    Mais cupons escaneados
                  </option>
                  <option value="NAME" className="bg-slate-950">
                    Nome (A–Z)
                  </option>
                </select>
              </div>
            </section>

            {/* CARDS DE MERCADOS */}
            {filteredStores.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-10 text-center space-y-2">
                <Store className="h-10 w-10 text-slate-600 mx-auto" />
                <p className="text-base font-semibold text-white">
                  Nenhum mercado encontrado
                </p>
                <p className="text-xs text-slate-400">
                  Envie fotos de cupons fiscais ou gôndolas para o @MonetaArgusBot para alimentar os indicadores de loja.
                </p>
              </div>
            ) : (
              <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredStores.map((st) => {
                  const comp = describeCompetitiveness(st.overallCompetitivenessIndex);
                  return (
                    <Link
                      key={st.storeId}
                      href={`/mercados?id=${encodeURIComponent(st.storeId)}`}
                      className="group rounded-xl border border-slate-800/90 bg-slate-900/60 hover:border-emerald-500/60 hover:bg-slate-900 p-5 flex flex-col justify-between gap-4 transition-all"
                    >
                      <div className="space-y-2.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="text-base font-bold text-white group-hover:text-emerald-300 transition-colors truncate">
                              {st.tradingName}
                            </h2>
                            <p className="text-[11px] text-slate-400 truncate mt-0.5">
                              {st.address}
                            </p>
                          </div>
                          <span className="text-xs font-semibold text-emerald-400 shrink-0">
                            B.I. →
                          </span>
                        </div>

                        <p className={`text-[11px] font-medium ${comp.colorClass}`}>
                          {comp.label}
                        </p>

                        <div className="grid grid-cols-2 gap-3 pt-1">
                          <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 p-2.5">
                            <p className="text-[10px] uppercase tracking-wider text-slate-500">
                              Total Já Gasto
                            </p>
                            <p className="mt-0.5 text-base font-bold text-white tabular-nums">
                              {formatCurrency(st.totalSpentAllTime)}
                            </p>
                            <p className="text-[10px] text-slate-400 tabular-nums">
                              {st.receiptsCount} cupons · méd {formatCurrency(st.avgTicket)}
                            </p>
                          </div>

                          <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 p-2.5">
                            <p className="text-[10px] uppercase tracking-wider text-slate-500">
                              {st.currentMonthLabel}
                            </p>
                            <p className="mt-0.5 text-base font-bold text-sky-300 tabular-nums">
                              {formatCurrency(st.currentMonthSpent)}
                            </p>
                            <p className="text-[10px] text-slate-400 tabular-nums">
                              {formatCurrency(st.dailySpendRateHistorical)}/dia hist.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-slate-800/80 pt-3 flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <span className="text-[10px] uppercase tracking-wider text-slate-500 block">
                            Mais consumido
                          </span>
                          <span className="text-xs font-medium text-slate-200 truncate block">
                            {st.mostConsumedProduct
                              ? `${st.mostConsumedProduct.productName} (${st.mostConsumedProduct.timesPurchased}x)`
                              : `${st.collectedPricesCount} preços coletados`}
                          </span>
                        </div>
                        <span className="text-[11px] font-semibold text-emerald-400 group-hover:translate-x-0.5 transition-transform shrink-0">
                          Abrir painel →
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
