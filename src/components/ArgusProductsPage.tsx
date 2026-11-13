'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  fetchPublicDashboardFallback,
  resolvePublicApiUrl
} from '@/lib/public-bi-client';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowUpDown,
  Calendar,
  Camera,
  ChevronDown,
  FileText,
  Filter,
  MapPin,
  Package,
  Pencil,
  Receipt,
  Save,
  Search,
  Store,
  Tag,
  Utensils,
  Video,
  X
} from 'lucide-react';
import type {
  BaseUnit,
  ScannedProductEntry,
  ScannedProductSourceKind,
  StoreBiDetail
} from '@/types/argus';
import { matchesProductSearch } from '@/lib/product-brand';

interface ProductsApiResponse {
  status: string;
  generatedAt?: string;
  scannedProducts: ScannedProductEntry[];
  storesBi?: StoreBiDetail[];
}

type SourceFilter = 'ALL' | 'RECEIPT' | 'SCANS';
type SortOption = 'RECENT' | 'NORM_PRICE_ASC' | 'TOTAL_PRICE_DESC' | 'NAME_ASC';

function getSourceMeta(kind: ScannedProductSourceKind): {
  label: string;
  shortLabel: string;
  accentClass: string;
  Icon: typeof Receipt;
} {
  switch (kind) {
    case 'RECEIPT_ITEM':
      return {
        label: 'Cupom Fiscal NFC-e',
        shortLabel: 'Cupom NFC-e',
        accentClass: 'text-emerald-400',
        Icon: Receipt
      };
    case 'MARKET_FLYER':
      return {
        label: 'Panfleto / Oferta',
        shortLabel: 'Flyer',
        accentClass: 'text-amber-300',
        Icon: FileText
      };
    case 'AISLE_VIDEO':
      return {
        label: 'Vídeo de Corredor',
        shortLabel: 'Vídeo',
        accentClass: 'text-sky-300',
        Icon: Video
      };
    case 'SHELF_PHOTO':
    default:
      return {
        label: 'Foto de Gôndola',
        shortLabel: 'Gôndola',
        accentClass: 'text-sky-400',
        Icon: Camera
      };
  }
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

function formatDateShortPt(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit'
  });
}

function formatPackageUnit(qty: number, unitType: string, baseUnit: string): string {
  const cleanQty = Number.isInteger(qty) ? qty : Number(qty.toFixed(2));
  if (unitType === 'KG' && baseUnit === 'g' && qty < 20) {
    return `${cleanQty} kg`;
  }
  return `${cleanQty} ${unitType || baseUnit}`;
}

