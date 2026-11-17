'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { fetchPublicDashboardFallback } from '@/lib/public-bi-client';
import { APP_VERSION_LABEL } from '@/config/version';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  Eye,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Wallet,
  CreditCard,
  Utensils,
  Car,
  Navigation,
  Send,
  RefreshCw,
  CheckCircle2,
  ChevronDown,
  Flame,
  Gauge,
  Snowflake,
  Store,
  Sparkles,
  Scale,
  Receipt,
  Timer,
  Package,
  Clock,
  Landmark
} from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  BarChart,
  Bar
} from 'recharts';
import type {
  CurrentProductPriceView,
  OptimizationVerdict,
  PersonalInflationAndShrinkflationView,
  RecipeCostEvaluation,
  ReconciliationSummary,
  StoreCategoryHeatmapView,
  TrueSpendingBreakdownView,
  OpenFinanceTransaction,
  ReceiptDetailEntry
} from '@/types/argus';
import RecipeStoreComparisonCard from './RecipeStoreComparisonCard';

const ArgusLogisticsMap = dynamic(() => import('./ArgusLogisticsMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[380px] w-full items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-sm text-slate-400">
      Carregando motor cartográfico OSRM / OpenStreetMap...
    </div>
  )
});

interface CollectedPriceRecord {
  id: string;
  source_kind: string;
  store_name: string;
  store_neighborhood?: string | null;
  raw_product_description: string;
  price: number;
  promo_or_club_price?: number | null;
  unit_type: string;
  confidence_score: number;
  missing_info_flags: string[];
  collected_at: string;
}

interface DashboardPayload {
  generatedAt?: string;
  homeLocation: { lat: number; lng: number; address: string };
  kpis: {
    totalMonthSpent: number;
    potentialMonthlySavings: number;
    vrVaBurnAmount: number;
    vrVaMonthlyBudget: number;
    vrVaBurnRatePct: number;
    reconciliationRatePct: number;
    scannedReceiptsCount: number;
    pluggyTransactionsCount: number;
    collectedPricesCount?: number;
  };
  currentPrices: CurrentProductPriceView[];
  heatmap: StoreCategoryHeatmapView[];
  inflation: PersonalInflationAndShrinkflationView[];
  spendingBreakdown: TrueSpendingBreakdownView[];
  priceEvolutionSeries: Array<Record<string, string | number>>;
  recipesEvaluations: RecipeCostEvaluation[];
  logisticsVerdict: OptimizationVerdict;
  reconciliation: ReconciliationSummary;
  openFinanceTransactions: OpenFinanceTransaction[];
  receiptsDetailed?: ReceiptDetailEntry[];
  collectedPrices?: CollectedPriceRecord[];
  queueSummary?: Array<{ status: string; total: number }>;
}

const PILLAR_COLORS: Record<string, string> = {
  'Alimentação Essencial': '#10b981',
  'Limpeza & Higiene': '#38bdf8',
  'Besteiras/Impulso': '#f59e0b',
  'Combustível & Logística': '#a855f7'
};

