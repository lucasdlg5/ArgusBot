'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
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
  Flame,
  Store,
  Sparkles,
  Scale,
  Receipt
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
  OpenFinanceTransaction
} from '@/types/argus';

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
  const [portionMultiplier, setPortionMultiplier] = useState<number>(1);
  const [activeMapRouteMode, setActiveMapRouteMode] = useState<'SINGLE_STORE' | 'SPLIT_STORES'>(
    'SPLIT_STORES'
  );
  const [telegramFeedback, setTelegramFeedback] = useState<string | null>(null);
  const [syncingReconcile, setSyncingReconcile] = useState<boolean>(false);

  async function loadDashboard() {
    setLoading(true);
    try {
      const isGitHubPages =
        typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
      const bucket = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'FotosArgus';

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
          // Segue para Camada 2 (Supabase Cloud) ou Camada 3 (Snapshot Estático)
        }
      }

      // Camada 2: Supabase Storage Live Feed (atualizado em tempo real pelo @MonetaArgusBot e GitHub Actions)
      if (supabaseUrl) {
        try {
          const liveUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(
            bucket
          )}/public-bi/dashboard-live.json?t=${Date.now()}`;
          const resLive = await fetch(liveUrl, { cache: 'no-store' });
          if (resLive.ok) {
            const json = (await resLive.json()) as DashboardPayload;
            setData(json);
            setDataSourceLabel('☁️ Supabase Cloud Live (GitHub Pages)');
            return;
          }
        } catch {
          // Segue para Camada 3
        }
      }

      // Camada 3: Snapshot Estático empacotado no deploy do GitHub Pages (public/data/dashboard-snapshot.json)
      const fallbackUrl = `${basePath}/data/dashboard-snapshot.json?t=${Date.now()}`;
      const resStatic = await fetch(fallbackUrl, { cache: 'no-store' });
      const jsonStatic = (await resStatic.json()) as DashboardPayload;
      setData(jsonStatic);
      setDataSourceLabel('📦 GitHub Pages Snapshot (Actions CI)');
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
            <p className="font-semibold text-white">Inicializando Argus Vision BI...</p>
            <p className="text-xs text-slate-400">
              Carregando views analíticas do schema isolado `argus`, rotas OSRM e conciliação Pluggy
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
                <h1 className="text-lg font-bold tracking-tight text-white">Argus Vision BI</h1>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30">
                  v1.0
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-tight mt-0.5">
                Market Arbitrage, Recipe Costing &amp; Open Finance Intelligence
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-1.5">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Módulos de Inteligência
            </p>
            {[
              { id: 'ALL', label: 'Visão Completa (4 Módulos)', icon: Eye },
              { id: 'M1', label: '1. Raio-X Open Finance', icon: Wallet },
              { id: 'M2', label: '2. Inflação & Reduflação', icon: AlertTriangle },
              { id: 'M3', label: '3. Matriz de Mercados', icon: Store },
              { id: 'M4', label: '4. Receitas & Rota OSRM', icon: Navigation }
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
              <span>Schema Supabase:</span>
              <code className="text-emerald-400 font-mono">argus (Isolado)</code>
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
            <span>{syncingReconcile ? 'Conciliando Pluggy...' : 'Conciliar Open Finance & Sheets'}</span>
          </button>
          <p className="text-[10px] text-center text-slate-500">
            100% Zero-Cost Stack • Gemini 2.5 Flash • OSRM
          </p>
        </div>
      </aside>

      {/* CONTEÚDO PRINCIPAL */}
      <main className="flex-1 p-5 lg:p-8 space-y-8 overflow-y-auto">
        {/* TOP HEADER */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div>
            <div className="flex items-center gap-2 text-xs text-emerald-400 font-semibold uppercase tracking-wider">
              <ShieldCheck className="h-4 w-4" />
              <span>Ecossistema Moneta • Inteligência de Consumo &amp; Arbitragem</span>
            </div>
            <h2 className="text-2xl font-bold text-white mt-1">
              Argus Vision BI — Painel Executivo do Olho Fiscal
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Base Logística: <span className="text-slate-300">{data.homeLocation.address}</span> • Trava de Compra Dividida:{' '}
              <span className="text-amber-400 font-semibold">
                R$ {data.logisticsVerdict.minSavingsHurdle.toFixed(2)}
              </span>
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
          </div>
        </header>

        {/* ===================================================================
            MÓDULO 1: RAIO-X OPEN FINANCE & AUDITORIA DE GASTOS
        =================================================================== */}
        {showM1 && (
          <section className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Wallet className="h-5 w-5 text-emerald-400" />
                  Módulo 1: Raio-X Open Finance &amp; Auditoria de Gastos
                </h3>
                <p className="text-xs text-slate-400">
                  Cruzamento automático entre faturas genéricas do Pluggy Open Finance e os itens reais dos cupons fiscais.
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
                  Auditado item a item por unidade base (g/ml/un)
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
                  Arbitragem entre mercados + corte de 50% em impulso
                </p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Burn-rate de VR / VA (Benefícios)</span>
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
                  <span>Taxa de Notas vs. Pluggy</span>
                  <ShieldCheck className="h-4 w-4 text-sky-400" />
                </div>
                <p className="mt-2 text-2xl font-bold text-white">
                  {data.kpis.reconciliationRatePct}%
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {data.reconciliation.totalReconciled} de {data.kpis.scannedReceiptsCount} cupons conciliados (-2h a +48h)
                </p>
              </div>
            </div>

            {/* GRÁFICOS DO MÓDULO 1 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Donut: O Que Realmente Compramos */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <h4 className="text-sm font-semibold text-white">
                  O Que Realmente Compramos (Desconstrução da Fatura de Supermercado)
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Separa Alimentação Essencial de Limpeza/Higiene e Besteiras/Impulso (`is_essential = false`)
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
                  Auditoria por Carteira: Conta Bancária (Pix/Cartão) vs. Benefícios (VR/VA)
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Visão da view `argus.v_true_spending_breakdown` por corredor do mercado
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
                Módulo 2: Radar Argus de Inflação Pessoal &amp; Detector de Reduflação (Shrinkflation)
              </h3>
              <p className="text-xs text-slate-400">
                Monitoramento contínuo do preço por grama/ml e alerta automático quando o fabricante reduz o peso da embalagem.
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
                      Alerta de Reduflação Detectada (Shrinkflation)
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
                Módulo 3: Matriz Competitiva de Mercados (Store Category Heatmap)
              </h3>
              <p className="text-xs text-slate-400">
                Índice de competitividade por corredor (`100` = média da região;{' '}
                <span className="text-emerald-400 font-semibold">&lt; 96 = Mais Barato / Dominante</span>;{' '}
                <span className="text-rose-400 font-semibold">&gt; 104 = Careiro</span>) e frescor das leituras.
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                    <th className="py-3.5 px-4 font-semibold">Corredor / Categoria</th>
                    {storeNames.map((st) => (
                      <th key={st} className="py-3.5 px-4 font-semibold text-white">
                        🏪 {st}
                      </th>
                    ))}
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
                Módulo 4: Laboratório de Receitas &amp; Simulador Logístico (Carro vs. Uber | Rota OSRM)
              </h3>
              <p className="text-xs text-slate-400">
                Custo exato por grama de cada receita (Proporcional vs. Embalagem Fechada) e roteirização real OSRM com trava de R$ 25,00.
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
                  </div>
                </div>

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
                      Comprando as embalagens fechadas necessárias (`CEIL`)
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
                    Trava de Segurança Argus: `MIN_SAVINGS_HURDLE = R$ 25,00`
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