export default function ArgusProductsPage() {
  const searchParams = useSearchParams();
  const initialStoreParam = searchParams.get('store') || 'ALL';
  const initialQueryParam = searchParams.get('q') || '';

  const [products, setProducts] = useState<ScannedProductEntry[]>([]);
  const [stores, setStores] = useState<StoreBiDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState(initialQueryParam);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');
  const [storeFilter, setStoreFilter] = useState<string>(initialStoreParam);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<SortOption>('RECENT');
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  const [editingProduct, setEditingProduct] = useState<{
    id: string;
    sourceKind: ScannedProductSourceKind;
    canonicalProductId: string | null;
    canonicalProductName: string;
    rawDescription: string;
    category: string;
    baseUnit: BaseUnit;
    standardPackageSize: string;
    isEssential: boolean;
    quantity: string;
    unitType: string;
    unitPrice: string;
    totalPrice: string;
  } | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [saveProductMsg, setSaveProductMsg] = useState<string | null>(null);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const isGitHubPages =
        typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');

      if (!isGitHubPages) {
        const res = await fetch(`/api/products?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as ProductsApiResponse;
          setProducts(json.scannedProducts || []);
          setStores(json.storesBi || []);
          return;
        }
      }

      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      const { data: payload } = await fetchPublicDashboardFallback<ProductsApiResponse>(basePath);
      setProducts(payload.scannedProducts || []);
      setStores(payload.storesBi || []);
    } catch (err) {
      setErrorMsg((err as Error).message || 'Falha ao carregar produtos escaneados.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    if (initialStoreParam && initialStoreParam !== 'ALL') {
      setStoreFilter(initialStoreParam);
    }
  }, [initialStoreParam]);

  const availableStores = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stores) {
      map.set(s.storeId, s.tradingName);
    }
    for (const p of products) {
      const key = p.storeId || p.storeName;
      if (!map.has(key)) {
        map.set(key, p.storeName);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [products, stores]);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.category) set.add(p.category);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [products]);

  const filteredProducts = useMemo(() => {
    const list = products.filter((item) => {
      if (sourceFilter === 'RECEIPT' && item.sourceKind !== 'RECEIPT_ITEM') return false;
      if (sourceFilter === 'SCANS' && item.sourceKind === 'RECEIPT_ITEM') return false;

      if (storeFilter !== 'ALL') {
        const matchesId = item.storeId === storeFilter;
        const matchesName = item.storeName === storeFilter;
        if (!matchesId && !matchesName) return false;
      }

      if (categoryFilter !== 'ALL' && item.category !== categoryFilter) return false;

      return matchesProductSearch(item, searchQuery);
    });

    const sorted = [...list];
    switch (sortBy) {
      case 'NORM_PRICE_ASC':
        sorted.sort((a, b) => a.normalizedPackagePrice - b.normalizedPackagePrice);
        break;
      case 'TOTAL_PRICE_DESC':
        sorted.sort((a, b) => b.unitPrice - a.unitPrice);
        break;
      case 'NAME_ASC':
        sorted.sort((a, b) =>
          a.canonicalProductName.localeCompare(b.canonicalProductName, 'pt-BR')
        );
        break;
      case 'RECENT':
      default:
        sorted.sort(
          (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime()
        );
        break;
    }
    return sorted;
  }, [products, sourceFilter, storeFilter, categoryFilter, searchQuery, sortBy]);

  const summaryStats = useMemo(() => {
    const uniqueProds = new Set(
      filteredProducts.map((p) => p.canonicalProductId || p.canonicalProductName)
    );
    const uniqueBrands = new Set(
      filteredProducts
        .map((p) => p.brandName)
        .filter((b) => b && b !== 'Não especificada')
    );
    const uniqueStores = new Set(filteredProducts.map((p) => p.storeName));
    const receiptCount = filteredProducts.filter((p) => p.sourceKind === 'RECEIPT_ITEM').length;
    const scanCount = filteredProducts.length - receiptCount;

    return {
      totalEntries: filteredProducts.length,
      uniqueProducts: uniqueProds.size,
      uniqueBrands: uniqueBrands.size,
      uniqueStores: uniqueStores.size,
      receiptCount,
      scanCount
    };
  }, [filteredProducts]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    sourceFilter !== 'ALL' ||
    storeFilter !== 'ALL' ||
    categoryFilter !== 'ALL';

  function resetFilters() {
    setSearchQuery('');
    setSourceFilter('ALL');
    setStoreFilter('ALL');
    setCategoryFilter('ALL');
  }

  const openEditProduct = (item: ScannedProductEntry) => {
    setSaveProductMsg(null);
    setEditingProduct({
      id: item.id,
      sourceKind: item.sourceKind,
      canonicalProductId: item.canonicalProductId,
      canonicalProductName: item.canonicalProductName,
      rawDescription: item.rawDescription,
      category: String(item.category || 'Mercearia'),
      baseUnit: item.baseUnit || 'un',
      standardPackageSize: String(item.standardPackageSize || 1),
      isEssential: Boolean(item.isEssential),
      quantity: String(item.quantity || 1),
      unitType: item.unitType || 'UN',
      unitPrice: String(item.unitPrice || 0),
      totalPrice: String(item.totalPrice || 0)
    });
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProduct) return;
    setSavingProduct(true);
    setSaveProductMsg(null);
    try {
      const res = await fetch(resolvePublicApiUrl('/api/products'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingProduct.id,
          sourceKind: editingProduct.sourceKind,
          canonicalProductId: editingProduct.canonicalProductId,
          canonicalProductName: editingProduct.canonicalProductName,
          rawDescription: editingProduct.rawDescription,
          category: editingProduct.category,
          baseUnit: editingProduct.baseUnit,
          standardPackageSize: Number(editingProduct.standardPackageSize) || 1,
          isEssential: editingProduct.isEssential,
          quantity: Number(editingProduct.quantity) || 1,
          unitType: editingProduct.unitType,
          unitPrice: Number(editingProduct.unitPrice) || 0,
          totalPrice: Number(editingProduct.totalPrice) || 0
        })
      });
      const json = (await res.json()) as { status?: string; message?: string };
      if (!res.ok || json.status === 'error') {
        throw new Error(json.message || 'Falha ao salvar alterações do produto.');
      }
      setEditingProduct(null);
      await loadProducts();
    } catch (err) {
      setSaveProductMsg((err as Error).message || 'Erro ao salvar produto.');
    } finally {
      setSavingProduct(false);
    }
  };

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
                Painel
              </Link>
              <span className="text-slate-700" aria-hidden="true">
                /
              </span>
              <span className="text-sky-300 font-semibold">Produtos</span>
              <span className="text-slate-700" aria-hidden="true">
                /
              </span>
              <Link
                href="/mercados"
                className="inline-flex items-center gap-1.5 text-slate-400 hover:text-emerald-300 transition-colors"
              >
                <Store className="h-3.5 w-3.5" />
                Mercados
              </Link>
              <span className="text-slate-700" aria-hidden="true">
                /
              </span>
              <Link
                href="/receitas"
                className="inline-flex items-center gap-1.5 text-slate-400 hover:text-amber-300 transition-colors"
              >
                <Utensils className="h-3.5 w-3.5" />
                Receitas
              </Link>
              <span className="text-slate-700" aria-hidden="true">
                /
              </span>
              <Link
                href="/notas"
                className="inline-flex items-center gap-1.5 text-slate-400 hover:text-emerald-300 transition-colors"
              >
                <Receipt className="h-3.5 w-3.5" />
                Notas
              </Link>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2.5 pt-1">
              <Package className="h-6 w-6 text-emerald-400 shrink-0" />
              Produtos &amp; Preços
            </h1>
            <p className="text-xs text-slate-400">
              Histórico de preços e medidas por mercado.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link
              href="/mercados"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 hover:border-emerald-500/50 hover:text-emerald-300 px-4 py-2 text-xs font-medium text-slate-200 transition-colors"
            >
              <Store className="h-4 w-4 text-emerald-400" />
              Ver Mercados
            </Link>
          </div>
        </header>

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {/* RESUMO EXECUTIVO */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-xs text-slate-400">Leituras Filtradas</p>
            <p className="mt-1.5 text-2xl font-bold text-white tabular-nums">
              {summaryStats.totalEntries}
            </p>
            <p className="mt-1 text-[11px] text-slate-400 tabular-nums">
              {summaryStats.receiptCount} de cupons · {summaryStats.scanCount} de gôndola/flyer
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-xs text-slate-400">Produtos Únicos</p>
            <p className="mt-1.5 text-2xl font-bold text-emerald-400 tabular-nums">
              {summaryStats.uniqueProducts}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              Itens normalizados por unidade base
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-xs text-slate-400">Marcas Identificadas</p>
            <p className="mt-1.5 text-2xl font-bold text-sky-300 tabular-nums">
              {summaryStats.uniqueBrands}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              Extraídas das descrições escaneadas
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
            <p className="text-xs text-slate-400">Mercados no Filtro</p>
            <p className="mt-1.5 text-2xl font-bold text-amber-300 tabular-nums">
              {summaryStats.uniqueStores}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              Locais com preços auditados
            </p>
          </div>
        </section>

        {/* BARRA DE BUSCA E FILTROS */}
        <section className="rounded-xl border border-slate-800/90 bg-slate-900/50 p-4 space-y-3.5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
            <div className="lg:col-span-5 relative">
              <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                aria-label="Buscar produtos escaneados por nome, marca, local ou mercado"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchQuery) {
                    e.preventDefault();
                    setSearchQuery('');
                  }
                }}
                placeholder="Buscar produto, marca (ex: Camil, Sadia), mercado ou local..."
                className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-9 pr-8 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {searchQuery.length > 0 && (
                <button
                  type="button"
                  aria-label="Limpar busca de produtos"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="lg:col-span-7 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1 rounded-lg bg-slate-950 p-1 border border-slate-800">
                {[
                  { id: 'ALL', label: 'Todas as origens' },
                  { id: 'RECEIPT', label: 'Cupons NFC-e' },
                  { id: 'SCANS', label: 'Gôndola & Flyers' }
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSourceFilter(opt.id as SourceFilter)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      sourceFilter === opt.id
                        ? 'bg-emerald-500 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300">
                <Store className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                <select
                  aria-label="Filtrar por mercado"
                  value={storeFilter}
                  onChange={(e) => setStoreFilter(e.target.value)}
                  className="bg-transparent text-xs text-slate-200 focus:outline-none"
                >
                  <option value="ALL" className="bg-slate-950">
                    Todos os mercados
                  </option>
                  {availableStores.map((st) => (
                    <option key={st.id} value={st.id} className="bg-slate-950">
                      {st.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300">
                <Filter className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                <select
                  aria-label="Filtrar por categoria"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="bg-transparent text-xs text-slate-200 focus:outline-none"
                >
                  <option value="ALL" className="bg-slate-950">
                    Todas categorias
                  </option>
                  {availableCategories.map((cat) => (
                    <option key={cat} value={cat} className="bg-slate-950">
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300">
                <ArrowUpDown className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                <select
                  aria-label="Ordenar produtos"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="bg-transparent text-xs text-slate-200 focus:outline-none"
                >
                  <option value="RECENT" className="bg-slate-950">
                    Mais recentes
                  </option>
                  <option value="NORM_PRICE_ASC" className="bg-slate-950">
                    Menor preço padrão
                  </option>
                  <option value="TOTAL_PRICE_DESC" className="bg-slate-950">
                    Maior preço unitário
                  </option>
                  <option value="NAME_ASC" className="bg-slate-950">
                    Produto (A–Z)
                  </option>
                </select>
              </div>
            </div>
          </div>

          {hasActiveFilters && (
            <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-800/70">
              <span>
                Exibindo <strong className="text-white">{filteredProducts.length}</strong> de{' '}
                {products.length} registros escaneados
              </span>
              <button
                type="button"
                onClick={resetFilters}
                className="text-emerald-400 hover:text-emerald-300 font-medium"
              >
                Limpar todos os filtros
              </button>
            </div>
          )}
        </section>

        {/* TABELA / LISTA PRINCIPAL DE PRODUTOS ESCANEADOS */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-16 rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse"
              />
            ))}
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-10 text-center space-y-3">
            <Package className="h-10 w-10 text-slate-600 mx-auto" />
            <h2 className="text-base font-semibold text-white">
              Nenhum produto encontrado com os filtros atuais
            </h2>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Ajuste o termo de busca, origem ou mercado para visualizar os itens escaneados nos cupons fiscais e gôndolas.
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950"
              >
                Limpar filtros
              </button>
            )}
          </div>
        ) : (
          <section className="rounded-xl border border-slate-800/90 bg-slate-900/50 overflow-hidden">
            {/* Cabeçalho Desktop */}
            <div className="hidden lg:grid lg:grid-cols-12 gap-3 px-4 py-3 border-b border-slate-800 bg-slate-950/60 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <div className="col-span-4">Produto &amp; Marca</div>
              <div className="col-span-3">Mercado &amp; Local</div>
              <div className="col-span-2">Data &amp; Origem</div>
              <div className="col-span-1 text-right">Preço Pago</div>
              <div className="col-span-2 text-right">Preço Padrão</div>
            </div>

            <div className="divide-y divide-slate-800/70">
              {filteredProducts.map((item) => {
                const isExpanded = expandedRowId === item.id;
                const sourceMeta = getSourceMeta(item.sourceKind);
                const SourceIcon = sourceMeta.Icon;

                const openEditProduct = (item: ScannedProductEntry) => {
    setSaveProductMsg(null);
    setEditingProduct({
      id: item.id,
      sourceKind: item.sourceKind,
      canonicalProductId: item.canonicalProductId,
      canonicalProductName: item.canonicalProductName,
      rawDescription: item.rawDescription,
      category: String(item.category || 'Mercearia'),
      baseUnit: item.baseUnit || 'un',
      standardPackageSize: String(item.standardPackageSize || 1),
      isEssential: Boolean(item.isEssential),
      quantity: String(item.quantity || 1),
      unitType: item.unitType || 'UN',
      unitPrice: String(item.unitPrice || 0),
      totalPrice: String(item.totalPrice || 0)
    });
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProduct) return;
    setSavingProduct(true);
    setSaveProductMsg(null);
    try {
      const res = await fetch(resolvePublicApiUrl('/api/products'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingProduct.id,
          sourceKind: editingProduct.sourceKind,
          canonicalProductId: editingProduct.canonicalProductId,
          canonicalProductName: editingProduct.canonicalProductName,
          rawDescription: editingProduct.rawDescription,
          category: editingProduct.category,
          baseUnit: editingProduct.baseUnit,
          standardPackageSize: Number(editingProduct.standardPackageSize) || 1,
          isEssential: editingProduct.isEssential,
          quantity: Number(editingProduct.quantity) || 1,
          unitType: editingProduct.unitType,
          unitPrice: Number(editingProduct.unitPrice) || 0,
          totalPrice: Number(editingProduct.totalPrice) || 0
        })
      });
      const json = (await res.json()) as { status?: string; message?: string };
      if (!res.ok || json.status === 'error') {
        throw new Error(json.message || 'Falha ao salvar alterações do produto.');
      }
      setEditingProduct(null);
      await loadProducts();
    } catch (err) {
      setSaveProductMsg((err as Error).message || 'Erro ao salvar produto.');
    } finally {
      setSavingProduct(false);
    }
  };

  return (
                  <div key={item.id} className="transition-colors hover:bg-slate-900/80">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedRowId((prev) => (prev === item.id ? null : item.id))}
                      className="w-full text-left px-4 py-3.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 lg:gap-3 items-center">
                        {/* Produto & Marca */}
                        <div className="lg:col-span-4 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-white truncate">
                              {item.canonicalProductName}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                            <span className="inline-flex items-center gap-1 text-sky-300 font-medium">
                              <Tag className="h-3 w-3 shrink-0" />
                              {item.brandName}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{item.category}</span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate max-w-[180px] text-slate-500">
                              {item.rawDescription}
                            </span>
                          </div>
                        </div>

                        {/* Mercado & Local */}
                        <div className="lg:col-span-3 min-w-0 space-y-0.5">
                          <p className="text-xs font-semibold text-slate-200 truncate flex items-center gap-1.5">
                            <Store className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                            {item.storeName}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate flex items-center gap-1.5">
                            <MapPin className="h-3 w-3 text-slate-500 shrink-0" />
                            {item.storeLocation}
                          </p>
                        </div>

                        {/* Data & Origem */}
                        <div className="lg:col-span-2 min-w-0 space-y-0.5">
                          <p className="text-xs text-slate-200 tabular-nums flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                            {formatDateShortPt(item.observedAt)}
                          </p>
                          <p className={`text-[11px] flex items-center gap-1.5 ${sourceMeta.accentClass}`}>
                            <SourceIcon className="h-3 w-3 shrink-0" />
                            {sourceMeta.shortLabel}
                          </p>
                        </div>

                        {/* Preço Pago */}
                        <div className="lg:col-span-1 flex lg:flex-col lg:items-end justify-between gap-1">
                          <span className="text-xs font-bold text-white tabular-nums">
                            R$ {item.unitPrice.toFixed(2)}
                          </span>
                          <span className="text-[11px] text-slate-400 tabular-nums">
                            {formatPackageUnit(item.quantity, item.unitType, item.baseUnit)}
                          </span>
                        </div>

                        {/* Preço Padrão Normalizado + Chevron */}
                        <div className="lg:col-span-2 flex items-center justify-between lg:justify-end gap-3">
                          <div className="lg:text-right">
                            <p className="text-sm font-bold text-emerald-400 tabular-nums">
                              R$ {item.normalizedPackagePrice.toFixed(2)}
                            </p>
                            <p className="text-[11px] text-slate-400 tabular-nums">
                              por {item.standardPackageSize}
                              {item.baseUnit}
                              {item.promoPrice !== null && (
                                <span className="text-amber-300">
                                  {' '}
                                  · Clube R$ {item.promoPrice.toFixed(2)}
                                </span>
                              )}
                            </p>
                          </div>
                          <motion.span
                            animate={{ rotate: isExpanded ? 180 : 0 }}
                            transition={{ duration: 0.18 }}
                            className="text-slate-400 shrink-0"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </motion.span>
                        </div>
                      </div>
                    </button>

                    {/* DETALHES EXPANDIDOS */}
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden border-t border-slate-800/60 bg-slate-950/60"
                        >
                          <div className="px-4 py-3.5 grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
                            <div>
                              <p className="text-[11px] uppercase tracking-wider text-slate-500">
                                Descrição Escaneada Original
                              </p>
                              <p className="mt-1 font-mono text-slate-200 break-words">
                                {item.rawDescription}
                              </p>
                              <p className="mt-1 text-[11px] text-slate-400">
                                Marca: <strong className="text-sky-300">{item.brandName}</strong>
                              </p>
                            </div>

                            <div>
                              <p className="text-[11px] uppercase tracking-wider text-slate-500">
                                Data, Origem &amp; Confiança
                              </p>
                              <p className="mt-1 text-slate-200 tabular-nums">
                                {formatDateTimePt(item.observedAt)}
                              </p>
                              <p className="mt-1 text-[11px] text-slate-400">
                                {sourceMeta.label} · Confiança{' '}
                                <strong className="text-emerald-300">
                                  {item.confidenceScorePct.toFixed(0)}%
                                </strong>
                              </p>
                            </div>

                            <div>
                              <p className="text-[11px] uppercase tracking-wider text-slate-500">
                                Métricas de Preço
                              </p>
                              <p className="mt-1 text-slate-200 tabular-nums">
                                Total no item: <strong>R$ {item.totalPrice.toFixed(2)}</strong>
                                {item.paymentMethod ? ` · ${item.paymentMethod}` : ''}
                              </p>
                              <p className="mt-1 text-[11px] text-slate-400 tabular-nums">
                                Preço base: R$ {item.normalizedPricePerBaseUnit.toFixed(5)}/{item.baseUnit}
                              </p>
                            </div>

                            <div className="flex flex-col justify-between items-start md:items-end">
                              <div className="md:text-right">
                                <p className="text-[11px] uppercase tracking-wider text-slate-500">
                                  Localização
                                </p>
                                <p className="mt-1 text-slate-300">{item.storeLocation}</p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 mt-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openEditProduct(item);
                                  }}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 px-3 py-1.5 text-xs font-semibold text-sky-200 transition-colors"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Editar Produto / Medida
                                </button>
                                {item.storeId && (
                                  <Link
                                    href={`/mercados?id=${encodeURIComponent(item.storeId)}`}
                                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300"
                                  >
                                    <Store className="h-3.5 w-3.5" />
                                    Ver {item.storeName} →
                                  </Link>
                                )}
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* MODAL DE EDIÇÃO DE PRODUTO */}
      {editingProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <form
            onSubmit={handleSaveProduct}
            className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Pencil className="h-4 w-4 text-sky-400" />
                Editar Produto &amp; Medida
              </h2>
              <button
                type="button"
                onClick={() => setEditingProduct(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Fechar modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {saveProductMsg && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                {saveProductMsg}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <label className="space-y-1 md:col-span-2">
                <span className="text-slate-300 font-medium">Nome no Catálogo</span>
                <input
                  type="text"
                  required
                  value={editingProduct.canonicalProductName}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, canonicalProductName: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1 md:col-span-2">
                <span className="text-slate-300 font-medium">Descrição da Leitura (Cupom/Gôndola)</span>
                <input
                  type="text"
                  required
                  value={editingProduct.rawDescription}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, rawDescription: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">Categoria</span>
                <input
                  type="text"
                  value={editingProduct.category}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, category: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">Unidade Base (Receitas &amp; BI)</span>
                <select
                  value={editingProduct.baseUnit}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, baseUnit: e.target.value as BaseUnit })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                >
                  <option value="g">g (Gramas / Peso)</option>
                  <option value="ml">ml (Mililitros / Líquidos)</option>
                  <option value="un">un (Unidade / Pacote)</option>
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">
                  Peso/Medida da Embalagem ({editingProduct.baseUnit})
                </span>
                <input
                  type="number"
                  step="any"
                  min="0.01"
                  required
                  value={editingProduct.standardPackageSize}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, standardPackageSize: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                />
                <span className="block text-[10px] text-slate-400">
                  Ex: 100 para pacote de 100g, 1000 para 1L, 1 para unidade.
                </span>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Qtd. Lida</span>
                  <input
                    type="number"
                    step="any"
                    min="0.001"
                    required
                    value={editingProduct.quantity}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, quantity: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Un. Lida</span>
                  <input
                    type="text"
                    required
                    value={editingProduct.unitType}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, unitType: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white uppercase focus:border-emerald-500 focus:outline-none"
                  />
                </label>
              </div>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">Preço Unitário (R$)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={editingProduct.unitPrice}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, unitPrice: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-300 font-medium">Total Pago no Item (R$)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={editingProduct.totalPrice}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, totalPrice: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                />
              </label>

              <label className="flex items-center gap-2 md:col-span-2 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editingProduct.isEssential}
                  onChange={(e) =>
                    setEditingProduct({ ...editingProduct, isEssential: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-emerald-500"
                />
                <span className="text-slate-200">Item Essencial (não é besteira/impulso)</span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setEditingProduct(null)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={savingProduct}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-slate-950"
              >
                <Save className="h-3.5 w-3.5" />
                {savingProduct ? 'Salvando...' : 'Salvar Alterações'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