export default function ArgusVisionDashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [dataSourceLabel, setDataSourceLabel] = useState<string>('API Local');
  const [activeTab, setActiveTab] = useState<'ALL' | 'M1' | 'M2' | 'M3' | 'M4'>('ALL');
  const [selectedRecipeIdx, setSelectedRecipeIdx] = useState<number>(0);
  const [expandedDashRecipeId, setExpandedDashRecipeId] = useState<string | null>(null);
  const [portionMultiplier, setPortionMultiplier] = useState<number>(1);
  const [activeMapRouteMode, setActiveMapRouteMode] = useState<'SINGLE_STORE' | 'SPLIT_STORES'>(
    'SPLIT_STORES'
  );
  const [telegramFeedback, setTelegramFeedback] = useState<string | null>(null);
  const [syncingReconcile, setSyncingReconcile] = useState<boolean>(false);
  const [localNow, setLocalNow] = useState<Date | null>(null);

  useEffect(() => {
    setLocalNow(new Date());
    const timer = window.setInterval(() => {
      setLocalNow(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadDashboard() {
    setLoading(true);
    try {
      const isGitHubPages =
        typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

      // Camada 1: Servidor Node.js / Next.js Local (quando não hospedado no github.io)
      if (!isGitHubPages) {
        try {
          const res = await fetch(`${basePath}/api/dashboard`, { cache: 'no-store' });
          if (res.ok) {
            const json = (await res.json()) as DashboardPayload;
            setData(json);
            setDataSourceLabel('🟢 Live Node API (/api/dashboard)');
            return;
          }
        } catch {
          // Segue para Render Live API / Supabase / Snapshot Estático
        }
      }

      // Camadas 2-4: Render Live API -> Supabase Cloud -> Snapshot Estático
      const { data: fallbackData, sourceLabel } =
        await fetchPublicDashboardFallback<DashboardPayload>(basePath);
      setData(fallbackData);
      setDataSourceLabel(sourceLabel);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDashboard();
  }, []);

  async function handleRunReconciliation() {
    setSyncingReconcile(true);
    try {
      const isGitHubPages =
        typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
      if (!isGitHubPages) {
        await fetch('/api/reconcile', { method: 'POST' }).catch(() => {});
      } else {
        setTelegramFeedback(
          '☁️ Atualizando dados ao vivo do Supabase Storage (use /reconciliar no @MonetaArgusBot para disparar conciliação completa).'
        );
        setTimeout(() => setTelegramFeedback(null), 6000);
      }
      await loadDashboard();
    } finally {
      setSyncingReconcile(false);
    }
  }

  async function handleSendListToTelegram() {
    if (!data) return;
    const scenario =
      activeMapRouteMode === 'SPLIT_STORES'
        ? data.logisticsVerdict.splitStoreBest
        : data.logisticsVerdict.singleStoreBest;

    const lines = [
      '👁️ *ARGUS (@MonetaArgusBot) — LISTA DE COMPRAS OTIMIZADA*',
      `_${scenario.title}_`,
      `📍 Rota OSRM: *${scenario.totalDistanceKm} km* (${scenario.totalDurationMin} min)`,
      `⛽ Custo Carro: R$ ${scenario.gasCost.toFixed(2)} | 🚗 Uber: R$ ${scenario.uberCost.toFixed(2)}`,
      ''
    ];

    for (const st of scenario.storesVisited) {
      lines.push(`🏪 *${st.storeName}* (Subtotal: R$ ${st.subtotalProducts.toFixed(2)})`);
      for (const it of st.items.slice(0, 8)) {
        lines.push(`  • ${it.packages}x ${it.productName} — R$ ${it.lineTotal.toFixed(2)}`);
      }
      lines.push('');
    }
    lines.push(data.logisticsVerdict.argusVerdictText);

    try {
      const res = await fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageText: lines.join('\n') })
      });
      if (res.ok) {
        const json = (await res.json()) as { note?: string };
        setTelegramFeedback(json.note || 'Enviado ao @MonetaArgusBot!');
      } else {
        await navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
        setTelegramFeedback(
          '📋 Lista copiada! No GitHub Pages estático, você também pode pedir /otimizar direto ao @MonetaArgusBot.'
        );
      }
    } catch {
      await navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
      setTelegramFeedback(
        '📋 Lista copiada para a área de transferência! Envie /otimizar no @MonetaArgusBot.'
      );
    }
    setTimeout(() => setTelegramFeedback(null), 7000);
  }

  if (loading || !data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#090d16] text-slate-200">
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-slate-900/90 px-6 py-4 shadow-2xl">
          <Eye className="h-7 w-7 animate-pulse text-emerald-400" />
          <div>
            <p className="font-semibold text-white">Conectando ao Argus...</p>
            <p className="text-xs text-slate-400">
              Buscando dados atualizados do banco. Se o servidor estava em repouso, pode levar até 45 segundos.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Agregações do Módulo 1: "O Que Realmente Compramos"
  const latestMonth = data.spendingBreakdown[0]?.ref_month;
  const currentMonthBreakdown = data.spendingBreakdown.filter((s) => s.ref_month === latestMonth);

  const pillarTotalsMap = new Map<string, number>();
  const categoryByWalletMap = new Map<string, { category: string; BANK_ACCOUNT: number; VR_VA: number }>();

  for (const row of currentMonthBreakdown) {
    pillarTotalsMap.set(
      row.spending_pillar,
      Number(((pillarTotalsMap.get(row.spending_pillar) ?? 0) + row.total_spent).toFixed(2))
    );
    const currentCat = categoryByWalletMap.get(row.category) ?? {
      category: row.category,
      BANK_ACCOUNT: 0,
      VR_VA: 0
    };
    currentCat[row.wallet_source] = Number(
      (currentCat[row.wallet_source] + row.total_spent).toFixed(2)
    );
    categoryByWalletMap.set(row.category, currentCat);
  }

  const donutData = Array.from(pillarTotalsMap.entries()).map(([name, value]) => ({
    name,
    value,
    color: PILLAR_COLORS[name] || '#10b981'
  }));
  const walletBarData = Array.from(categoryByWalletMap.values());

  // Alertas de Reduflação & Mínima Histórica (Módulo 2)
  const shrinkflationItems = data.inflation.filter(
    (i) => i.shrinkflation_detected || i.package_reduction_pct > 0
  );
  const uniqueShrinkflation = Array.from(
    new Map(shrinkflationItems.map((item) => [item.product_name, item])).values()
  );

  const historicalLowOpportunities = data.currentPrices
    .filter((cp) => cp.estimated_package_price <= cp.min_historical_price * 1.02)
    .slice(0, 8);

  // Matriz Competitiva de Mercados (Módulo 3)
  const storeNames = Array.from(new Set(data.heatmap.map((h) => h.store_name)));
  const categories = Array.from(new Set(data.heatmap.map((h) => h.category)));

  // Receita selecionada (Módulo 4)
  const activeRecipe =
    data.recipesEvaluations[selectedRecipeIdx] ?? data.recipesEvaluations[0];

  // Gráfico Empilhado Logístico (Módulo 4)
  const logisticsComparisonChart = [
    {
      scenario: 'M. Único (Carro)',
      Produtos: data.logisticsVerdict.singleStoreBest.productsCost,
      Deslocamento: data.logisticsVerdict.singleStoreBest.gasCost,
      Total: data.logisticsVerdict.singleStoreBest.totalWithGas
    },
    {
      scenario: 'M. Único (Uber)',
      Produtos: data.logisticsVerdict.singleStoreBest.productsCost,
      Deslocamento: data.logisticsVerdict.singleStoreBest.uberCost,
      Total: data.logisticsVerdict.singleStoreBest.totalWithUber
    },
    {
      scenario: 'Dividida (Carro)',
      Produtos: data.logisticsVerdict.splitStoreBest.productsCost,
      Deslocamento: data.logisticsVerdict.splitStoreBest.gasCost,
      Total: data.logisticsVerdict.splitStoreBest.totalWithGas
    },
    {
      scenario: 'Dividida (Uber)',
      Produtos: data.logisticsVerdict.splitStoreBest.productsCost,
      Deslocamento: data.logisticsVerdict.splitStoreBest.uberCost,
      Total: data.logisticsVerdict.splitStoreBest.totalWithUber
    }
  ];

  const showM1 = activeTab === 'ALL' || activeTab === 'M1';
  const showM2 = activeTab === 'ALL' || activeTab === 'M2';
  const showM3 = activeTab === 'ALL' || activeTab === 'M3';
  const showM4 = activeTab === 'ALL' || activeTab === 'M4';

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col lg:flex-row">
      {/* SIDEBAR DE NAVEGAÇÃO ARGUS VISION BI */}
      <aside className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800/80 bg-slate-950/90 p-5 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 pb-5 border-b border-slate-800">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 shadow-lg shadow-emerald-950/50">
              <Eye className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">Argus</h1>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30 font-mono">
                  {APP_VERSION_LABEL}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-tight mt-0.5">
                Compras, Preços e Receitas
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-1.5">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Seções
            </p>
            {[
              { id: 'ALL', label: 'Visão Geral', icon: Eye },
              { id: 'M1', label: 'Gastos do Mês', icon: Wallet },
              { id: 'M2', label: 'Variação de Preços', icon: AlertTriangle },
              { id: 'M3', label: 'Mercados', icon: Store },
              { id: 'M4', label: 'Receitas & Rotas', icon: Navigation }
            ].map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as typeof activeTab)}
                  className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition ${
                    isActive
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}

            <Link
              href="/notas"
              className="mt-2 w-full flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-left text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition"
            >
              <span className="flex items-center gap-2">
                <Receipt className="h-4 w-4 shrink-0" />
                <span>Notas Fiscais</span>
              </span>
              <span className="text-[10px] text-emerald-400">Abrir →</span>
            </Link>

            <Link
              href="/produtos"
              className="mt-2 w-full flex items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2.5 text-left text-xs font-semibold text-sky-300 hover:bg-sky-500/20 transition"
            >
              <span className="flex items-center gap-2">
                <Package className="h-4 w-4 shrink-0" />
                <span>Produtos</span>
              </span>
              <span className="text-[10px] text-sky-400">Abrir →</span>
            </Link>

            <Link
              href="/mercados"
              className="mt-2 w-full flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-left text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition"
            >
              <span className="flex items-center gap-2">
                <Store className="h-4 w-4 shrink-0" />
                <span>Mercados</span>
              </span>
              <span className="text-[10px] text-emerald-400">Abrir →</span>
            </Link>

            <Link
              href="/receitas"
              className="mt-2 w-full flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-left text-xs font-semibold text-amber-300 hover:bg-amber-500/20 transition"
            >
              <span className="flex items-center gap-2">
                <Utensils className="h-4 w-4 shrink-0" />
                <span>Receitas</span>
              </span>
              <span className="text-[10px] text-amber-400">Abrir →</span>
            </Link>
          </div>

          {/* Persona Card do Bot */}
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
            <div className="flex items-center gap-2 text-amber-300 text-xs font-semibold">
              <Sparkles className="h-4 w-4" />
              <span>@MonetaArgusBot — O Olho Fiscal</span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-300 leading-relaxed">
              &ldquo;Vigio cada centavo por grama, caço embalagens encolhidas e decido na ponta do lápis se compensa ir de carro ou de Uber.&rdquo;
            </p>
            <div className="mt-2.5 flex items-center justify-between text-[10px] text-slate-400 border-t border-amber-500/20 pt-2">
              <span>Status:</span>
              <code className="text-emerald-400 font-mono">Ativo 24h</code>
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-800/80 space-y-2">
          <button
            onClick={handleRunReconciliation}
            disabled={syncingReconcile}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-xs font-semibold text-slate-950 transition shadow-lg shadow-emerald-950/50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncingReconcile ? 'animate-spin' : ''}`} />
            <span>{syncingReconcile ? 'Atualizando dados...' : 'Atualizar & Conciliar'}</span>
          </button>
          <p className="text-[10px] text-center text-slate-500">
            Preços reais de cupons, gôndolas e receitas
          </p>
        </div>
      </aside>

      {/* CONTEÚDO PRINCIPAL */}
      <main className="flex-1 p-5 lg:p-8 space-y-8 overflow-y-auto">
        {/* TOP HEADER */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div>
            <h2 className="text-2xl font-bold text-white">
              Argus Vision
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Resumo financeiro, preços por mercado e receitas.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-1.5 text-xs text-emerald-300">
              <span>{dataSourceLabel}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-1.5 text-xs text-slate-300">
              <Receipt className="h-3.5 w-3.5 text-emerald-400" />
              {data.kpis.scannedReceiptsCount} NFC-e Auditadas
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-1.5 text-xs text-slate-300">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              {data.reconciliation.sheetsSyncedRows} linhas no Argus Ledger
            </span>
            <span
              title={`Versão atual do site: ${APP_VERSION_LABEL}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold font-mono text-emerald-300"
            >
              Versão {APP_VERSION_LABEL}
            </span>
          </div>
        </header>

        {/* BOAS-VINDAS, HORÁRIO LOCAL E RESUMO SEPARADO DO MÊS ATUAL */}
        {(() => {
          const refDate = localNow ?? new Date();
          const hour = refDate.getHours();
          const greeting =
            hour >= 5 && hour < 12
              ? 'Bom dia!'
              : hour >= 12 && hour < 18
                ? 'Boa tarde!'
                : 'Boa noite!';

          const formattedDate = localNow
            ? new Intl.DateTimeFormat('pt-BR', {
                weekday: 'long',
                day: '2-digit',
                month: 'long',
                year: 'numeric'
              }).format(localNow)
            : 'Carregando data local...';

          const formattedTime = localNow
            ? new Intl.DateTimeFormat('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
              }).format(localNow)
            : '--:--:--';

          const currentMonthKey = `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, '0')}`;
          const currentMonthLabel = new Intl.DateTimeFormat('pt-BR', {
            month: 'long',
            year: 'numeric'
          }).format(refDate);

          // Notas Fiscais alimentadas no mês atual
          const currentMonthReceipts = (data.receiptsDetailed ?? []).filter((r) =>
            String(r.purchaseDate || '').startsWith(currentMonthKey)
          );
          const hasDetailedReceipts = (data.receiptsDetailed ?? []).length > 0;
          const fallbackMonthBreakdown = data.spendingBreakdown.filter((s) =>
            String(s.ref_month || '').startsWith(currentMonthKey)
          );
          const receiptsMonthTotal = hasDetailedReceipts
            ? currentMonthReceipts.reduce((acc, r) => acc + Number(r.totalAmount || 0), 0)
            : fallbackMonthBreakdown.reduce((acc, s) => acc + Number(s.total_spent || 0), 0);
          const receiptsMonthCount = hasDetailedReceipts
            ? currentMonthReceipts.length
            : fallbackMonthBreakdown.reduce((acc, s) => acc + Number(s.receipts_count || 0), 0);
          const receiptsReconciledCount = hasDetailedReceipts
            ? currentMonthReceipts.filter((r) => r.reconciled).length
            : fallbackMonthBreakdown.reduce(
                (acc, s) => acc + Number(s.reconciled_receipts_count || 0),
                0
              );

          // Gastos recebidos do Open Finance no mês atual
          const currentMonthOpenFinance = (data.openFinanceTransactions ?? []).filter((tx) =>
            String(tx.transactionDate || '').startsWith(currentMonthKey)
          );
          const openFinanceMonthTotal = currentMonthOpenFinance.reduce(
            (acc, tx) => acc + Math.abs(Number(tx.amount || 0)),
            0
          );
          const openFinanceBankTotal = currentMonthOpenFinance
            .filter((tx) => tx.walletType === 'BANK_ACCOUNT')
            .reduce((acc, tx) => acc + Math.abs(Number(tx.amount || 0)), 0);
          const openFinanceVrVaTotal = currentMonthOpenFinance
            .filter((tx) => tx.walletType === 'VR_VA')
            .reduce((acc, tx) => acc + Math.abs(Number(tx.amount || 0)), 0);

          return (
            <section className="space-y-4">
              <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-slate-900 via-slate-900/95 to-emerald-950/30 p-5 lg:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <Sparkles className="h-3 w-3" />
                    <span>Painel Financeiro Pessoal</span>
                  </div>
                  <h3 className="text-xl lg:text-2xl font-bold text-white">
                    {greeting} Bem-vindo ao Argus Vision.
                  </h3>
                  <p className="text-sm text-slate-300">
                    Acompanhe separadamente os gastos das suas notas fiscais e os lançamentos recebidos pelo Open Finance em{' '}
                    <span className="font-semibold text-white capitalize">{currentMonthLabel}</span>.
                  </p>
                </div>

                <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-3 shrink-0">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
                    <Clock className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400 capitalize">{formattedDate}</p>
                    <p className="text-lg font-bold font-mono text-white tabular-nums">
                      {formattedTime}{' '}
                      <span className="text-[11px] font-sans font-normal text-slate-400">
                        (horário local)
                      </span>
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Bloco Separado 1: Notas Fiscais do Mês Atual */}
                <div className="rounded-xl border border-emerald-500/30 bg-slate-900/75 p-5 flex flex-col justify-between gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                        <Receipt className="h-4 w-4" />
                        Notas Fiscais no Mês Atual
                      </span>
                      <p className="mt-2 text-3xl font-bold text-white tabular-nums">
                        R$ {receiptsMonthTotal.toFixed(2)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {receiptsMonthCount}{' '}
                        {receiptsMonthCount === 1
                          ? 'nota fiscal alimentada'
                          : 'notas fiscais alimentadas'}{' '}
                        em {currentMonthLabel} · {receiptsReconciledCount} conferida(s)
                      </p>
                    </div>
                    <Link
                      href="/notas"
                      className="rounded-lg border border-slate-700 hover:border-emerald-500/60 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:text-emerald-300 transition-colors whitespace-nowrap"
                    >
                      Ver notas
                    </Link>
                  </div>
                </div>

                {/* Bloco Separado 2: Open Finance do Mês Atual */}
                <div className="rounded-xl border border-sky-500/30 bg-slate-900/75 p-5 flex flex-col justify-between gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                        <Landmark className="h-4 w-4" />
                        Gastos do Open Finance no Mês Atual
                      </span>
                      <p className="mt-2 text-3xl font-bold text-white tabular-nums">
                        R$ {openFinanceMonthTotal.toFixed(2)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400 tabular-nums">
                        {currentMonthOpenFinance.length}{' '}
                        {currentMonthOpenFinance.length === 1
                          ? 'lançamento recebido'
                          : 'lançamentos recebidos'}{' '}
                        · Conta/Cartão: R$ {openFinanceBankTotal.toFixed(2)} · Vale (VR/VA): R${' '}
                        {openFinanceVrVaTotal.toFixed(2)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('M1')}
                      className="rounded-lg border border-slate-700 hover:border-sky-500/60 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:text-sky-300 transition-colors whitespace-nowrap"
                    >
                      Ver extrato
                    </button>
                  </div>
                </div>
              </div>
            </section>
          );
        })()}

        {/* ===================================================================
            MÓDULO 1: RAIO-X OPEN FINANCE & AUDITORIA DE GASTOS
        =================================================================== */}
        {showM1 && (
          <section className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Wallet className="h-5 w-5 text-emerald-400" />
                  1. Seus Gastos no Mercado
                </h3>
                <p className="text-xs text-slate-400">
                  Resumo do que você gastou no mês com base nos seus cupons fiscais e extrato.
                </p>
              </div>
            </div>

            {/* 4 KPI CARDS */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Gasto Total no Mês (Mercado)</span>
                  <CreditCard className="h-4 w-4 text-emerald-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-white">
                  R$ {data.kpis.totalMonthSpent.toFixed(2)}
                </p>
                <p className="mt-1 text-[11px] text-emerald-400">
                  Calculado item a item pelas notas
                </p>
              </div>

              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/15 p-4">
                <div className="flex items-center justify-between text-xs text-emerald-300">
                  <span>Economia Potencial Identificada</span>
                  <TrendingDown className="h-4 w-4 text-emerald-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-emerald-400">
                  R$ {data.kpis.potentialMonthlySavings.toFixed(2)}/mês
                </p>
                <p className="mt-1 text-[11px] text-slate-300">
                  Comprando no mercado mais barato + menos supérfluos
                </p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Uso do Vale (VR / VA)</span>
                  <Flame className="h-4 w-4 text-amber-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-white">
                  {data.kpis.vrVaBurnRatePct}%{' '}
                  <span className="text-sm font-normal text-slate-400">
                    (R$ {data.kpis.vrVaBurnAmount.toFixed(2)})
                  </span>
                </p>
                <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-amber-400 rounded-full"
                    style={{ width: `${Math.min(100, data.kpis.vrVaBurnRatePct)}%` }}
                  />
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Notas Conferidas</span>
                  <ShieldCheck className="h-4 w-4 text-sky-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-white">
                  {data.kpis.reconciliationRatePct}%
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {data.reconciliation.totalReconciled} de {data.kpis.scannedReceiptsCount} cupons conferidos com o banco
                </p>
              </div>
            </div>

            {/* GRÁFICOS DO MÓDULO 1 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Donut: O Que Realmente Compramos */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <h4 className="text-sm font-semibold text-white">
                  O Que Realmente Compramos
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Separa comida e limpeza do dia a dia dos gastos extras por impulso
                </p>
                <div className="h-64 w-full flex flex-col sm:flex-row items-center">
                  <div className="h-full w-full sm:w-3/5">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={donutData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={55}
                          outerRadius={85}
                          paddingAngle={4}
                        >
                          {donutData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <RechartsTooltip
                          contentStyle={{
                            backgroundColor: '#0f172a',
                            borderColor: '#1e293b',
                            borderRadius: '8px',
                            fontSize: '12px'
                          }}
                          formatter={(val: number) => [`R$ ${Number(val).toFixed(2)}`, 'Gasto Real']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="w-full sm:w-2/5 space-y-2.5 text-xs">
                    {donutData.map((d) => (
                      <div key={d.name} className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-slate-300">
                          <span
                            className="h-3 w-3 rounded-sm shrink-0"
                            style={{ backgroundColor: d.color }}
                          />
                          {d.name}
                        </span>
                        <span className="font-semibold text-white">R$ {d.value.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Barras Empilhadas: Conta Bancária vs VR/VA por Categoria */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <h4 className="text-sm font-semibold text-white">
                  Forma de Pagamento por Categoria
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Quanto saiu da conta ou cartão vs. vale alimentação (VR/VA)
                </p>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={walletBarData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="category" stroke="#94a3b8" fontSize={11} />
                      <YAxis stroke="#94a3b8" fontSize={11} />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: '#0f172a',
                          borderColor: '#1e293b',
                          borderRadius: '8px',
                          fontSize: '12px'
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      <Bar
                        dataKey="BANK_ACCOUNT"
                        name="Conta Bancária / Pix / Cartão"
                        stackId="wallet"
                        fill="#10b981"
                        radius={[0, 0, 0, 0]}
                      />
                      <Bar
                        dataKey="VR_VA"
                        name="Carteira Benefícios (VR/VA)"
                        stackId="wallet"
                        fill="#f59e0b"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ===================================================================
            MÓDULO 2: RADAR ARGUS DE INFLAÇÃO PESSOAL & REDUFLAÇÃO
        =================================================================== */}
        {showM2 && (
          <section className="space-y-5">
            <div>
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                2. Variação de Preços &amp; Embalagens Menores
              </h3>
              <p className="text-xs text-slate-400">
                Acompanhe a mudança nos preços e veja quando um produto diminuiu de peso na embalagem.
              </p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
              {/* Gráfico de Evolução de Preços */}
              <div className="xl:col-span-7 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <h4 className="text-sm font-semibold text-white">
                  Evolução Histórica de Preços da Cesta Pessoal (R$ por Embalagem Padrão)
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Histórico consolidado dos últimos meses nas notas fiscais escaneadas
                </p>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.priceEvolutionSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
                      <YAxis stroke="#94a3b8" fontSize={12} />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: '#0f172a',
                          borderColor: '#1e293b',
                          borderRadius: '8px',
                          fontSize: '12px'
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      <Line
                        type="monotone"
                        dataKey="Azeite de Oliva Extra Virgem (500ml)"
                        stroke="#f59e0b"
                        strokeWidth={2.5}
                        dot={{ r: 4 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="Patinho Bovino Moído (1kg)"
                        stroke="#f43f5e"
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="Arroz Agulhinha Tipo 1 (5kg)"
                        stroke="#38bdf8"
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="Café Torrado e Moído Tradicional (500g)"
                        stroke="#a855f7"
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="Peito de Frango Sem Osso (1kg)"
                        stroke="#10b981"
                        strokeWidth={2.5}
                        dot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Painel de Alertas de Reduflação e Oportunidades */}
              <div className="xl:col-span-5 space-y-4">
                {/* Detector de Reduflação */}
                <div className="rounded-xl border border-amber-500/40 bg-amber-950/15 p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-bold text-amber-300 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-400" />
                      Embalagens que Encolheram
                    </h4>
                    <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                      {uniqueShrinkflation.length} ITENS CAÇADOS
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 mt-1">
                    Produtos que reduziram a gramatura/metragem da embalagem elevando o custo oculto por grama:
                  </p>
                  <div className="mt-3 space-y-2">
                    {uniqueShrinkflation.map((item) => (
                      <div
                        key={item.product_name}
                        className="rounded-lg border border-amber-500/25 bg-slate-950/70 p-2.5 text-xs flex items-center justify-between gap-2"
                      >
                        <div>
                          <p className="font-semibold text-white">{item.product_name}</p>
                          <p className="text-[11px] text-amber-300">
                            Embalagem encolheu de{' '}
                            <strong>
                              {item.standard_package_size}
                              {item.base_unit}
                            </strong>{' '}
                            para{' '}
                            <strong>
                              {item.latest_seen_package_size}
                              {item.base_unit}
                            </strong>{' '}
                            (-{item.package_reduction_pct}%)
                          </p>
                        </div>
                        <span className="shrink-0 rounded-md bg-rose-500/20 border border-rose-500/40 px-2 py-1 text-[11px] font-bold text-rose-300">
                          +{Math.max(8.5, item.mom_inflation_pct).toFixed(1)}% / {item.base_unit}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Tabela de Oportunidades (Menor Preço Histórico - Hora de Estocar) */}
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/10 p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-bold text-emerald-300 flex items-center gap-2">
                      <TrendingDown className="h-4 w-4 text-emerald-400" />
                      Hora de Estocar (Mínima Histórica)
                    </h4>
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                      COMPRA RECOMENDADA
                    </span>
                  </div>
                  <div className="mt-3 max-h-48 overflow-y-auto space-y-1.5 pr-1">
                    {historicalLowOpportunities.map((op, i) => (
                      <div
                        key={`${op.canonical_product_id}-${op.store_id}-${i}`}
                        className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs"
                      >
                        <div>
                          <p className="font-medium text-white">{op.product_name}</p>
                          <p className="text-[11px] text-slate-400">
                            🏪 {op.store_name} • Máx hist: R$ {op.max_historical_price.toFixed(2)}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="font-bold text-emerald-400">
                            R$ {op.estimated_package_price.toFixed(2)}
                          </span>
                          <span className="block text-[10px] text-emerald-300">
                            Mínimo Histórico!
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ===================================================================
            MÓDULO 3: MATRIZ COMPETITIVA DE MERCADOS (STORE HEATMAP)
        =================================================================== */}
        {showM3 && (
          <section className="space-y-4">
            <div>
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Store className="h-5 w-5 text-emerald-400" />
                3. Qual Mercado é Mais Barato por Setor
              </h3>
              <p className="text-xs text-slate-400">
                Compare onde cada categoria sai mais em conta (`100` = média;{' '}
                <span className="text-emerald-400 font-semibold">&lt; 96 = Mais Barato</span>;{' '}
                <span className="text-rose-400 font-semibold">&gt; 104 = Mais Caro</span>).
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                    <th className="py-3.5 px-4 font-semibold">Corredor / Categoria</th>
                    {storeNames.map((st) => {
                      const storeId = data.heatmap.find((h) => h.store_name === st)?.store_id;
                      return (
                        <th key={st} className="py-3.5 px-4 font-semibold text-white">
                          {storeId ? (
                            <Link
                              href={`/mercados?id=${encodeURIComponent(storeId)}`}
                              className="inline-flex items-center gap-1 hover:text-emerald-300 transition-colors"
                            >
                              <span>🏪 {st}</span>
                              <span className="text-[10px] text-emerald-400 font-normal">B.I. →</span>
                            </Link>
                          ) : (
                            <span>🏪 {st}</span>
                          )}
                        </th>
                      );
                    })}
                    <th className="py-3.5 px-4 font-semibold">Campeão do Corredor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {categories.map((cat) => {
                    const cells = storeNames.map((st) =>
                      data.heatmap.find((h) => h.store_name === st && h.category === cat)
                    );
                    const sortedValid = cells
                      .filter((c): c is StoreCategoryHeatmapView => Boolean(c))
                      .sort((a, b) => a.competitiveness_index - b.competitiveness_index);
                    const winner = sortedValid[0];

                    return (
                      <tr key={cat} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 px-4 font-semibold text-slate-200">{cat}</td>
                        {cells.map((cell, idx) => {
                          if (!cell) {
                            return (
                              <td key={idx} className="py-3 px-4 text-slate-500">
                                Sem leitura
                              </td>
                            );
                          }
                          const isCheap = cell.competitiveness_index <= 96;
                          const isExpensive = cell.competitiveness_index >= 104;
                          return (
                            <td key={cell.store_id} className="py-3 px-4">
                              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800/90 bg-slate-950/60 px-3 py-2">
                                <div>
                                  <span
                                    className={`inline-block rounded px-1.5 py-0.5 text-xs font-bold ${
                                      isCheap
                                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                        : isExpensive
                                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                    }`}
                                  >
                                    Índice {cell.competitiveness_index}
                                  </span>
                                  <span className="block text-[11px] text-slate-400 mt-1">
                                    Cesta: R$ {cell.basket_category_cost.toFixed(2)}
                                  </span>
                                </div>
                                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-emerald-400">
                                  ⏱ {cell.freshness_tier}
                                </span>
                              </div>
                            </td>
                          );
                        })}
                        <td className="py-3 px-4">
                          {winner && (
                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                              <TrendingUp className="h-3.5 w-3.5" />
                              {winner.store_name}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ===================================================================
            MÓDULO 4: LABORATÓRIO DE RECEITAS & SIMULADOR LOGÍSTICO (COM MAPA OSRM)
        =================================================================== */}
        {showM4 && (
          <section className="space-y-6">
            <div>
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Navigation className="h-5 w-5 text-emerald-400" />
                4. Receitas &amp; Melhor Rota de Compra
              </h3>
              <p className="text-xs text-slate-400">
                Veja o custo de cada receita (por porção e comprando pacotes fechados) e compare se compensa ir de carro ou Uber.
              </p>
            </div>

            {/* CALCULADORA DUPLO CUSTO DE RECEITAS */}
            {activeRecipe && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                  <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                      <Utensils className="h-3.5 w-3.5" />
                      Engenharia de Cardápio &amp; Marmitas da Semana
                    </span>
                    <h4 className="text-base font-bold text-white mt-0.5">
                      {activeRecipe.recipeName}
                    </h4>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <select
                      value={selectedRecipeIdx}
                      onChange={(e) => setSelectedRecipeIdx(Number(e.target.value))}
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                    >
                      {data.recipesEvaluations.map((rec, idx) => (
                        <option key={rec.recipeId} value={idx}>
                          🍲 {rec.recipeName} ({rec.servings} porções base)
                        </option>
                      ))}
                    </select>

                    <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs">
                      <span className="text-slate-400">Escala Semana:</span>
                      {[1, 2, 3].map((mult) => (
                        <button
                          key={mult}
                          onClick={() => setPortionMultiplier(mult)}
                          className={`rounded px-2 py-0.5 font-semibold ${
                            portionMultiplier === mult
                              ? 'bg-emerald-500 text-slate-950'
                              : 'text-slate-300 hover:bg-slate-800'
                          }`}
                        >
                          {mult}x ({activeRecipe.servings * mult} marmitas)
                        </button>
                      ))}
                    </div>

                    <Link
                      href={`/receitas?id=${activeRecipe.recipeId}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition"
                    >
                      <Navigation className="h-3.5 w-3.5" />
                      <span>Abrir Receitas &amp; Mapa OSRM</span>
                    </Link>
                  </div>
                </div>

                {/* CARDS INTERATIVOS EXPANSÍVEIS DE RECEITAS (FRAMER MOTION) */}
                {data.recipesEvaluations.length > 0 && (
                  <LayoutGroup id="dashboard-recipes-cards">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                      {data.recipesEvaluations.map((rec, idx) => {
                        const isSelected = selectedRecipeIdx === idx;
                        const isExpanded = expandedDashRecipeId === rec.recipeId;
                        const diffBadgeClass =
                          rec.difficulty === 'Fácil'
                            ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                            : rec.difficulty === 'Média'
                              ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                              : 'border-rose-500/40 bg-rose-500/15 text-rose-300';
                        const diffLevel =
                          rec.difficulty === 'Fácil' ? 1 : rec.difficulty === 'Média' ? 2 : 3;
                        const diffBarClass =
                          rec.difficulty === 'Fácil'
                            ? 'bg-emerald-400'
                            : rec.difficulty === 'Média'
                              ? 'bg-amber-400'
                              : 'bg-rose-400';

                        return (
                          <motion.div
                            key={rec.recipeId}
                            layout
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{
                              opacity: { duration: 0.2, delay: Math.min(idx * 0.04, 0.2) },
                              layout: { type: 'spring', stiffness: 360, damping: 30 }
                            }}
                            whileHover={{ y: -2 }}
                            className={`rounded-xl border transition-colors ${
                              isSelected || isExpanded
                                ? 'border-emerald-500/60 bg-emerald-950/20 shadow-lg shadow-emerald-950/20'
                                : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                            }`}
                          >
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              onClick={() => {
                                setSelectedRecipeIdx(idx);
                                setExpandedDashRecipeId((prev) =>
                                  prev === rec.recipeId ? null : rec.recipeId
                                );
                              }}
                              className="w-full text-left p-3.5 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-xs font-bold text-white leading-snug">
                                  {rec.recipeName}
                                </p>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="text-xs font-bold text-emerald-400 tabular-nums">
                                    R$ {rec.proportionalCostPerPortion.toFixed(2)}/porção
                                  </span>
                                  <motion.span
                                    animate={{ rotate: isExpanded ? 180 : 0 }}
                                    transition={{ type: 'spring', stiffness: 340, damping: 24 }}
                                    className={`inline-flex h-5 w-5 items-center justify-center rounded border ${
                                      isExpanded
                                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                        : 'border-slate-800 bg-slate-900 text-slate-400'
                                    }`}
                                  >
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  </motion.span>
                                </div>
                              </div>

                              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400 tabular-nums">
                                <span>{rec.servings} porções</span>
                                <span aria-hidden="true">·</span>
                                <span className="truncate max-w-[140px]">
                                  {rec.bestSingleStoreName}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="text-amber-300/90">
                                  Caixa R$ {rec.lowestPossibleCashCost.toFixed(2)}
                                </span>
                              </div>
                            </button>

                            <AnimatePresence initial={false}>
                              {isExpanded && (
                                <motion.div
                                  key={`dash-exp-${rec.recipeId}`}
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  transition={{
                                    height: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
                                    opacity: { duration: 0.18 }
                                  }}
                                  className="overflow-hidden"
                                >
                                  <div className="px-3.5 pb-3.5 pt-2.5 border-t border-slate-800/80 space-y-2.5 text-[11px]">
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                        <span className="text-slate-400 flex items-center gap-1">
                                          <Timer className="h-3 w-3 text-emerald-400" />
                                          Tempo de Preparo
                                        </span>
                                        <p className="mt-0.5 font-semibold text-white tabular-nums">
                                          {rec.prepTimeMinutes} min
                                        </p>
                                      </div>

                                      <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                        <span className="text-slate-400 flex items-center gap-1">
                                          <Gauge className="h-3 w-3 text-amber-400" />
                                          Dificuldade
                                        </span>
                                        <div className="mt-0.5 flex items-center justify-between gap-1.5">
                                          <span
                                            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold border ${diffBadgeClass}`}
                                          >
                                            {rec.difficulty}
                                          </span>
                                          <span className="inline-flex items-center gap-0.5" aria-hidden="true">
                                            {[1, 2, 3].map((step) => (
                                              <span
                                                key={step}
                                                className={`h-1.5 w-2.5 rounded-sm ${
                                                  step <= diffLevel ? diffBarClass : 'bg-slate-800'
                                                }`}
                                              />
                                            ))}
                                          </span>
                                        </div>
                                      </div>

                                      <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                        <span className="text-slate-400 flex items-center gap-1">
                                          <Flame className="h-3 w-3 text-orange-400" />
                                          Energia
                                        </span>
                                        <p className="mt-0.5 font-semibold text-white tabular-nums">
                                          ~{rec.estimatedCaloriesPerPortion} kcal/porção
                                        </p>
                                      </div>

                                      <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                        <span className="text-slate-400 flex items-center gap-1">
                                          <Snowflake className="h-3 w-3 text-sky-400" />
                                          Cadeia Fria
                                        </span>
                                        <p className="mt-0.5 font-semibold text-white tabular-nums">
                                          {rec.routeAnalysis?.coldChainScore ?? 94}/100 frescor
                                        </p>
                                      </div>
                                    </div>

                                    <div className="flex items-center justify-between gap-2 pt-0.5">
                                      <span className="text-slate-400 truncate">
                                        {rec.ingredientsBreakdown
                                          .slice(0, 3)
                                          .map((i) => i.productName)
                                          .join(', ')}
                                      </span>
                                      <Link
                                        href={`/receitas?id=${rec.recipeId}`}
                                        className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200 font-semibold shrink-0"
                                      >
                                        <Navigation className="h-3 w-3" />
                                        <span>Detalhes</span>
                                      </Link>
                                    </div>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </motion.div>
                        );
                      })}
                    </div>
                  </LayoutGroup>
                )}

                {/* KPIs do Duplo Custo da Receita */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/15 p-3.5">
                    <span className="text-xs text-emerald-300">
                      Custo Proporcional por Marmita/Porção
                    </span>
                    <p className="text-2xl font-bold text-emerald-400 mt-1">
                      R$ {activeRecipe.proportionalCostPerPortion.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Total das {activeRecipe.servings * portionMultiplier} porções: R${' '}
                      {(activeRecipe.proportionalTotalCost * portionMultiplier).toFixed(2)}
                    </p>
                  </div>

                  <div className="rounded-lg border border-amber-500/30 bg-amber-950/15 p-3.5">
                    <span className="text-xs text-amber-300">
                      Desembolso de Caixa no Caixa do Mercado
                    </span>
                    <p className="text-2xl font-bold text-amber-400 mt-1">
                      R$ {(activeRecipe.cashOutlayTotalCost * portionMultiplier).toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Comprando as embalagens fechadas necessárias
                    </p>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5">
                    <span className="text-xs text-slate-400">
                      Melhor Mercado Único para esta Receita
                    </span>
                    <p className="text-xl font-bold text-white mt-1">
                      🏪 {activeRecipe.bestSingleStoreName}
                    </p>
                    <p className="text-[11px] text-emerald-400 mt-0.5">
                      Sobra de despensa: R${' '}
                      {(
                        (activeRecipe.cashOutlayTotalCost - activeRecipe.proportionalTotalCost) *
                        portionMultiplier
                      ).toFixed(2)}{' '}
                      em ingredientes
                    </p>
                  </div>
                </div>

                {/* Tabela de Ingredientes da Receita */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-2 px-3">Ingrediente Canônico</th>
                        <th className="py-2 px-3">Qtd Usada na Receita</th>
                        <th className="py-2 px-3">Embalagem Padrão</th>
                        <th className="py-2 px-3">Melhor Mercado</th>
                        <th className="py-2 px-3">Custo Proporcional</th>
                        <th className="py-2 px-3">Desembolso Embalagem Fechada</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {activeRecipe.ingredientsBreakdown.map((ing) => (
                        <tr key={ing.productId}>
                          <td className="py-2 px-3 font-medium text-white">{ing.productName}</td>
                          <td className="py-2 px-3 text-slate-300">
                            {(ing.requiredBaseQty * portionMultiplier).toFixed(0)} {ing.baseUnit}
                          </td>
                          <td className="py-2 px-3 text-slate-400">
                            {ing.standardPackageSize} {ing.baseUnit}
                          </td>
                          <td className="py-2 px-3 text-emerald-300">{ing.bestStoreName}</td>
                          <td className="py-2 px-3 font-semibold text-emerald-400">
                            R$ {(ing.proportionalCost * portionMultiplier).toFixed(2)}
                          </td>
                          <td className="py-2 px-3 font-semibold text-amber-300">
                            R$ {(ing.cashOutlayCost * portionMultiplier).toFixed(2)} (
                            {Math.ceil(ing.packagesNeeded * portionMultiplier)} pct)
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeRecipe && (
              <RecipeStoreComparisonCard
                recipe={activeRecipe}
                portionMultiplier={portionMultiplier}
              />
            )}

            {/* SIMULADOR VISUAL: MAPA OSRM + GRÁFICO EMPILHADO + VEREDITO ARGUS */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
              {/* Mapa Interativo React-Leaflet + OSRM */}
              <div className="xl:col-span-7 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <Car className="h-4 w-4 text-emerald-400" />
                      Mapa Interativo de Roteirização Real (OSRM + OpenStreetMap)
                    </h4>
                    <p className="text-xs text-slate-400">
                      Alterne entre ir em 1 mercado só (`Casa → M1 → Casa`) ou dividir a compra (`Casa → M1 → M2 → Casa`)
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
                    <button
                      onClick={() => setActiveMapRouteMode('SINGLE_STORE')}
                      className={`rounded-md px-2.5 py-1.5 font-semibold transition ${
                        activeMapRouteMode === 'SINGLE_STORE'
                          ? 'bg-emerald-500 text-slate-950'
                          : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      Mercado Único ({data.logisticsVerdict.singleStoreBest.totalDistanceKm} km)
                    </button>
                    <button
                      onClick={() => setActiveMapRouteMode('SPLIT_STORES')}
                      className={`rounded-md px-2.5 py-1.5 font-semibold transition ${
                        activeMapRouteMode === 'SPLIT_STORES'
                          ? 'bg-amber-500 text-slate-950'
                          : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      Compra Dividida ({data.logisticsVerdict.splitStoreBest.totalDistanceKm} km)
                    </button>
                  </div>
                </div>

                <ArgusLogisticsMap
                  homeLocation={data.homeLocation}
                  singleScenario={data.logisticsVerdict.singleStoreBest}
                  splitScenario={data.logisticsVerdict.splitStoreBest}
                  activeMode={activeMapRouteMode}
                />
              </div>

              {/* Comparativo Empilhado (Produtos + Gasolina vs Uber) & Veredito */}
              <div className="xl:col-span-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between space-y-4">
                <div>
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <Scale className="h-4 w-4 text-amber-400" />
                    Custo Produtos + Logística (Gasolina vs. Uber)
                  </h4>
                  <p className="text-xs text-slate-400 mb-3">
                    Só vale dividir a compra em dois mercados se a economia passar de R$ 25,00
                  </p>

                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={logisticsComparisonChart}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="scenario" stroke="#94a3b8" fontSize={11} />
                        <YAxis stroke="#94a3b8" fontSize={11} />
                        <RechartsTooltip
                          contentStyle={{
                            backgroundColor: '#0f172a',
                            borderColor: '#1e293b',
                            borderRadius: '8px',
                            fontSize: '12px'
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: '11px' }} />
                        <Bar
                          dataKey="Produtos"
                          name="Custo Produtos (R$)"
                          stackId="total"
                          fill="#10b981"
                        />
                        <Bar
                          dataKey="Deslocamento"
                          name="Gasolina ou Uber (R$)"
                          stackId="total"
                          fill="#f59e0b"
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Box do Veredito Oficial do Argus */}
                <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-4 space-y-3">
                  <p className="text-xs leading-relaxed text-emerald-100 font-medium">
                    {data.logisticsVerdict.argusVerdictText}
                  </p>

                  <div className="grid grid-cols-2 gap-2 text-xs border-t border-emerald-500/20 pt-2.5">
                    <div>
                      <span className="text-slate-400 block">Economia Líquida (Carro):</span>
                      <strong className="text-emerald-400 text-sm">
                        R$ {data.logisticsVerdict.netSavingsWithGas.toFixed(2)}
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Economia Líquida (Uber):</span>
                      <strong className="text-amber-300 text-sm">
                        R$ {data.logisticsVerdict.netSavingsWithUber.toFixed(2)}
                      </strong>
                    </div>
                  </div>

                  <button
                    onClick={handleSendListToTelegram}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-4 py-2.5 text-xs font-bold text-slate-950 transition shadow-lg"
                  >
                    <Send className="h-4 w-4" />
                    <span>Enviar Lista de Compras Otimizada para o Telegram (@MonetaArgusBot)</span>
                  </button>

                  {telegramFeedback && (
                    <div className="rounded-lg bg-slate-950/90 border border-emerald-500/40 p-2.5 text-[11px] text-emerald-300">
                      ✅ {telegramFeedback}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
