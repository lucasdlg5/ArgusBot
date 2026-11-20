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
  ExternalLink,
  Package,
  Pencil,
  Plus,
  Receipt,
  Search,
  Store,
  Tag,
  Trash2,
  X
} from 'lucide-react';
import {
  fetchPublicDashboardFallback,
  invalidatePublicSnapshotCache,
  resolvePublicApiUrl,
  subscribeToLiveSnapshotUpdates
} from '@/lib/public-bi-client';
import { ArgusWakeupLoading } from '@/components/ArgusWakeupLoading';
import { APP_VERSION_LABEL } from '@/config/version';
import type {
  PaymentMethod,
  ReceiptDetailEntry,
  ReceiptUnitType,
  StoreBiDetail
} from '@/types/argus';

interface ReceiptsApiResponse {
  status: string;
  generatedAt?: string;
  receiptsDetailed?: ReceiptDetailEntry[];
  storesBi?: StoreBiDetail[];
}

const UNIT_TYPE_OPTIONS: { value: ReceiptUnitType; label: string }[] = [
  { value: 'UN', label: 'Unidade (UN)' },
  { value: 'KG', label: 'Quilo (KG)' },
  { value: 'LT', label: 'Litro (LT)' }
];

const PAYMENT_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: 'PIX', label: 'Pix' },
  { value: 'CREDIT_CARD', label: 'Cartão de Crédito' },
  { value: 'DEBIT', label: 'Cartão de Débito' },
  { value: 'VR_VA', label: 'Vale Refeição / Alimentação' },
  { value: 'CASH', label: 'Dinheiro' }
];

function toDateTimeLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocalInput(local: string): string {
  if (!local) return new Date().toISOString();
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
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

function getMonthKey(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return monthKey;
  const d = new Date(y, m - 1, 1);
  const label = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
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
  const [monthFilter, setMonthFilter] = useState<string>('ALL');
  const [reconciledFilter, setReconciledFilter] = useState<'ALL' | 'RECONCILED' | 'UNRECONCILED'>('ALL');
  const [paymentFilter, setPaymentFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<SortOption>('RECENT');
  const [hideZeroReceipts, setHideZeroReceipts] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [editingReceipt, setEditingReceipt] = useState<{
    receiptId: string;
    storeName: string;
    purchaseDate: string;
    paymentMethod: PaymentMethod;
    totalAmount: string;
    discountAmount: string;
    reconciled: boolean;
    itemsSum: number;
    accessKey: string;
    protocolNumber: string;
    nfceUrl: string;
    receiptNumber: string;
  } | null>(null);
  const [savingReceipt, setSavingReceipt] = useState(false);
  const [itemModal, setItemModal] = useState<{
    mode: 'ADD' | 'EDIT';
    receiptId: string;
    itemId?: string;
    rawDescription: string;
    quantity: string;
    unitType: ReceiptUnitType;
    unitPrice: string;
    totalPrice: string;
    recalculateTotal: boolean;
  } | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<{
    receiptId: string;
    itemId: string;
    rawDescription: string;
    recalculateTotal: boolean;
  } | null>(null);
  const [deletingItem, setDeletingItem] = useState(false);

  function openEditReceiptModal(rec: ReceiptDetailEntry) {
    const itemsSum = rec.items.reduce((acc, it) => acc + it.totalPrice, 0);
    setEditingReceipt({
      receiptId: rec.receiptId,
      storeName: rec.storeName,
      purchaseDate: toDateTimeLocalInput(rec.purchaseDate),
      paymentMethod: rec.paymentMethod,
      totalAmount: rec.totalAmount.toFixed(2),
      discountAmount: rec.discountAmount.toFixed(2),
      reconciled: rec.reconciled,
      itemsSum: Math.round(itemsSum * 100) / 100,
      accessKey: rec.accessKey || '',
      protocolNumber: rec.protocolNumber || '',
      nfceUrl: rec.nfceUrl || '',
      receiptNumber: rec.receiptNumber || ''
    });
  }

  async function handleSaveReceiptDetails(e: React.FormEvent) {
    e.preventDefault();
    if (!editingReceipt) return;
    setSavingReceipt(true);
    setActionMsg(null);
    setErrorMsg(null);
    try {
      const totalAmount = Number.parseFloat(editingReceipt.totalAmount.replace(',', '.'));
      const discountAmount = Number.parseFloat(editingReceipt.discountAmount.replace(',', '.'));
      const payload = {
        storeName: editingReceipt.storeName.trim(),
        purchaseDate: fromDateTimeLocalInput(editingReceipt.purchaseDate),
        paymentMethod: editingReceipt.paymentMethod,
        totalAmount: Number.isFinite(totalAmount) ? totalAmount : 0,
        discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
        reconciled: editingReceipt.reconciled,
        accessKey: editingReceipt.accessKey.trim() || null,
        protocolNumber: editingReceipt.protocolNumber.trim() || null,
        nfceUrl: editingReceipt.nfceUrl.trim() || null,
        receiptNumber: editingReceipt.receiptNumber.trim() || null
      };
      const url = resolvePublicApiUrl(`/api/receipts/${editingReceipt.receiptId}`);
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        storeId?: string;
        storeName?: string;
        storeAddress?: string;
        purchaseDate?: string;
        paymentMethod?: PaymentMethod;
        totalAmount?: number;
        discountAmount?: number;
        reconciled?: boolean;
        hasOfficialAccessKey?: boolean;
        accessKey?: string | null;
        protocolNumber?: string | null;
        nfceUrl?: string | null;
        receiptNumber?: string | null;
      };
      if (!res.ok) {
        throw new Error(json.message || 'Falha ao atualizar os dados da nota.');
      }
      invalidatePublicSnapshotCache();
      setReceipts((prev) =>
        prev.map((r) =>
          r.receiptId === editingReceipt.receiptId
            ? {
                ...r,
                storeId: json.storeId ?? r.storeId,
                storeName: json.storeName ?? payload.storeName ?? r.storeName,
                storeAddress: json.storeAddress ?? r.storeAddress,
                purchaseDate: json.purchaseDate ?? payload.purchaseDate,
                paymentMethod: json.paymentMethod ?? payload.paymentMethod,
                totalAmount: json.totalAmount ?? payload.totalAmount,
                discountAmount: json.discountAmount ?? payload.discountAmount,
                reconciled: json.reconciled ?? payload.reconciled,
                hasOfficialAccessKey:
                  json.hasOfficialAccessKey !== undefined
                    ? json.hasOfficialAccessKey
                    : r.hasOfficialAccessKey,
                accessKey: json.accessKey !== undefined ? json.accessKey : r.accessKey,
                protocolNumber:
                  json.protocolNumber !== undefined ? json.protocolNumber : payload.protocolNumber,
                nfceUrl: json.nfceUrl !== undefined ? json.nfceUrl : payload.nfceUrl,
                receiptNumber:
                  json.receiptNumber !== undefined ? json.receiptNumber : payload.receiptNumber
              }
            : r
        )
      );
      setActionMsg('✅ Dados da nota fiscal atualizados com sucesso!');
      setEditingReceipt(null);
    } catch (err) {
      setErrorMsg((err as Error).message || 'Erro ao salvar dados da nota fiscal.');
    } finally {
      setSavingReceipt(false);
    }
  }

  function openAddItemModal(rec: ReceiptDetailEntry) {
    setItemModal({
      mode: 'ADD',
      receiptId: rec.receiptId,
      rawDescription: '',
      quantity: '1',
      unitType: 'UN',
      unitPrice: '0.00',
      totalPrice: '0.00',
      recalculateTotal: true
    });
  }

  function openEditItemModal(
    rec: ReceiptDetailEntry,
    item: ReceiptDetailEntry['items'][number]
  ) {
    const safeUnit: ReceiptUnitType =
      item.unitType === 'KG' || item.unitType === 'LT' || item.unitType === 'UN'
        ? item.unitType
        : 'UN';
    setItemModal({
      mode: 'EDIT',
      receiptId: rec.receiptId,
      itemId: item.id,
      rawDescription: item.rawDescription,
      quantity: String(item.quantity),
      unitType: safeUnit,
      unitPrice: item.unitPrice.toFixed(2),
      totalPrice: item.totalPrice.toFixed(2),
      recalculateTotal: true
    });
  }

  async function handleSaveItem(e: React.FormEvent) {
    e.preventDefault();
    if (!itemModal) return;
    setSavingItem(true);
    setActionMsg(null);
    setErrorMsg(null);
    try {
      const quantity = Number.parseFloat(itemModal.quantity.replace(',', '.'));
      const unitPrice = Number.parseFloat(itemModal.unitPrice.replace(',', '.'));
      const totalPrice = Number.parseFloat(itemModal.totalPrice.replace(',', '.'));
      const payload = {
        rawDescription: itemModal.rawDescription.trim(),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        unitType: itemModal.unitType,
        unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
        totalPrice: Number.isFinite(totalPrice) && totalPrice >= 0 ? totalPrice : undefined,
        recalculateTotal: itemModal.recalculateTotal
      };
      const isEdit = itemModal.mode === 'EDIT' && itemModal.itemId;
      const endpoint = isEdit
        ? `/api/receipts/${itemModal.receiptId}/items/${itemModal.itemId}`
        : `/api/receipts/${itemModal.receiptId}/items`;
      const res = await fetch(resolvePublicApiUrl(endpoint), {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        item?: ReceiptDetailEntry['items'][number];
        newReceiptTotal?: number;
      };
      if (!res.ok || !json.item) {
        throw new Error(json.message || 'Falha ao salvar o produto.');
      }
      invalidatePublicSnapshotCache();
      const savedItem = json.item;
      setReceipts((prev) =>
        prev.map((r) => {
          if (r.receiptId !== itemModal.receiptId) return r;
          const nextItems = isEdit
            ? r.items.map((it) => (it.id === savedItem.id ? savedItem : it))
            : [...r.items, savedItem];
          return {
            ...r,
            items: nextItems,
            itemsCount: nextItems.length,
            totalAmount:
              typeof json.newReceiptTotal === 'number' ? json.newReceiptTotal : r.totalAmount
          };
        })
      );
      setActionMsg(
        isEdit
          ? `✅ Produto "${savedItem.rawDescription}" atualizado!`
          : `✅ Produto "${savedItem.rawDescription}" adicionado à nota!`
      );
      setItemModal(null);
    } catch (err) {
      setErrorMsg((err as Error).message || 'Erro ao salvar produto da nota.');
    } finally {
      setSavingItem(false);
    }
  }

  async function handleConfirmDeleteItem() {
    if (!confirmDeleteItem) return;
    setDeletingItem(true);
    setActionMsg(null);
    setErrorMsg(null);
    try {
      const endpoint = `/api/receipts/${confirmDeleteItem.receiptId}/items/${confirmDeleteItem.itemId}?recalculateTotal=${confirmDeleteItem.recalculateTotal}`;
      const res = await fetch(resolvePublicApiUrl(endpoint), { method: 'DELETE' });
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        deleted?: boolean;
        newReceiptTotal?: number;
      };
      if (!res.ok || !json.deleted) {
        throw new Error(json.message || 'Falha ao remover produto da nota.');
      }
      invalidatePublicSnapshotCache();
      setReceipts((prev) =>
        prev.map((r) => {
          if (r.receiptId !== confirmDeleteItem.receiptId) return r;
          const nextItems = r.items.filter((it) => it.id !== confirmDeleteItem.itemId);
          return {
            ...r,
            items: nextItems,
            itemsCount: nextItems.length,
            totalAmount:
              typeof json.newReceiptTotal === 'number' ? json.newReceiptTotal : r.totalAmount
          };
        })
      );
      setActionMsg(`🗑️ Produto "${confirmDeleteItem.rawDescription}" removido da nota.`);
      setConfirmDeleteItem(null);
    } catch (err) {
      setErrorMsg((err as Error).message || 'Erro ao remover produto.');
    } finally {
      setDeletingItem(false);
    }
  }

  async function handleConvertToFlyer(receipt: ReceiptDetailEntry) {
    setConvertingId(receipt.receiptId);
    setActionMsg(null);
    setErrorMsg(null);
    try {
      const url = resolvePublicApiUrl(`/api/receipts/${receipt.receiptId}/convert-to-flyer`);
      const res = await fetch(url, { method: 'POST' });
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        movedItemsCount?: number;
        storeName?: string;
      };
      if (!res.ok) {
        throw new Error(json.message || 'Falha ao converter nota para Flyer.');
      }
      invalidatePublicSnapshotCache();
      setReceipts((prev) => prev.filter((item) => item.receiptId !== receipt.receiptId));
      setActionMsg(
        `✅ Registro de ${json.storeName || receipt.storeName} marcado como Flyer! ${json.movedItemsCount ?? receipt.itemsCount} preço(s) mantidos no catálogo e removidos do total gasto.`
      );
    } catch (err) {
      setErrorMsg((err as Error).message || 'Erro ao marcar como Flyer.');
    } finally {
      setConvertingId(null);
    }
  }

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
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    const unsubscribe = subscribeToLiveSnapshotUpdates<ReceiptsApiResponse>(
      basePath,
      ({ data: payload }) => {
        const list = payload.receiptsDetailed || [];
        setReceipts(list);
        setStores(payload.storesBi || []);
      }
    );
    return () => unsubscribe();
  }, [loadReceipts]);

  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    for (const r of receipts) {
      const k = getMonthKey(r.purchaseDate);
      if (k) set.add(k);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [receipts]);

  const filteredReceipts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = receipts.filter((r) => {
      if (hideZeroReceipts && r.totalAmount <= 0) return false;
      if (storeFilter !== 'ALL' && r.storeId !== storeFilter) return false;
      if (monthFilter !== 'ALL' && getMonthKey(r.purchaseDate) !== monthFilter) return false;
      if (reconciledFilter === 'RECONCILED' && !r.reconciled) return false;
      if (reconciledFilter === 'UNRECONCILED' && r.reconciled) return false;
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
  }, [
    receipts,
    searchQuery,
    storeFilter,
    monthFilter,
    reconciledFilter,
    paymentFilter,
    sortBy,
    hideZeroReceipts
  ]);

  const summary = useMemo(() => {
    const totalSpent = filteredReceipts.reduce((acc, r) => acc + r.totalAmount, 0);
    const totalItems = filteredReceipts.reduce((acc, r) => acc + r.itemsCount, 0);
    const reconciledCount = filteredReceipts.filter((r) => r.reconciled).length;

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currentMonthReceipts = receipts.filter(
      (r) => getMonthKey(r.purchaseDate) === currentMonthKey
    );
    const currentMonthTotal = currentMonthReceipts.reduce((acc, r) => acc + r.totalAmount, 0);

    return {
      count: filteredReceipts.length,
      totalSpent,
      totalItems,
      reconciledCount,
      currentMonthTotal,
      currentMonthCount: currentMonthReceipts.length,
      currentMonthLabel: formatMonthLabel(currentMonthKey)
    };
  }, [filteredReceipts, receipts]);

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
                Painel
              </Link>
              <span className="text-slate-700">/</span>
              <span className="text-emerald-400 font-semibold">Notas</span>
              <span className="text-slate-700">/</span>
              <Link href="/produtos" className="hover:text-sky-300 transition-colors">
                Produtos
              </Link>
              <span className="text-slate-700">/</span>
              <Link href="/mercados" className="hover:text-emerald-300 transition-colors">
                Mercados
              </Link>
              <span className="text-slate-700">/</span>
              <Link href="/receitas" className="hover:text-emerald-300 transition-colors">
                Receitas
              </Link>
            </nav>

            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2.5 pt-1">
              <Receipt className="h-6 w-6 text-emerald-400 shrink-0" />
              Notas Fiscais
            </h1>
            <p className="text-xs text-slate-400">
              Cupons registrados com produtos, quantidades e preços pagos.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-start md:self-auto">
            <span
              title={`Versão atual do site: ${APP_VERSION_LABEL}`}
              className="inline-flex items-center rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-2 text-xs font-semibold font-mono text-emerald-300"
            >
              {APP_VERSION_LABEL}
            </span>
            <Link
              href="/produtos"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 hover:border-sky-500/50 hover:text-sky-300 px-4 py-2 text-xs font-medium text-slate-200 transition-colors"
            >
              <Package className="h-4 w-4 text-sky-400" />
              Catálogo de Produtos
            </Link>
          </div>
        </header>

        {/* KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Notas Exibidas</p>
            <p className="mt-1 text-2xl font-bold text-white tabular-nums">{summary.count}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">de {receipts.length} cupons no banco</p>
          </div>
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Total Gasto (Filtro)</p>
            <p className="mt-1 text-2xl font-bold text-emerald-400 tabular-nums">
              {formatCurrency(summary.totalSpent)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">Exclui flyers e coletas avulsas</p>
          </div>
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4">
            <p className="text-[11px] uppercase tracking-wider text-emerald-300">Mês Atual</p>
            <p className="mt-1 text-2xl font-bold text-white tabular-nums">
              {formatCurrency(summary.currentMonthTotal)}
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {summary.currentMonthLabel} ({summary.currentMonthCount} notas)
            </p>
          </div>
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Produtos Listados</p>
            <p className="mt-1 text-2xl font-bold text-sky-300 tabular-nums">{summary.totalItems}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Itens detalhados nas notas</p>
          </div>
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Conciliadas</p>
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
              aria-label="Filtrar por mês"
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="ALL">Todos os meses</option>
              {availableMonths.map((mk) => (
                <option key={mk} value={mk}>
                  {formatMonthLabel(mk)}
                </option>
              ))}
            </select>

            <select
              aria-label="Filtrar por conciliação"
              value={reconciledFilter}
              onChange={(e) =>
                setReconciledFilter(e.target.value as 'ALL' | 'RECONCILED' | 'UNRECONCILED')
              }
              className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="ALL">Conciliação: Todas</option>
              <option value="RECONCILED">Conciliadas</option>
              <option value="UNRECONCILED">Sem conciliação</option>
            </select>

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

        {actionMsg && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-3 text-xs text-emerald-200">
            {actionMsg}
          </div>
        )}

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {/* LISTA DE NOTAS FISCAIS */}
        {loading ? (
          <ArgusWakeupLoading initialSeconds={95} />
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
              const isPossibleFlyer = rec.totalAmount <= 0;
              return (
                <div
                  key={rec.receiptId}
                  className={`rounded-xl border overflow-hidden ${
                    isPossibleFlyer
                      ? 'border-amber-500/40 bg-amber-950/15'
                      : 'border-slate-800/90 bg-slate-900/60'
                  }`}
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
                        {isPossibleFlyer ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                            <Tag className="h-3 w-3" />
                            Possível Flyer
                          </span>
                        ) : rec.hasOfficialAccessKey ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                            <Receipt className="h-3 w-3" />
                            Nota Fiscal (NFC-e)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300">
                            <Receipt className="h-3 w-3" />
                            Nota Fiscal
                          </span>
                        )}
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
                        {rec.protocolNumber && (
                          <>
                            <span>·</span>
                            <span className="font-mono text-[10px] text-emerald-300/90 tabular-nums">
                              Protocolo: {rec.protocolNumber}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between md:justify-end gap-4 shrink-0">
                      <div className="text-right tabular-nums">
                        <p
                          className={`text-base font-bold ${
                            isPossibleFlyer ? 'text-amber-400' : 'text-emerald-400'
                          }`}
                        >
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
                          {rec.nfceUrl && (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                                  Consulta Pública NFC-e (SEFAZ)
                                </p>
                                <a
                                  href={rec.nfceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="block truncate font-mono text-[11px] text-emerald-200 hover:text-emerald-100 underline decoration-emerald-500/40"
                                >
                                  {rec.nfceUrl}
                                </a>
                              </div>
                              <a
                                href={rec.nfceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 transition-colors"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Abrir NFC-e
                              </a>
                            </div>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
                            <span className="text-[11px] text-slate-400">
                              {rec.totalAmount <= 0
                                ? '⚠️ Registro com total R$ 0,00 (provável Flyer/Coleta).'
                                : 'Precisa corrigir mercado, data, pagamento ou valor?'}
                            </span>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEditReceiptModal(rec);
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-3 py-1.5 text-[11px] font-medium text-emerald-200 transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                Editar Nota
                              </button>
                              <button
                                type="button"
                                disabled={convertingId === rec.receiptId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleConvertToFlyer(rec);
                                }}
                                className="rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-50 px-3 py-1.5 text-[11px] font-medium text-amber-200 transition-colors"
                              >
                                {convertingId === rec.receiptId
                                  ? 'Convertendo...'
                                  : '🏷️ Marcar como Flyer (Não é Nota Fiscal)'}
                              </button>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                              Produtos da Nota ({rec.items.length})
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openAddItemModal(rec);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 px-3 py-1.5 text-[11px] font-medium text-sky-200 transition-colors"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              Adicionar Produto
                            </button>
                          </div>

                          {rec.items.length === 0 ? (
                            <p className="text-xs text-slate-400">
                              Nenhum item detalhado vinculado a este cupom. Use &quot;Adicionar Produto&quot; acima para incluir itens manualmente.
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
                                    <th className="py-2 pr-3 text-right">Total Item</th>
                                    <th className="py-2 text-right">Ações</th>
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
                                      <td className="py-2 pr-3 text-right font-semibold text-emerald-300 tabular-nums">
                                        {formatCurrency(it.totalPrice)}
                                      </td>
                                      <td className="py-2 text-right">
                                        <div className="inline-flex items-center justify-end gap-1">
                                          <button
                                            type="button"
                                            title="Editar produto"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              openEditItemModal(rec, it);
                                            }}
                                            className="rounded-md border border-slate-700 bg-slate-900 hover:border-emerald-500/50 hover:text-emerald-300 p-1.5 text-slate-300 transition-colors"
                                          >
                                            <Pencil className="h-3.5 w-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            title="Remover produto"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setConfirmDeleteItem({
                                                receiptId: rec.receiptId,
                                                itemId: it.id,
                                                rawDescription: it.rawDescription,
                                                recalculateTotal: true
                                              });
                                            }}
                                            className="rounded-md border border-slate-700 bg-slate-900 hover:border-rose-500/50 hover:text-rose-300 p-1.5 text-slate-300 transition-colors"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
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
                                Ver {rec.storeName} →
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

      {/* Modal: Editar Dados da Nota Fiscal */}
      {editingReceipt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
          onClick={() => !savingReceipt && setEditingReceipt(null)}
        >
          <form
            onSubmit={handleSaveReceiptDetails}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-100">Editar Nota Fiscal</h2>
                <p className="text-xs text-slate-400">
                  Corrija mercado, data da compra, pagamento ou valor total.
                </p>
              </div>
              <button
                type="button"
                disabled={savingReceipt}
                onClick={() => setEditingReceipt(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block font-medium text-slate-300">Mercado / Loja</label>
                <input
                  type="text"
                  required
                  value={editingReceipt.storeName}
                  onChange={(e) =>
                    setEditingReceipt((prev) => (prev ? { ...prev, storeName: e.target.value } : null))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Data e Hora da Compra</label>
                  <input
                    type="datetime-local"
                    required
                    value={editingReceipt.purchaseDate}
                    onChange={(e) =>
                      setEditingReceipt((prev) =>
                        prev ? { ...prev, purchaseDate: e.target.value } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Forma de Pagamento</label>
                  <select
                    value={editingReceipt.paymentMethod}
                    onChange={(e) =>
                      setEditingReceipt((prev) =>
                        prev ? { ...prev, paymentMethod: e.target.value as PaymentMethod } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  >
                    {PAYMENT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="font-medium text-slate-300">Valor Total (R$)</label>
                    <button
                      type="button"
                      onClick={() =>
                        setEditingReceipt((prev) =>
                          prev ? { ...prev, totalAmount: prev.itemsSum.toFixed(2) } : null
                        )
                      }
                      className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300"
                    >
                      Usar soma dos itens ({formatCurrency(editingReceipt.itemsSum)})
                    </button>
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={editingReceipt.totalAmount}
                    onChange={(e) =>
                      setEditingReceipt((prev) =>
                        prev ? { ...prev, totalAmount: e.target.value } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Desconto (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editingReceipt.discountAmount}
                    onChange={(e) =>
                      setEditingReceipt((prev) =>
                        prev ? { ...prev, discountAmount: e.target.value } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800 space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Dados Fiscais (NFC-e / Opcionais)
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">
                      Protocolo de Autorização
                    </label>
                    <input
                      type="text"
                      placeholder="Ex.: 135265151343878"
                      value={editingReceipt.protocolNumber}
                      onChange={(e) =>
                        setEditingReceipt((prev) =>
                          prev ? { ...prev, protocolNumber: e.target.value } : null
                        )
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">
                      Número da Nota / COO / Pedido
                    </label>
                    <input
                      type="text"
                      placeholder="Ex.: 101111"
                      value={editingReceipt.receiptNumber}
                      onChange={(e) =>
                        setEditingReceipt((prev) =>
                          prev ? { ...prev, receiptNumber: e.target.value } : null
                        )
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block font-medium text-slate-300">
                    Chave de Acesso NFC-e (44 dígitos)
                  </label>
                  <input
                    type="text"
                    placeholder="Cole os 44 dígitos (com ou sem espaços)"
                    value={editingReceipt.accessKey}
                    onChange={(e) =>
                      setEditingReceipt((prev) =>
                        prev ? { ...prev, accessKey: e.target.value } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    Ao informar 44 dígitos válidos, a nota recebe o selo NFC-e e gera a URL SEFAZ automaticamente.
                  </p>
                </div>

                <div>
                  <label className="mb-1 block font-medium text-slate-300">
                    URL de Consulta NFC-e (SEFAZ)
                  </label>
                  <input
                    type="url"
                    placeholder="https://www.nfce.fazenda.sp.gov.br/..."
                    value={editingReceipt.nfceUrl}
                    onChange={(e) =>
                      setEditingReceipt((prev) =>
                        prev ? { ...prev, nfceUrl: e.target.value } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editingReceipt.reconciled}
                  onChange={(e) =>
                    setEditingReceipt((prev) =>
                      prev ? { ...prev, reconciled: e.target.checked } : null
                    )
                  }
                  className="h-4 w-4 accent-emerald-500"
                />
                <span className="text-slate-200">Nota conciliada / conferida</span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={savingReceipt}
                onClick={() => setEditingReceipt(null)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={savingReceipt}
                className="rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors"
              >
                {savingReceipt ? 'Salvando...' : 'Salvar Alterações'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Adicionar / Editar Produto da Nota */}
      {itemModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
          onClick={() => !savingItem && setItemModal(null)}
        >
          <form
            onSubmit={handleSaveItem}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-100">
                  {itemModal.mode === 'EDIT' ? 'Editar Produto da Nota' : 'Adicionar Produto na Nota'}
                </h2>
                <p className="text-xs text-slate-400">
                  Informe descrição, quantidade, unidade e valores do item.
                </p>
              </div>
              <button
                type="button"
                disabled={savingItem}
                onClick={() => setItemModal(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block font-medium text-slate-300">
                  Nome / Descrição do Produto
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex.: Leite Integral Italac 1L"
                  value={itemModal.rawDescription}
                  onChange={(e) =>
                    setItemModal((prev) => (prev ? { ...prev, rawDescription: e.target.value } : null))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Quantidade</label>
                  <input
                    type="number"
                    step="0.001"
                    min="0.001"
                    required
                    value={itemModal.quantity}
                    onChange={(e) => {
                      const val = e.target.value;
                      setItemModal((prev) => {
                        if (!prev) return null;
                        const q = Number.parseFloat(val.replace(',', '.'));
                        const u = Number.parseFloat(prev.unitPrice.replace(',', '.'));
                        const nextTotal =
                          Number.isFinite(q) && Number.isFinite(u) ? (q * u).toFixed(2) : prev.totalPrice;
                        return { ...prev, quantity: val, totalPrice: nextTotal };
                      });
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Unidade</label>
                  <select
                    value={itemModal.unitType}
                    onChange={(e) =>
                      setItemModal((prev) =>
                        prev ? { ...prev, unitType: e.target.value as ReceiptUnitType } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  >
                    {UNIT_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Preço Unitário (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={itemModal.unitPrice}
                    onChange={(e) => {
                      const val = e.target.value;
                      setItemModal((prev) => {
                        if (!prev) return null;
                        const q = Number.parseFloat(prev.quantity.replace(',', '.'));
                        const u = Number.parseFloat(val.replace(',', '.'));
                        const nextTotal =
                          Number.isFinite(q) && Number.isFinite(u) ? (q * u).toFixed(2) : prev.totalPrice;
                        return { ...prev, unitPrice: val, totalPrice: nextTotal };
                      });
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Total do Item (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={itemModal.totalPrice}
                    onChange={(e) =>
                      setItemModal((prev) =>
                        prev ? { ...prev, totalPrice: e.target.value } : null
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={itemModal.recalculateTotal}
                  onChange={(e) =>
                    setItemModal((prev) =>
                      prev ? { ...prev, recalculateTotal: e.target.checked } : null
                    )
                  }
                  className="h-4 w-4 accent-emerald-500"
                />
                <span className="text-slate-200">Recalcular valor total da nota automaticamente</span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={savingItem}
                onClick={() => setItemModal(null)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={savingItem}
                className="rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors"
              >
                {savingItem
                  ? 'Salvando...'
                  : itemModal.mode === 'EDIT'
                    ? 'Salvar Produto'
                    : 'Adicionar Produto'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Confirmar Remoção de Produto */}
      {confirmDeleteItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
          onClick={() => !deletingItem && setConfirmDeleteItem(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-100">Remover Produto da Nota</h2>
              <button
                type="button"
                disabled={deletingItem}
                onClick={() => setConfirmDeleteItem(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-slate-300">
              Tem certeza que deseja remover{' '}
              <span className="font-semibold text-white">{confirmDeleteItem.rawDescription}</span>{' '}
              desta nota fiscal?
            </p>

            <label className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={confirmDeleteItem.recalculateTotal}
                onChange={(e) =>
                  setConfirmDeleteItem((prev) =>
                    prev ? { ...prev, recalculateTotal: e.target.checked } : null
                  )
                }
                className="h-4 w-4 accent-emerald-500"
              />
              <span className="text-slate-200">Recalcular valor total da nota após remover</span>
            </label>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={deletingItem}
                onClick={() => setConfirmDeleteItem(null)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deletingItem}
                onClick={() => void handleConfirmDeleteItem()}
                className="rounded-lg bg-rose-500 hover:bg-rose-400 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-white transition-colors"
              >
                {deletingItem ? 'Removendo...' : 'Remover Produto'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
