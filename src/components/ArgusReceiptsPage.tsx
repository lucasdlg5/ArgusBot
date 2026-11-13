'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowUpDown,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  CreditCard,
  Package,
  Receipt,
  Search,
  Store,
  X
} from 'lucide-react';
import { fetchPublicDashboardFallback } from '@/lib/public-bi-client';
import type {
  PaymentMethod,
  ReceiptDetailEntry,
  StoreBiDetail
} from '@/types/argus';

interface ReceiptsApiResponse {
  status: string;
  generatedAt?: string;
  receiptsDetailed?: ReceiptDetailEntry[];
  storesBi?: StoreBiDetail[];
}

type SortOption = 'RECENT' | 'HIGHEST_VALUE' | 'MOST_ITEMS';

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  PIX: 'Pix',
  CREDIT_CARD: 'Cartão de Crédito',
  DEBIT: 'Cartão de Débito',
  VR_VA: 'VR / VA',
  CASH: 'Dinheiro'
};

function formatCurrency(val: number): string {
  return `R$ ${val.toFixed(2)}`;
}

function formatDateTimePt(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatQty(qty: number, unitType: string): string {
  const cleanQty = Number.isInteger(qty) ? qty : Number(qty.toFixed(3));
  return `${cleanQty} ${unitType || 'UN'}`;
}

export default function ArgusReceiptsPage() {
  const searchParams = useSearchParams();
  const initialStore = searchParams.get('store') || 'ALL';

  const [receipts, setReceipts] = useState<ReceiptDetailEntry[]>([]);
  const [stores, setStores] = useState<StoreBiDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [storeFilter, setStoreFilter] = useState(initialStore);
  const [paymentFilter, setPaymentFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<SortOption>('RECENT');
  const [hideZeroReceipts, setHideZeroReceipts] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadReceipts = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const isGitHubPages =
        typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');

      if (!isGitHubPages) {
        const res = await fetch(`/api/receipts?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as ReceiptsApiResponse;
          setReceipts(json.receiptsDetailed || []);
          setStores(json.storesBi || []);
          if ((json.receiptsDetailed || []).length > 0) {
            setExpandedId((prev) => prev || json.receiptsDetailed![0].receiptId);
          }
          return;
        }
      }

      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      const { data: payload } = await fetchPublicDashboardFallback<ReceiptsApiResponse>(basePath);
      const list = payload.receiptsDetailed || [];
      setReceipts(list);
      setStores(payload.storesBi || []);
      if (list.length > 0) {
        setExpandedId((prev) => prev || list[0].receiptId);
      }
    } catch (err) {
      setErrorMsg((err as Error).message || 'Falha ao carregar notas fiscais.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReceipts();
  }, [loadReceipts]);

  const filteredReceipts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = receipts.filter((r) => {
      if (hideZeroReceipts && r.totalAmount <= 0) return false;
      if (storeFilter !== 'ALL' && r.storeId !== storeFilter) return false;
      if (paymentFilter !== 'ALL' && r.paymentMethod !== paymentFilter) return false;
      if (!q) return true;
      const inHeader =
        r.storeName.toLowerCase().includes(q) ||
        r.storeAddress.toLowerCase().includes(q) ||
        formatDateTimePt(r.purchaseDate).toLowerCase().includes(q);
      if (inHeader) return true;
      return r.items.some(
        (it) =>
          it.rawDescription.toLowerCase().includes(q) ||
          it.canonicalProductName.toLowerCase().includes(q)
      );
    });

    list.sort((a, b) => {
      if (sortBy === 'HIGHEST_VALUE') return b.totalAmount - a.totalAmount;
      if (sortBy === 'MOST_ITEMS') return b.itemsCount - a.itemsCount;
      return new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime();
    });

    return list;
  }, [receipts, searchQuery, storeFilter, paymentFilter, sortBy, hideZeroReceipts]);

  const summary = useMemo(() => {
    const totalSpent = filteredReceipts.reduce((acc, r) => acc + r.totalAmount, 0);
    const totalItems = filteredReceipts.reduce((acc, r) => acc + r.itemsCount, 0);
    const reconciledCount = filteredReceipts.filter((r) => r.reconciled).length;
    return {
      count: filteredReceipts.length,
      totalSpent,
      totalItems,
      reconciledCount
    };
  }, [filteredReceipts]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* TOP NAV */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div className="space-y-1">
            <nav className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <Link
                href="/"
                className="inline-flex items-center gap-1 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Painel Executivo
              </Link>
              <span className="text-slate-700">/</span>
              <span className="text-emerald-400 font-semibold">Notas Fiscais</span>
              <span className="text-slate-700">/</span>
              <Link href="/produtos" className="hover:text-sky-300 transition-colors">
                Produtos Escaneados
              </Link>
              <span className="text-slate-700">/</span>
              <Link href="/mercados" className="hover:text-emerald-300 transition-colors">
                Mercados &amp; B.I.
              </Link>
              <span className="text-slate-700">/</span>
              <Link href="/receitas" className="hover:text-emerald-300 transition-colors">
                Receitas &amp; Cadeia Fria
              </Link>
            </nav>

            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2.5 pt-1">
              <Receipt className="h-6 w-6 text-emerald-400 shrink-0" />
              Notas Fiscais &amp; Itens Comprados
            </h1>
            <p className="text-xs text-slate-400">
              Visualize cada cupom fiscal registrado com data, mercado, pagamento e a lista completa de produtos com preço unitário e total.
            </p>
          </div>

          <Link
            href="/produtos"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 hover:border-sky-500/50 hover:text-sky-300 px-4 py-2 text-xs font-medium text-slate-200 transition-colors shrink-0 self-start md:self-auto"
          >
            <Package className="h-4 w-4 text-sky-400" />
            Catálogo de Produtos
          </Link>
        </header>

        {/* KPIs */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Notas Exibidas</p>
            <p className="mt-1 text-2xl font-bold text-white tabular-nums">{summary.count}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">de {receipts.length} cupons no banco</p>
          </div>
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Total Gasto (Cupons)</p>
            <p className="mt-1 text-2xl font-bold text-emerald-400 tabular-nums">
              {formatCurrency(summary.totalSpent)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">Exclui flyers e coletas avulsas</p>
          </div>
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Produtos Listados</p>
            <p className="mt-1 text-2xl font-bold text-sky-300 tabular-nums">{summary.totalItems}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Itens detalhados nas notas</p>
          </div>
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Conciliadas Open Finance</p>
            <p className="mt-1 text-2xl font-bold text-amber-300 tabular-nums">
              {summary.reconciledCount}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {summary.count > 0
                ? `${Math.round((summary.reconciledCount / summary.count) * 100)}% do filtro`
                : '0%'}
            </p>
          </div>
        </section>

        {/* FILTROS */}
        <section className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4 flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1 min-w-0">
            <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar por mercado, produto na nota ou data..."
              className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-9 pr-8 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                aria-label="Limpar busca"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              aria-label="Filtrar por mercado"
              value={storeFilter}
              onChange={(e) => setStoreFilter(e.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="ALL">Todos os mercados</option>
              {stores.map((st) => (
                <option key={st.storeId} value={st.storeId}>
                  {st.tradingName}
                </option>
              ))}
            </select>

            <select
              aria-label="Filtrar por pagamento"
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="ALL">Todos pagamentos</option>
              <option value="CREDIT_CARD">Cartão de Crédito</option>
              <option value="DEBIT">Cartão de Débito</option>
              <option value="PIX">Pix</option>
              <option value="VR_VA">VR / VA</option>
              <option value="CASH">Dinheiro</option>
            </select>

            <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-slate-300">
              <ArrowUpDown className="h-3.5 w-3.5 text-slate-500 shrink-0" />
              <select
                aria-label="Ordenar notas"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="bg-transparent text-xs text-slate-200 focus:outline-none"
              >
                <option value="RECENT" className="bg-slate-950">Mais recentes</option>
                <option value="HIGHEST_VALUE" className="bg-slate-950">Maior valor</option>
                <option value="MOST_ITEMS" className="bg-slate-950">Mais itens</option>
              </select>
            </div>

            <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={hideZeroReceipts}
                onChange={(e) => setHideZeroReceipts(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-emerald-500"
              />
              <span>Ocultar R$ 0,00</span>
            </label>
          </div>
        </section>

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {/* LISTA DE NOTAS FISCAIS */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-24 rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse"
              />
            ))}
          </div>
        ) : filteredReceipts.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-10 text-center space-y-2">
            <Receipt className="h-10 w-10 text-slate-600 mx-auto" />
            <p className="text-base font-semibold text-white">Nenhuma nota fiscal encontrada</p>
            <p className="text-xs text-slate-400">
              Ajuste os filtros acima ou envie a foto de um cupom fiscal para o @MonetaArgusBot.
            </p>
          </div>
        ) : (
          <section className="space-y-3">
            {filteredReceipts.map((rec) => {
              const isOpen = expandedId === rec.receiptId;
              return (
                <div
                  key={rec.receiptId}
                  className="rounded-xl border border-slate-800/90 bg-slate-900/60 overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(isOpen ? null : rec.receiptId)}
                    className="w-full px-4 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 text-left hover:bg-slate-900 transition-colors"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-white">
                          <Store className="h-4 w-4 text-emerald-400 shrink-0" />
                          {rec.storeName}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-300">
                          <CreditCard className="h-3 w-3 text-sky-400" />
                          {PAYMENT_LABELS[rec.paymentMethod] || rec.paymentMethod}
                        </span>
                        {rec.reconciled ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" />
                            Conciliada
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                            <Clock className="h-3 w-3" />
                            Sem conciliação
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <Calendar className="h-3 w-3 text-slate-500" />
                          {formatDateTimePt(rec.purchaseDate)}
                        </span>
                        <span>·</span>
                        <span className="truncate">{rec.storeAddress}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between md:justify-end gap-4 shrink-0">
                      <div className="text-right tabular-nums">
                        <p className="text-base font-bold text-emerald-400">
                          {formatCurrency(rec.totalAmount)}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {rec.itemsCount} item(ns)
                          {rec.discountAmount > 0 ? ` · desc. ${formatCurrency(rec.discountAmount)}` : ''}
                        </p>
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 text-slate-400 transition-transform ${
                          isOpen ? 'rotate-180 text-emerald-400' : ''
                        }`}
                      />
                    </div>
                  </button>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden border-t border-slate-800/80 bg-slate-950/70"
                      >
                        <div className="p-4 space-y-3">
                          {rec.items.length === 0 ? (
                            <p className="text-xs text-slate-400">
                              Nenhum item detalhado vinculado a este cupom.
                            </p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-left text-xs">
                                <thead>
                                  <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                                    <th className="py-2 pr-3">#</th>
                                    <th className="py-2 pr-3">Produto / Descrição no Cupom</th>
                                    <th className="py-2 pr-3">Categoria</th>
                                    <th className="py-2 pr-3 text-right">Qtd.</th>
                                    <th className="py-2 pr-3 text-right">Preço Unit.</th>
                                    <th className="py-2 text-right">Total Item</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/50">
                                  {rec.items.map((it, idx) => (
                                    <tr key={it.id} className="hover:bg-slate-900/50">
                                      <td className="py-2 pr-3 text-slate-500 tabular-nums">{idx + 1}</td>
                                      <td className="py-2 pr-3">
                                        <p className="font-medium text-slate-100">{it.rawDescription}</p>
                                        {it.canonicalProductName &&
                                          it.canonicalProductName !== it.rawDescription && (
                                            <p className="text-[10px] text-slate-400">
                                              Catálogo: {it.canonicalProductName}
                                            </p>
                                          )}
                                      </td>
                                      <td className="py-2 pr-3 text-slate-400">{it.category}</td>
                                      <td className="py-2 pr-3 text-right text-slate-300 tabular-nums">
                                        {formatQty(it.quantity, it.unitType)}
                                      </td>
                                      <td className="py-2 pr-3 text-right text-slate-300 tabular-nums">
                                        {formatCurrency(it.unitPrice)}
                                      </td>
                                      <td className="py-2 text-right font-semibold text-emerald-300 tabular-nums">
                                        {formatCurrency(it.totalPrice)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/60 text-xs">
                            <span className="font-mono text-[10px] text-slate-500">
                              ID: {rec.receiptId}
                            </span>
                            <div className="flex items-center gap-3">
                              <Link
                                href={`/mercados?id=${encodeURIComponent(rec.storeId)}`}
                                className="inline-flex items-center gap-1 font-semibold text-emerald-400 hover:text-emerald-300"
                              >
                                <Store className="h-3.5 w-3.5" />
                                B.I. do {rec.storeName} →
                              </Link>
                              <Link
                                href={`/produtos?store=${encodeURIComponent(rec.storeId)}`}
                                className="inline-flex items-center gap-1 font-semibold text-sky-400 hover:text-sky-300"
                              >
                                <Package className="h-3.5 w-3.5" />
                                Editar itens no Catálogo →
                              </Link>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
