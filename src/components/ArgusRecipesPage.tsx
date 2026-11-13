'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  ChefHat,
  ChevronDown,
  Clock,
  Copy,
  Eye,
  FileText,
  Flame,
  Gauge,
  Link2,
  ListChecks,
  MapPin,
  Minus,
  Navigation,
  Package,
  Plus,
  Search,
  ShoppingCart,
  Snowflake,
  Sparkles,
  Store,
  Timer,
  Trash2,
  Utensils,
  X
} from 'lucide-react';
import type {
  LogisticsScenario,
  PerishabilityTier,
  RecipeCostEvaluation
} from '@/types/argus';
import { matchesRecipeSearch } from '@/lib/recipe-intelligence';
import RecipeStoreComparisonCard from './RecipeStoreComparisonCard';

const ArgusLogisticsMap = dynamic(() => import('./ArgusLogisticsMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[380px] w-full items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-xs text-slate-400">
      Carregando mapa interativo OSRM...
    </div>
  )
});

interface RecipesApiResponse {
  status: string;
  homeLocation: { lat: number; lng: number; address: string };
  recipes: RecipeCostEvaluation[];
}

type DetailTab = 'OVERVIEW' | 'SHOPPING' | 'COOKING' | 'MARKETS';

function getTierTextColor(tier: PerishabilityTier): string {
  switch (tier) {
    case 'NON_PERISHABLE':
      return 'text-emerald-400';
    case 'SEMI_PERISHABLE':
      return 'text-amber-300';
    case 'REFRIGERATED':
      return 'text-sky-300';
    case 'FROZEN_OR_DELICATE':
      return 'text-rose-300';
  }
}

function getTierBorderClass(tier: PerishabilityTier): string {
  switch (tier) {
    case 'NON_PERISHABLE':
      return 'border-emerald-500/30 bg-emerald-950/15';
    case 'SEMI_PERISHABLE':
      return 'border-amber-500/30 bg-amber-950/15';
    case 'REFRIGERATED':
      return 'border-sky-500/30 bg-sky-950/15';
    case 'FROZEN_OR_DELICATE':
      return 'border-rose-500/35 bg-rose-950/15';
  }
}

function getDifficultyBadgeMeta(difficulty: RecipeCostEvaluation['difficulty']): {
  badgeClass: string;
  barClass: string;
  level: number;
} {
  switch (difficulty) {
    case 'Fácil':
      return {
        badgeClass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
        barClass: 'bg-emerald-400',
        level: 1
      };
    case 'Média':
      return {
        badgeClass: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
        barClass: 'bg-amber-400',
        level: 2
      };
    case 'Elaborada':
      return {
        badgeClass: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
        barClass: 'bg-rose-400',
        level: 3
      };
  }
}

function buildScaledScenario(
  scenario: LogisticsScenario | null | undefined,
  multiplier: number
): LogisticsScenario | null {
  if (!scenario) return null;
  if (multiplier === 1) return scenario;
  const productsCost = Number((scenario.productsCost * multiplier).toFixed(2));
  return {
    ...scenario,
    productsCost,
    totalWithGas: Number((productsCost + scenario.gasCost).toFixed(2)),
    totalWithUber: Number((productsCost + scenario.uberCost).toFixed(2)),
    storesVisited: scenario.storesVisited.map((st) => ({
      ...st,
      subtotalProducts: Number((st.subtotalProducts * multiplier).toFixed(2)),
      items: st.items.map((it) => ({
        ...it,
        packages: Math.ceil(it.packages * multiplier),
        lineTotal: Number((it.lineTotal * multiplier).toFixed(2))
      }))
    }))
  };
}

function formatQty(qty: number, unit: string): string {
  if (unit === 'g' && qty >= 1000) {
    return `${(qty / 1000).toFixed(qty % 1000 === 0 ? 0 : 2)} kg`;
  }
  if (unit === 'ml' && qty >= 1000) {
    return `${(qty / 1000).toFixed(qty % 1000 === 0 ? 0 : 2)} L`;
  }
  return `${Number.isInteger(qty) ? qty : qty.toFixed(1)} ${unit}`;
}

const SAMPLE_RECIPE_TEMPLATES = [
  {
    label: 'Omelete Proteico (Rápido)',
    text: 'Omelete Proteico com Cebola (2 porções)\nIngredientes:\n- 4 ovos\n- 100g de cebola\n- 30g de manteiga\n- 100ml de leite integral\nModo de preparo:\n1. Bata os ovos com o leite integral e sal.\n2. Refogue a cebola na manteiga até dourar.\n3. Despeje os ovos batidos e cozinhe em fogo baixo até firmar.'
  },
  {
    label: 'Bolo de Cenoura (Café)',
    text: 'Bolo de Cenoura Caseiro (8 porções)\nIngredientes:\n- 300g cenoura\n- 3 ovos\n- 180ml óleo\n- 300g farinha de trigo\n- 250g açúcar\nModo de preparo:\n1. Bata cenoura, ovos e óleo no liquidificador.\n2. Misture a farinha e o açúcar.\n3. Asse a 180 graus por 40 minutos.'
  }
];

export default function ArgusRecipesPage() {
  const searchParams = useSearchParams();
  const initialIdFromUrl = searchParams.get('id');

  const [recipes, setRecipes] = useState<RecipeCostEvaluation[]>([]);
  const [homeLocation, setHomeLocation] = useState({
    lat: -23.55052,
    lng: -46.633308,
    address: 'Ponto Base Argus'
  });
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(initialIdFromUrl);
  const [expandedRecipeId, setExpandedRecipeId] = useState<string | null>(initialIdFromUrl);
  const [expandedSimilarId, setExpandedSimilarId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>('TODAS');
  const [portionMultiplier, setPortionMultiplier] = useState(1);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('OVERVIEW');

  // Interações de checklist (Modo Compras & Modo Cozinha) por receita
  const [checkedCartByRecipe, setCheckedCartByRecipe] = useState<Record<string, string[]>>({});
  const [completedStepsByRecipe, setCompletedStepsByRecipe] = useState<Record<string, number[]>>({});
  const [copiedNotice, setCopiedNotice] = useState(false);

  // Estado do mapa dentro da página da receita
  const [showMap, setShowMap] = useState(false);
  const [mapMode, setMapMode] = useState<'SINGLE_STORE' | 'SPLIT_STORES'>('SPLIT_STORES');
  const mapSectionRef = useRef<HTMLDivElement | null>(null);

  // Estado do formulário para adicionar receita (Texto, Imagem ou Link URL)
  const [showAddForm, setShowAddForm] = useState(false);
  const [inputTab, setInputTab] = useState<'TEXT' | 'IMAGE' | 'URL'>('TEXT');
  const [rawRecipeText, setRawRecipeText] = useState('');
  const [recipeUrl, setRecipeUrl] = useState('');
  const [previewingUrl, setPreviewingUrl] = useState(false);
  const [urlPreview, setUrlPreview] = useState<{
    name: string;
    servings: number;
    instructions: string;
    extractionMethod?: string;
    sourceUrl?: string;
    previewedForUrl?: string;
    ingredients: Array<{
      name: string;
      quantityInBaseUnit: number;
      baseUnit: string;
      rawQuantityText?: string;
      category?: string;
      standardPackageSize?: number;
    }>;
  } | null>(null);
  const [lastUrlError, setLastUrlError] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string>('image/jpeg');
  const [imageNote, setImageNote] = useState('');
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState<string | null>(null);

  const loadRecipes = useCallback(
    async (preferSelectId?: string | null) => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const isGitHubPages =
          typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');

        if (!isGitHubPages) {
          const res = await fetch(`/api/recipes?t=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) {
            const json = (await res.json()) as RecipesApiResponse;
            setRecipes(json.recipes || []);
            if (json.homeLocation) setHomeLocation(json.homeLocation);

            const targetId = preferSelectId || initialIdFromUrl;
            if (targetId && json.recipes.some((r) => r.recipeId === targetId)) {
              setSelectedRecipeId(targetId);
            } else if (json.recipes.length > 0) {
              setSelectedRecipeId((prev) =>
                prev && json.recipes.some((r) => r.recipeId === prev)
                  ? prev
                  : json.recipes[0].recipeId
              );
            }
            return;
          }
        }

        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
        const bucket = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'FotosArgus';

        const applyPayload = (payload: {
          recipesEvaluations?: RecipeCostEvaluation[];
          homeLocation?: { lat: number; lng: number; address: string };
        }) => {
          const fallbackRecipes = (payload.recipesEvaluations || []) as RecipeCostEvaluation[];
          setRecipes(fallbackRecipes);
          if (payload.homeLocation) setHomeLocation(payload.homeLocation);
          const targetId = preferSelectId || initialIdFromUrl;
          if (targetId && fallbackRecipes.some((r) => r.recipeId === targetId)) {
            setSelectedRecipeId(targetId);
          } else if (fallbackRecipes.length > 0) {
            setSelectedRecipeId(fallbackRecipes[0].recipeId);
          }
        };

        if (supabaseUrl) {
          try {
            const liveUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(
              bucket
            )}/public-bi/dashboard-live.json?t=${Date.now()}`;
            const liveRes = await fetch(liveUrl, { cache: 'no-store' });
            if (liveRes.ok) {
              applyPayload(await liveRes.json());
              return;
            }
          } catch {
            // Segue para snapshot estático
          }
        }

        const snapRes = await fetch(`${basePath}/data/dashboard-snapshot.json?t=${Date.now()}`);
        applyPayload(await snapRes.json());
      } catch (err) {
        setErrorMsg((err as Error).message || 'Falha ao carregar receitas.');
      } finally {
        setLoading(false);
      }
    },
    [initialIdFromUrl]
  );

  useEffect(() => {
    loadRecipes(initialIdFromUrl);
  }, [loadRecipes, initialIdFromUrl]);

  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const r of recipes) {
      for (const t of r.cuisineTags || []) {
        tagSet.add(t);
      }
    }
    return ['TODAS', ...Array.from(tagSet)];
  }, [recipes]);

  const filteredRecipes = useMemo(() => {
    return recipes.filter((r) => {
      const matchesTag = selectedTag === 'TODAS' || (r.cuisineTags || []).includes(selectedTag);
      if (!matchesTag) return false;
      return matchesRecipeSearch(r, searchQuery);
    });
  }, [recipes, searchQuery, selectedTag]);

  const activeRecipe = useMemo(() => {
    if (filteredRecipes.length > 0) {
      return (
        filteredRecipes.find((r) => r.recipeId === selectedRecipeId) ||
        filteredRecipes[0]
      );
    }
    return (
      recipes.find((r) => r.recipeId === selectedRecipeId) ||
      recipes[0] ||
      null
    );
  }, [filteredRecipes, recipes, selectedRecipeId]);

  useEffect(() => {
    if (!activeRecipe?.routeAnalysis) return;
    const hasMulti = (activeRecipe.routeAnalysis.splitStoreOrder?.length ?? 0) > 1;
    setMapMode(hasMulti ? 'SPLIT_STORES' : 'SINGLE_STORE');
  }, [activeRecipe]);

  function handleShowOnMap(mode?: 'SINGLE_STORE' | 'SPLIT_STORES') {
    if (mode) {
      setMapMode(mode);
    } else if (activeRecipe?.routeAnalysis) {
      setMapMode(
        activeRecipe.routeAnalysis.splitStoreOrder.length > 1 ? 'SPLIT_STORES' : 'SINGLE_STORE'
      );
    }
    setShowMap(true);
    setTimeout(() => {
      mapSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 90);
  }

  function processImageFile(file: File) {
    setImageMimeType(file.type || 'image/jpeg');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setImagePreviewUrl(dataUrl);
      setImageBase64(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    processImageFile(file);
  }

  function handleDropImage(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDraggingImage(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      processImageFile(file);
    }
  }

  async function handlePreviewRecipeUrl() {
    const cleanUrl = recipeUrl.trim();
    if (!cleanUrl) {
      setErrorMsg('Informe uma URL completa (https://...) para pré-visualizar.');
      setLastUrlError(true);
      return;
    }

    setPreviewingUrl(true);
    setErrorMsg(null);
    setSubmitFeedback(null);
    setLastUrlError(false);

    try {
      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeUrl: cleanUrl, previewOnly: true })
      });
      const json = await res.json();
      if (!res.ok || json.status === 'error' || !json.preview) {
        throw new Error(json.message || 'Não foi possível extrair os ingredientes desse link.');
      }
      setUrlPreview({
        ...json.preview,
        previewedForUrl: cleanUrl
      });
    } catch (err) {
      setUrlPreview(null);
      setLastUrlError(true);
      setErrorMsg((err as Error).message || 'Não foi possível ler o link informado.');
    } finally {
      setPreviewingUrl(false);
    }
  }

  function handleEditUrlPreviewAsText() {
    if (!urlPreview) return;
    const ingLines = urlPreview.ingredients.map((ing) =>
      `- ${ing.rawQuantityText || `${ing.quantityInBaseUnit}${ing.baseUnit}`} de ${ing.name}`
    );
    const assembled = [
      `${urlPreview.name} (${urlPreview.servings} porções)`,
      'Ingredientes:',
      ...ingLines,
      'Modo de preparo:',
      urlPreview.instructions
    ].join('\n');

    setRawRecipeText(assembled);
    setUrlPreview(null);
    setLastUrlError(false);
    setErrorMsg(null);
    setInputTab('TEXT');
  }

  async function handleSaveRecipe(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitFeedback(null);
    setErrorMsg(null);
    setLastUrlError(false);

    try {
      const cleanUrl = recipeUrl.trim();
      const payload =
        inputTab === 'IMAGE'
          ? { imageBase64, mimeType: imageMimeType, rawText: imageNote }
          : inputTab === 'URL'
            ? urlPreview && urlPreview.previewedForUrl === cleanUrl
              ? { recipe: urlPreview }
              : { recipeUrl: cleanUrl }
            : { rawText: rawRecipeText };

      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!res.ok || json.status === 'error') {
        throw new Error(json.message || 'Não foi possível salvar a receita.');
      }

      const savedId = json.saved?.recipeId as string | undefined;
      setRawRecipeText('');
      setRecipeUrl('');
      setUrlPreview(null);
      setLastUrlError(false);
      setImagePreviewUrl(null);
      setImageBase64(null);
      setImageNote('');
      setShowAddForm(false);
      setSubmitFeedback(
        `Receita "${json.saved?.recipeName}" salva no banco com preços atualizados e rota calculada!`
      );
      await loadRecipes(savedId);
    } catch (err) {
      if (inputTab === 'URL') {
        setLastUrlError(true);
      }
      setErrorMsg((err as Error).message || 'Erro ao salvar receita.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteRecipe(id: string) {
    try {
      const res = await fetch(`/api/recipes?id=${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setSubmitFeedback('Receita removida do banco.');
        await loadRecipes(null);
      }
    } catch {
      // ignore
    }
  }

  function toggleCartItem(recipeId: string, productId: string) {
    setCheckedCartByRecipe((prev) => {
      const current = prev[recipeId] || [];
      const exists = current.includes(productId);
      return {
        ...prev,
        [recipeId]: exists ? current.filter((id) => id !== productId) : [...current, productId]
      };
    });
  }

  function toggleCookingStep(recipeId: string, stepIdx: number) {
    setCompletedStepsByRecipe((prev) => {
      const current = prev[recipeId] || [];
      const exists = current.includes(stepIdx);
      return {
        ...prev,
        [recipeId]: exists ? current.filter((s) => s !== stepIdx) : [...current, stepIdx]
      };
    });
  }

  async function handleCopyShoppingList(rec: RecipeCostEvaluation) {
    const lines = [
      `🛒 Lista de Compras Argus — ${rec.recipeName} (${Math.round(
        rec.servings * portionMultiplier
      )} porções)`,
      `💰 Menor Custo Possível: R$ ${(rec.lowestPossibleCashCost * portionMultiplier).toFixed(2)}`,
      `🏪 Melhor Mercado Único: ${rec.bestSingleStoreName} (R$ ${(
        rec.bestSingleStoreCashCost * portionMultiplier
      ).toFixed(2)})`,
      '',
      '🧊 Ordem Anti-Perecíveis (1º Despensa → 4º Carnes/Congelados):'
    ];
    for (const ing of rec.ingredientsBreakdown) {
      const qtyStr = formatQty(ing.requiredBaseQty * portionMultiplier, ing.baseUnit);
      lines.push(
        `• [${ing.perishabilityRank}º] ${ing.productName} (${qtyStr}) — ${ing.bestStoreName} · R$ ${(
          ing.cashOutlayCost * portionMultiplier
        ).toFixed(2)}`
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopiedNotice(true);
      setTimeout(() => setCopiedNotice(false), 2400);
    } catch {
      // ignore clipboard fallback
    }
  }

  const singleScenario = buildScaledScenario(
    activeRecipe?.routeAnalysis?.singleStoreScenario,
    portionMultiplier
  );
  const splitScenario = buildScaledScenario(
    activeRecipe?.routeAnalysis?.splitStoreScenario,
    portionMultiplier
  );

  const activeCartIds = useMemo(
    () => (activeRecipe ? checkedCartByRecipe[activeRecipe.recipeId] || [] : []),
    [activeRecipe, checkedCartByRecipe]
  );
  const activeDoneSteps = useMemo(
    () => (activeRecipe ? completedStepsByRecipe[activeRecipe.recipeId] || [] : []),
    [activeRecipe, completedStepsByRecipe]
  );

  const shoppingProgress = useMemo(() => {
    if (!activeRecipe || activeRecipe.ingredientsBreakdown.length === 0) {
      return { checkedCount: 0, total: 0, pct: 0, remainingCash: 0 };
    }
    const total = activeRecipe.ingredientsBreakdown.length;
    const checkedCount = activeRecipe.ingredientsBreakdown.filter((i) =>
      activeCartIds.includes(i.productId)
    ).length;
    const remainingCash = activeRecipe.ingredientsBreakdown
      .filter((i) => !activeCartIds.includes(i.productId))
      .reduce((acc, i) => acc + i.cashOutlayCost * portionMultiplier, 0);
    return {
      checkedCount,
      total,
      pct: Math.round((checkedCount / total) * 100),
      remainingCash: Number(remainingCash.toFixed(2))
    };
  }, [activeRecipe, activeCartIds, portionMultiplier]);

  const cookingProgress = useMemo(() => {
    const steps = activeRecipe?.instructionSteps || [];
    if (steps.length === 0) return { done: 0, total: 0, pct: 0 };
    const done = steps.filter((_, idx) => activeDoneSteps.includes(idx)).length;
    return {
      done,
      total: steps.length,
      pct: Math.round((done / steps.length) * 100)
    };
  }, [activeRecipe, activeDoneSteps]);

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100">
      {/* TOP BAR CONTRACT: 3 ZONAS EM UMA LINHA */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-md px-6 py-3.5">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            <Utensils className="h-5 w-5 text-emerald-400" />
            <span>Argus Vision BI</span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            <Link
              href="/"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
            >
              <ArrowLeft className="h-4 w-4" />
              Painel Geral
            </Link>
            <Link
              href="/produtos"
              className="hover:text-sky-300 transition-colors whitespace-nowrap shrink-0"
            >
              Produtos Escaneados
            </Link>
            <Link
              href="/mercados"
              className="hover:text-emerald-300 transition-colors whitespace-nowrap shrink-0"
            >
              Mercados &amp; B.I.
            </Link>
            <Link
              href="/receitas"
              className="text-emerald-400 border-b border-emerald-400 pb-0.5 whitespace-nowrap shrink-0"
            >
              Receitas e Rotas
            </Link>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <motion.button
              whileTap={{ scale: 0.96 }}
              type="button"
              onClick={() => setShowAddForm((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors whitespace-nowrap shrink-0 shadow-lg shadow-emerald-950/40"
            >
              {showAddForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              <span>{showAddForm ? 'Fechar Formulário' : 'Adicionar Receita'}</span>
            </motion.button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] p-5 lg:p-8 space-y-6">
        {/* HERO DA PÁGINA */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div>
            <p className="text-xs font-medium text-emerald-400 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              Custo Atualizado · Aproveitamento de Despensa · Cadeia Fria &amp; OSRM
            </p>
            <h1 className="text-2xl lg:text-3xl font-bold text-white mt-1">
              Receitas, Menor Preço e Ordem Anti-Perecíveis
            </h1>
            <p className="text-sm text-slate-400 mt-1 max-w-3xl">
              Compare o menor custo dividido entre mercados contra o melhor mercado único, marque itens direto no carrinho, descubra receitas similares que reaproveitam sobras e trace sua rota anti-perecíveis no mapa.
            </p>
          </div>
          <div className="text-xs text-slate-400 tabular-nums shrink-0 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
            Base: <span className="text-slate-200 font-medium">{homeLocation.address}</span>
          </div>
        </section>

        {/* FEEDBACK / ERRO ANIMADOS */}
        <AnimatePresence>
          {submitFeedback && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex items-center justify-between rounded-xl border border-emerald-500/40 bg-emerald-950/30 px-4 py-3 text-xs text-emerald-200"
            >
              <span className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                {submitFeedback}
              </span>
              <button
                type="button"
                onClick={() => setSubmitFeedback(null)}
                className="text-emerald-300 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </motion.div>
          )}

          {errorMsg && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-rose-500/40 bg-rose-950/30 px-4 py-3 text-xs text-rose-200"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {lastUrlError && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddForm(true);
                        setInputTab('TEXT');
                        setLastUrlError(false);
                        setErrorMsg(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-rose-400/40 bg-slate-950/80 hover:border-emerald-400/70 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors"
                    >
                      <FileText className="h-3 w-3 text-emerald-400" />
                      Colar por Texto
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddForm(true);
                        setInputTab('IMAGE');
                        setLastUrlError(false);
                        setErrorMsg(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-rose-400/40 bg-slate-950/80 hover:border-emerald-400/70 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors"
                    >
                      <Camera className="h-3 w-3 text-emerald-400" />
                      Enviar Print (Imagem)
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg(null);
                    setLastUrlError(false);
                  }}
                  className="text-rose-300 hover:text-white"
                  aria-label="Fechar aviso"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* FORMULÁRIO PARA ADICIONAR RECEITA (TEXTO, IMAGEM OU LINK URL) */}
        <AnimatePresence>
          {showAddForm && (
            <motion.section
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.22 }}
              className="rounded-xl border border-emerald-500/35 bg-slate-900/80 p-5 space-y-4 shadow-xl shadow-black/30"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <ChefHat className="h-4 w-4 text-emerald-400" />
                    Adicionar Nova Receita ao Banco de Dados
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Cole um link de site de receitas, texto com ingredientes ou envie foto/print. O sistema cruza automaticamente com os preços dos mercados.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setInputTab('TEXT');
                      setLastUrlError(false);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${
                      inputTab === 'TEXT'
                        ? 'bg-emerald-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Por Texto
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInputTab('URL');
                      setLastUrlError(false);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${
                      inputTab === 'URL'
                        ? 'bg-emerald-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    Por Link (URL)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInputTab('IMAGE');
                      setLastUrlError(false);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${
                      inputTab === 'IMAGE'
                        ? 'bg-emerald-500 text-slate-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Por Imagem
                  </button>
                </div>
              </div>

              <form onSubmit={handleSaveRecipe} className="space-y-4">
                {inputTab === 'TEXT' ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-xs font-medium text-slate-300">
                        Nome, Ingredientes com Quantidades e Modo de Preparo
                      </label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-slate-500">Testar modelo rápido:</span>
                        {SAMPLE_RECIPE_TEMPLATES.map((tpl) => (
                          <button
                            key={tpl.label}
                            type="button"
                            onClick={() => setRawRecipeText(tpl.text)}
                            className="rounded-md border border-slate-700 bg-slate-950 hover:border-emerald-500/60 px-2.5 py-1 text-[11px] text-slate-300 hover:text-emerald-300 transition-colors"
                          >
                            {tpl.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <textarea
                      required
                      rows={6}
                      value={rawRecipeText}
                      onChange={(e) => setRawRecipeText(e.target.value)}
                      placeholder={`Exemplo:\nOmelete Proteico com Cebola (2 porções)\nIngredientes:\n- 4 ovos\n- 100g de cebola\n- 30g de manteiga\n- 100ml de leite integral\nModo de preparo: Bata os ovos com leite, refogue a cebola na manteiga e doure dos dois lados.`}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                ) : inputTab === 'URL' ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-300">
                        URL Pública da Receita (TudoGostoso, Panelinha, Receitas Globo, blogs culinários...)
                      </label>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <div className="relative flex-1">
                          <Link2 className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="url"
                            required
                            value={recipeUrl}
                            onChange={(e) => {
                              setRecipeUrl(e.target.value);
                              if (urlPreview && urlPreview.previewedForUrl !== e.target.value.trim()) {
                                setUrlPreview(null);
                              }
                            }}
                            placeholder="https://www.exemplo.com.br/receitas/bolo-de-cenoura"
                            className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={handlePreviewRecipeUrl}
                          disabled={previewingUrl || submitting || !recipeUrl.trim()}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-950/30 hover:bg-emerald-950/60 disabled:opacity-50 px-4 py-2.5 text-xs font-semibold text-emerald-300 transition-colors whitespace-nowrap"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {previewingUrl ? 'Analisando Link...' : 'Pré-visualizar antes de salvar'}
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Proteção ativa: validação anti-SSRF (bloqueia IPs privados/locais), leitura segura JSON-LD/Microdata/HTML e limite máximo de 2 MB.
                      </p>
                    </div>

                    <AnimatePresence>
                      {urlPreview && (
                        <motion.div
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          className="rounded-xl border border-emerald-500/40 bg-slate-950/80 p-4 space-y-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800 pb-2.5">
                            <div>
                              <span className="text-[11px] font-semibold text-emerald-400">
                                Pré-visualização Extraída ({urlPreview.extractionMethod || 'HTML'}) ·{' '}
                                {urlPreview.servings} porções
                              </span>
                              <h3 className="text-sm font-bold text-white mt-0.5">
                                {urlPreview.name}
                              </h3>
                            </div>
                            <button
                              type="button"
                              onClick={handleEditUrlPreviewAsText}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-700 hover:border-emerald-500/60 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:text-emerald-300 transition-colors"
                            >
                              <FileText className="h-3 w-3" />
                              Editar no modo Texto
                            </button>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                            <div className="space-y-1">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                Ingredientes detectados ({urlPreview.ingredients.length})
                              </p>
                              <ul className="space-y-1 max-h-40 overflow-y-auto pr-1 text-slate-200">
                                {urlPreview.ingredients.map((ing, idx) => (
                                  <li
                                    key={`${ing.name}-${idx}`}
                                    className="flex items-center justify-between gap-2 border-b border-slate-800/60 pb-1"
                                  >
                                    <span className="truncate">{ing.name}</span>
                                    <span className="text-emerald-300 font-semibold tabular-nums shrink-0">
                                      {ing.rawQuantityText || formatQty(ing.quantityInBaseUnit, ing.baseUnit)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                            <div className="space-y-1">
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                Modo de Preparo Resumido
                              </p>
                              <p className="text-xs text-slate-300 leading-relaxed max-h-40 overflow-y-auto whitespace-pre-line">
                                {urlPreview.instructions}
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        setIsDraggingImage(true);
                      }}
                      onDragLeave={() => setIsDraggingImage(false)}
                      onDrop={handleDropImage}
                      className={`space-y-2.5 rounded-xl border border-dashed p-4 transition-colors ${
                        isDraggingImage
                          ? 'border-emerald-400 bg-emerald-950/20'
                          : 'border-slate-700 bg-slate-950/60'
                      }`}
                    >
                      <label className="block text-xs font-medium text-slate-300">
                        Arraste ou selecione Foto / Print da Receita (JPG, PNG, WebP)
                      </label>
                      <input
                        type="file"
                        accept="image/*"
                        required={!imageBase64}
                        onChange={handleImageSelect}
                        className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-500 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-950 hover:file:bg-emerald-400"
                      />
                      <input
                        type="text"
                        value={imageNote}
                        onChange={(e) => setImageNote(e.target.value)}
                        placeholder="Observação opcional (ex: dobrar porções ou nome do prato)"
                        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                      />
                    </div>
                    <div className="flex items-center justify-center rounded-xl border border-slate-800 bg-slate-950/70 p-3 min-h-[148px]">
                      {imagePreviewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imagePreviewUrl}
                          alt="Pré-visualização da receita enviada"
                          referrerPolicy="no-referrer"
                          className="max-h-44 rounded-md object-contain"
                        />
                      ) : (
                        <div className="text-center space-y-1">
                          <Camera className="h-6 w-6 text-slate-600 mx-auto" />
                          <span className="text-xs text-slate-500 block">
                            Nenhuma imagem selecionada
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 transition-colors"
                  >
                    Cancelar
                  </button>
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    type="submit"
                    disabled={submitting || previewingUrl}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 px-5 py-2 text-xs font-semibold text-slate-950 transition-colors"
                  >
                    {submitting
                      ? 'Processando e Consultando Mercados...'
                      : inputTab === 'URL'
                        ? urlPreview && urlPreview.previewedForUrl === recipeUrl.trim()
                          ? 'Confirmar e Salvar Receita'
                          : 'Importar & Salvar Direto'
                        : 'Salvar Receita e Calcular Preços'}
                  </motion.button>
                </div>
              </form>
            </motion.section>
          )}
        </AnimatePresence>

        {/* CONTEÚDO PRINCIPAL */}
        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-4 h-96 rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse" />
            <div className="lg:col-span-8 h-96 rounded-xl border border-slate-800 bg-slate-900/50 animate-pulse" />
          </div>
        ) : recipes.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-10 text-center space-y-3">
            <ChefHat className="h-10 w-10 text-emerald-400 mx-auto" />
            <h2 className="text-lg font-bold text-white">Nenhuma receita cadastrada ainda</h2>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Adicione sua primeira receita por texto ou imagem aqui no painel — ou envie pelo @MonetaArgusBot no Telegram.
            </p>
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950"
            >
              <Plus className="h-4 w-4" />
              Adicionar Primeira Receita
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* COLUNA ESQUERDA: CATÁLOGO FILTRÁVEL DE RECEITAS */}
            <aside className="lg:col-span-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3.5">
              <div className="space-y-1.5">
                <div className="relative">
                  <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    aria-label="Buscar receitas por nome, ingrediente, mercado ou preparo"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && searchQuery) {
                        e.preventDefault();
                        setSearchQuery('');
                      }
                    }}
                    placeholder="Buscar receita, ingrediente ou mercado..."
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-9 pr-8 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                  />
                  {searchQuery.length > 0 && (
                    <button
                      type="button"
                      aria-label="Limpar busca de receitas"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {(searchQuery.trim().length > 0 || selectedTag !== 'TODAS') && (
                  <div className="flex items-center justify-between text-[11px] text-slate-400 px-0.5 tabular-nums">
                    <span>
                      Exibindo <strong className="text-slate-200">{filteredRecipes.length}</strong> de{' '}
                      {recipes.length} receita(s)
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setSelectedTag('TODAS');
                      }}
                      className="text-emerald-400 hover:text-emerald-300 font-medium"
                    >
                      Limpar filtros
                    </button>
                  </div>
                )}
              </div>

              {/* FILTROS POR CATEGORIA / TAG CULINÁRIA */}
              <div className="flex flex-wrap gap-1.5">
                {availableTags.map((tag) => {
                  const active = selectedTag === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setSelectedTag(tag)}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                        active
                          ? 'bg-emerald-500 text-slate-950 font-semibold'
                          : 'bg-slate-950 border border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      {tag === 'TODAS' ? `Todas (${recipes.length})` : tag}
                    </button>
                  );
                })}
              </div>

              <LayoutGroup id="argus-recipe-catalog">
                <div className="space-y-2.5 max-h-[720px] overflow-y-auto pr-1">
                  {filteredRecipes.length === 0 ? (
                    <div className="py-6 px-3 text-center space-y-2 rounded-lg border border-slate-800/80 bg-slate-950/50">
                      <p className="text-xs text-slate-300">
                        Nenhuma receita encontrada para &ldquo;{searchQuery.trim() || selectedTag}&rdquo;.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setSelectedTag('TODAS');
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:border-emerald-500/50"
                      >
                        <X className="h-3 w-3" />
                        Limpar busca e filtros
                      </button>
                    </div>
                  ) : (
                    filteredRecipes.map((rec, index) => {
                      const isSelected = activeRecipe?.recipeId === rec.recipeId;
                      const isExpanded = expandedRecipeId === rec.recipeId;
                      const diffMeta = getDifficultyBadgeMeta(rec.difficulty);
                      const coldScore = rec.routeAnalysis?.coldChainScore ?? 94;

                      return (
                        <motion.div
                          key={rec.recipeId}
                          layout
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            opacity: { duration: 0.2, delay: Math.min(index * 0.035, 0.25) },
                            y: { duration: 0.2, delay: Math.min(index * 0.035, 0.25) },
                            layout: { type: 'spring', stiffness: 360, damping: 30 }
                          }}
                          whileHover={{ y: -2 }}
                          className={`rounded-xl border transition-colors ${
                            isSelected || isExpanded
                              ? 'border-emerald-500/60 bg-emerald-950/25 shadow-lg shadow-emerald-950/25'
                              : 'border-slate-800/80 bg-slate-950/60 hover:border-slate-700 hover:bg-slate-900/70'
                          }`}
                        >
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={() => {
                              setSelectedRecipeId(rec.recipeId);
                              setPortionMultiplier(1);
                              setExpandedRecipeId((prev) =>
                                prev === rec.recipeId ? null : rec.recipeId
                              );
                            }}
                            className="w-full text-left p-3.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 rounded-xl"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-white leading-snug">
                                  {rec.recipeName}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-xs font-bold text-emerald-400 tabular-nums">
                                  R$ {rec.lowestPossibleCashCost.toFixed(2)}
                                </span>
                                <motion.span
                                  animate={{ rotate: isExpanded ? 180 : 0 }}
                                  transition={{ type: 'spring', stiffness: 340, damping: 24 }}
                                  className={`inline-flex h-5 w-5 items-center justify-center rounded-md border ${
                                    isExpanded
                                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                      : 'border-slate-800 bg-slate-900 text-slate-400'
                                  }`}
                                >
                                  <ChevronDown className="h-3.5 w-3.5" />
                                </motion.span>
                              </div>
                            </div>

                            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400 tabular-nums">
                              <span className="inline-flex items-center gap-1">
                                <Timer className="h-3 w-3 text-emerald-400/80" />
                                {rec.prepTimeMinutes} min
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{rec.servings} porções</span>
                              <span aria-hidden="true">·</span>
                              <span
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold border ${diffMeta.badgeClass}`}
                              >
                                {rec.difficulty}
                              </span>
                            </div>

                            <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
                              <span className="truncate">{rec.bestSingleStoreName}</span>
                              <span className="text-emerald-400/90 tabular-nums shrink-0">
                                R$ {rec.proportionalCostPerPortion.toFixed(2)}/porção
                              </span>
                            </div>
                          </button>

                          <AnimatePresence initial={false}>
                            {isExpanded && (
                              <motion.div
                                key={`expand-${rec.recipeId}`}
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{
                                  height: { duration: 0.25, ease: [0.22, 1, 0.36, 1] },
                                  opacity: { duration: 0.18 }
                                }}
                                className="overflow-hidden"
                              >
                                <div className="px-3.5 pb-3.5 pt-2.5 border-t border-slate-800/80 space-y-3">
                                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                                    <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                      <span className="text-slate-400 flex items-center gap-1">
                                        <Timer className="h-3 w-3 text-emerald-400" />
                                        Tempo de Preparo
                                      </span>
                                      <p className="mt-0.5 font-semibold text-white tabular-nums">
                                        {rec.prepTimeMinutes} minutos
                                      </p>
                                    </div>

                                    <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                      <span className="text-slate-400 flex items-center gap-1">
                                        <Gauge className="h-3 w-3 text-amber-400" />
                                        Dificuldade
                                      </span>
                                      <div className="mt-0.5 flex items-center justify-between gap-2">
                                        <span className="font-semibold text-white">
                                          {rec.difficulty}
                                        </span>
                                        <span
                                          className="inline-flex items-center gap-0.5"
                                          aria-hidden="true"
                                        >
                                          {[1, 2, 3].map((step) => (
                                            <span
                                              key={step}
                                              className={`h-1.5 w-3 rounded-sm ${
                                                step <= diffMeta.level
                                                  ? diffMeta.barClass
                                                  : 'bg-slate-800'
                                              }`}
                                            />
                                          ))}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                      <span className="text-slate-400 flex items-center gap-1">
                                        <Flame className="h-3 w-3 text-orange-400" />
                                        Valor Calórico
                                      </span>
                                      <p className="mt-0.5 font-semibold text-white tabular-nums">
                                        ~{rec.estimatedCaloriesPerPortion} kcal/porção
                                      </p>
                                    </div>

                                    <div className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-2">
                                      <span className="text-slate-400 flex items-center gap-1">
                                        <Snowflake className="h-3 w-3 text-sky-400" />
                                        Cadeia Fria &amp; Preços
                                      </span>
                                      <p className="mt-0.5 font-semibold text-white tabular-nums">
                                        {coldScore}/100 · {rec.priceCoverageCount}/
                                        {rec.totalIngredientsCount} itens
                                      </p>
                                    </div>
                                  </div>

                                  {rec.cuisineTags.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {rec.cuisineTags.slice(0, 4).map((tag) => (
                                        <span
                                          key={tag}
                                          className="rounded border border-slate-800 bg-slate-900/90 px-1.5 py-0.5 text-[10px] text-slate-300"
                                        >
                                          {tag}
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  {rec.ingredientsBreakdown.length > 0 && (
                                    <div className="text-[11px] text-slate-400">
                                      <span className="text-slate-500 font-medium">
                                        Principais ingredientes:{' '}
                                      </span>
                                      <span className="text-slate-300">
                                        {rec.ingredientsBreakdown
                                          .slice(0, 4)
                                          .map((ing) => ing.productName)
                                          .join(', ')}
                                        {rec.ingredientsBreakdown.length > 4
                                          ? ` +${rec.ingredientsBreakdown.length - 4}`
                                          : ''}
                                      </span>
                                    </div>
                                  )}

                                  <div className="flex flex-wrap items-center gap-2 pt-1">
                                    <motion.button
                                      whileTap={{ scale: 0.96 }}
                                      type="button"
                                      onClick={() => {
                                        setSelectedRecipeId(rec.recipeId);
                                        setPortionMultiplier(1);
                                        setActiveDetailTab('SHOPPING');
                                      }}
                                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 transition-colors"
                                    >
                                      <ShoppingCart className="h-3 w-3" />
                                      <span>Lista &amp; Cadeia Fria</span>
                                    </motion.button>

                                    <motion.button
                                      whileTap={{ scale: 0.96 }}
                                      type="button"
                                      onClick={() => {
                                        setSelectedRecipeId(rec.recipeId);
                                        setPortionMultiplier(1);
                                        handleShowOnMap();
                                      }}
                                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 px-2.5 py-1.5 text-[11px] font-semibold text-amber-300 transition-colors"
                                    >
                                      <MapPin className="h-3 w-3" />
                                      <span>Ver no Mapa</span>
                                    </motion.button>
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })
                  )}
                </div>
              </LayoutGroup>
            </aside>

            {/* COLUNA DIREITA: WORKSPACE INTERATIVO DA RECEITA */}
            {activeRecipe && (
              <div className="lg:col-span-8 space-y-6">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeRecipe.recipeId}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-6"
                  >
                    {/* CARD PRINCIPAL + METADADOS + CONTROLES + ABAS INTERATIVAS */}
                    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
                      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b border-slate-800 pb-4">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
                            <span className="inline-flex items-center gap-1 text-emerald-300 font-medium">
                              <Timer className="h-3.5 w-3.5" />
                              {activeRecipe.prepTimeMinutes} min
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1">
                              <ChefHat className="h-3.5 w-3.5 text-amber-400" />
                              {activeRecipe.difficulty}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1">
                              <Flame className="h-3.5 w-3.5 text-orange-400" />
                              ~{activeRecipe.estimatedCaloriesPerPortion} kcal/porção
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {activeRecipe.priceCoverageCount}/{activeRecipe.totalIngredientsCount} c/ preço real
                            </span>
                          </div>
                          <h2 className="text-xl lg:text-2xl font-bold text-white">
                            {activeRecipe.recipeName}
                          </h2>
                          {activeRecipe.cuisineTags.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              {activeRecipe.cuisineTags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-md border border-slate-700/80 bg-slate-950/70 px-2 py-0.5 text-[11px] text-slate-300"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {/* Stepper dinâmico de escala de porções */}
                          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
                            <button
                              type="button"
                              aria-label="Reduzir porções"
                              onClick={() => setPortionMultiplier((m) => Math.max(0.5, Number((m - 0.5).toFixed(1))))}
                              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span className="px-2 font-semibold text-white tabular-nums whitespace-nowrap">
                              {Math.max(1, Math.round(activeRecipe.servings * portionMultiplier))} porções ({portionMultiplier}x)
                            </span>
                            <button
                              type="button"
                              aria-label="Aumentar porções"
                              onClick={() => setPortionMultiplier((m) => Math.min(5, Number((m + 0.5).toFixed(1))))}
                              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          <motion.button
                            whileTap={{ scale: 0.96 }}
                            type="button"
                            onClick={() => handleShowOnMap()}
                            className="inline-flex items-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 px-4 py-2 text-xs font-bold text-slate-950 transition-colors whitespace-nowrap shrink-0 shadow-lg shadow-amber-950/30"
                          >
                            <MapPin className="h-4 w-4" />
                            <span>Mostrar no Mapa</span>
                          </motion.button>

                          {activeRecipe.recipeId.startsWith('recipe-custom-') && (
                            <button
                              type="button"
                              onClick={() => handleDeleteRecipe(activeRecipe.recipeId)}
                              title="Excluir receita personalizada"
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 hover:border-rose-500/60 px-2.5 py-2 text-xs text-slate-400 hover:text-rose-300 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* BARRA DE NAVEGAÇÃO INTERATIVA COM LAYOUTID ANIMADO */}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
                          {(
                            [
                              { id: 'OVERVIEW', label: 'Custos & Similares', icon: Sparkles },
                              {
                                id: 'SHOPPING',
                                label: `Lista & Cadeia Fria (${shoppingProgress.checkedCount}/${shoppingProgress.total})`,
                                icon: ShoppingCart
                              },
                              {
                                id: 'COOKING',
                                label: `Modo Cozinha (${cookingProgress.done}/${cookingProgress.total})`,
                                icon: ListChecks
                              },
                              { id: 'MARKETS', label: 'Mercados & Preços', icon: Store }
                            ] as Array<{ id: DetailTab; label: string; icon: React.ComponentType<{ className?: string }> }>
                          ).map((tab) => {
                            const Icon = tab.icon;
                            const isActive = activeDetailTab === tab.id;
                            return (
                              <button
                                key={tab.id}
                                type="button"
                                onClick={() => setActiveDetailTab(tab.id)}
                                className={`relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                                  isActive ? 'text-slate-950' : 'text-slate-400 hover:text-white'
                                }`}
                              >
                                {isActive && (
                                  <motion.span
                                    layoutId="recipe-detail-tab-pill"
                                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                                    className="absolute inset-0 rounded-lg bg-emerald-400"
                                  />
                                )}
                                <span className="relative z-10 inline-flex items-center gap-1.5">
                                  <Icon className="h-3.5 w-3.5" />
                                  {tab.label}
                                </span>
                              </button>
                            );
                          })}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleCopyShoppingList(activeRecipe)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 hover:border-emerald-500/60 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap"
                        >
                          {copiedNotice ? (
                            <>
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                              <span className="text-emerald-300">Lista copiada!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5 text-slate-400" />
                              <span>Copiar lista p/ compras</span>
                            </>
                          )}
                        </button>
                      </div>

                      {/* CONTEÚDO DA ABA ATIVA */}
                      <AnimatePresence mode="wait">
                        {activeDetailTab === 'OVERVIEW' && (
                          <motion.div
                            key="tab-overview"
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            transition={{ duration: 0.16 }}
                            className="space-y-5"
                          >
                            {/* 3 KPIs PRINCIPAIS */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/15 p-4">
                                <p className="text-xs font-medium text-emerald-300">
                                  Menor Preço Possível (Compra Otimizada)
                                </p>
                                <p className="text-2xl font-bold text-emerald-400 mt-1 tabular-nums">
                                  R${' '}
                                  {(activeRecipe.lowestPossibleCashCost * portionMultiplier).toFixed(
                                    2
                                  )}
                                </p>
                                <p className="text-[11px] text-slate-300 mt-1 tabular-nums">
                                  Proporcional no prato: R${' '}
                                  {(
                                    activeRecipe.lowestPossibleProportionalCost * portionMultiplier
                                  ).toFixed(2)}{' '}
                                  (R$ {activeRecipe.proportionalCostPerPortion.toFixed(2)}/porção) ·{' '}
                                  {activeRecipe.lowestPossibleStoresCount} mercado(s)
                                </p>
                              </div>

                              <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
                                <p className="text-xs font-medium text-slate-300">
                                  Melhor Lugar para Comprar Tudo
                                </p>
                                <p className="text-lg font-bold text-white mt-1 flex items-center gap-1.5">
                                  <Store className="h-4 w-4 text-amber-400 shrink-0" />
                                  <span className="truncate">{activeRecipe.bestSingleStoreName}</span>
                                </p>
                                <p className="text-sm font-semibold text-amber-300 mt-0.5 tabular-nums">
                                  R${' '}
                                  {(activeRecipe.bestSingleStoreCashCost * portionMultiplier).toFixed(
                                    2
                                  )}{' '}
                                  <span className="text-[11px] font-normal text-slate-400">
                                    ({activeRecipe.bestSingleStoreCoveragePct}% cobertura)
                                  </span>
                                </p>
                              </div>

                              <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
                                <p className="text-xs font-medium text-sky-300 flex items-center gap-1.5">
                                  <Snowflake className="h-3.5 w-3.5" />
                                  Cadeia Fria (Frescor:{' '}
                                  {activeRecipe.routeAnalysis?.coldChainScore ?? 94}/100)
                                </p>
                                <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                                  {activeRecipe.coldChainSummary}
                                </p>
                              </div>
                            </div>

                            {/* BARRA VISUAL: APROVEITAMENTO NO PRATO vs SOBRA DE DESPENSA */}
                            <div className="rounded-lg border border-slate-800/90 bg-slate-950/60 p-4 space-y-2.5">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="font-semibold text-white">
                                  Eficiência da Compra: Uso na Receita vs. Estoque de Sobras na Despensa
                                </span>
                                <span className="tabular-nums text-slate-300">
                                  <strong className="text-emerald-400">
                                    {activeRecipe.pantryUtilizationPct}%
                                  </strong>{' '}
                                  consumido agora ·{' '}
                                  <strong className="text-amber-300">
                                    R${' '}
                                    {(
                                      activeRecipe.totalLeftoverPantryValue * portionMultiplier
                                    ).toFixed(2)}
                                  </strong>{' '}
                                  em embalagens sobrando para próximas receitas
                                </span>
                              </div>
                              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800 flex">
                                <motion.div
                                  initial={{ width: 0 }}
                                  animate={{ width: `${activeRecipe.pantryUtilizationPct}%` }}
                                  transition={{ duration: 0.45, ease: 'easeOut' }}
                                  className="h-full bg-emerald-500"
                                />
                                <div className="h-full flex-1 bg-amber-500/60" />
                              </div>
                              {activeRecipe.routeAnalysis && (
                                <p className="text-[11px] text-slate-400">
                                  {activeRecipe.routeAnalysis.splitSavingsAmount > 0 ? (
                                    <>
                                      Economia bruta dividindo mercados:{' '}
                                      <strong className="text-emerald-300">
                                        R${' '}
                                        {(
                                          activeRecipe.routeAnalysis.splitSavingsAmount *
                                          portionMultiplier
                                        ).toFixed(2)}
                                      </strong>{' '}
                                      · Saldo líquido descontando combustível extra:{' '}
                                      <strong
                                        className={
                                          activeRecipe.routeAnalysis.netSplitSavingsWithGas > 0
                                            ? 'text-emerald-400'
                                            : 'text-amber-300'
                                        }
                                      >
                                        R${' '}
                                        {activeRecipe.routeAnalysis.netSplitSavingsWithGas.toFixed(2)}
                                      </strong>
                                      .
                                    </>
                                  ) : (
                                    'O melhor mercado único já empata com o menor custo possível para esta receita.'
                                  )}
                                </p>
                              )}
                            </div>

                            {/* RESUMO RÁPIDO DE PREPARO + RECEITAS SIMILARES */}
                            <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 p-4">
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                                  Resumo do Preparo
                                </h3>
                                <button
                                  type="button"
                                  onClick={() => setActiveDetailTab('COOKING')}
                                  className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"
                                >
                                  Abrir Modo Cozinha Interativo
                                  <ArrowRight className="h-3.5 w-3.5" />
                                </button>
                              </div>
                              <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">
                                {activeRecipe.instructions}
                              </p>
                            </div>

                            {/* RECEITAS SIMILARES & APROVEITAMENTO DE SOBRAS */}
                            {activeRecipe.similarRecipes &&
                              activeRecipe.similarRecipes.length > 0 && (
                                <div className="space-y-3">
                                  <div className="flex items-center justify-between">
                                    <div>
                                      <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                                        <Sparkles className="h-4 w-4 text-amber-400" />
                                        Receitas Similares &amp; Sinergia de Despensa
                                      </h3>
                                      <p className="text-xs text-slate-400">
                                        Pratos que compartilham ingredientes e aproveitam as sobras das embalagens desta compra
                                      </p>
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
                                    {activeRecipe.similarRecipes.map((sim) => {
                                      const isSimExpanded = expandedSimilarId === sim.recipeId;
                                      const simDiffMeta = getDifficultyBadgeMeta(sim.difficulty);
                                      return (
                                        <motion.div
                                          key={sim.recipeId}
                                          layout
                                          whileHover={{ y: -2 }}
                                          transition={{
                                            layout: { type: 'spring', stiffness: 360, damping: 30 }
                                          }}
                                          className={`rounded-xl border transition-colors ${
                                            isSimExpanded
                                              ? 'border-emerald-500/60 bg-slate-900/90 shadow-lg shadow-emerald-950/20'
                                              : 'border-slate-800 hover:border-emerald-500/50 bg-slate-950/70'
                                          }`}
                                        >
                                          <button
                                            type="button"
                                            aria-expanded={isSimExpanded}
                                            onClick={() =>
                                              setExpandedSimilarId((prev) =>
                                                prev === sim.recipeId ? null : sim.recipeId
                                              )
                                            }
                                            className="w-full text-left p-3.5 space-y-2 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                                          >
                                            <div className="flex items-start justify-between gap-2">
                                              <p className="text-xs font-bold text-white leading-snug">
                                                {sim.recipeName}
                                              </p>
                                              <div className="flex items-center gap-1.5 shrink-0">
                                                <span className="text-[11px] font-bold text-emerald-400 tabular-nums">
                                                  {sim.similarityPct}% match
                                                </span>
                                                <motion.span
                                                  animate={{ rotate: isSimExpanded ? 180 : 0 }}
                                                  transition={{
                                                    type: 'spring',
                                                    stiffness: 340,
                                                    damping: 24
                                                  }}
                                                  className="text-slate-400"
                                                >
                                                  <ChevronDown className="h-3.5 w-3.5" />
                                                </motion.span>
                                              </div>
                                            </div>
                                            <p className="text-[11px] text-slate-400">
                                              Compartilha {sim.sharedCount} item(ns):{' '}
                                              <span className="text-slate-300">
                                                {sim.sharedIngredients.slice(0, 3).join(', ')}
                                              </span>
                                            </p>
                                            <div className="flex items-center justify-between pt-1 border-t border-slate-800/80 text-[11px] tabular-nums">
                                              <span className="text-amber-300 font-semibold">
                                                +R$ {sim.additionalOutlayEstimate.toFixed(2)} extras
                                              </span>
                                              <span className="text-slate-400">
                                                {sim.prepTimeMinutes} min · {sim.difficulty}
                                              </span>
                                            </div>
                                          </button>

                                          <AnimatePresence initial={false}>
                                            {isSimExpanded && (
                                              <motion.div
                                                key={`sim-expand-${sim.recipeId}`}
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{
                                                  height: {
                                                    duration: 0.22,
                                                    ease: [0.22, 1, 0.36, 1]
                                                  },
                                                  opacity: { duration: 0.16 }
                                                }}
                                                className="overflow-hidden"
                                              >
                                                <div className="px-3.5 pb-3.5 pt-2 border-t border-slate-800/80 space-y-2.5 text-[11px]">
                                                  <div className="flex items-center justify-between gap-2">
                                                    <span className="inline-flex items-center gap-1 text-slate-300">
                                                      <Timer className="h-3 w-3 text-emerald-400" />
                                                      Preparo:{' '}
                                                      <strong className="text-white">
                                                        {sim.prepTimeMinutes} min
                                                      </strong>
                                                    </span>
                                                    <span
                                                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold border ${simDiffMeta.badgeClass}`}
                                                    >
                                                      <Gauge className="h-2.5 w-2.5" />
                                                      {sim.difficulty}
                                                    </span>
                                                  </div>

                                                  {sim.sharedIngredients.length > 0 && (
                                                    <div className="flex flex-wrap gap-1">
                                                      {sim.sharedIngredients.map((ing) => (
                                                        <span
                                                          key={ing}
                                                          className="rounded bg-emerald-950/50 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] text-emerald-300"
                                                        >
                                                          {ing}
                                                        </span>
                                                      ))}
                                                    </div>
                                                  )}

                                                  <motion.button
                                                    whileTap={{ scale: 0.96 }}
                                                    type="button"
                                                    onClick={() => {
                                                      setSelectedRecipeId(sim.recipeId);
                                                      setExpandedRecipeId(sim.recipeId);
                                                      setExpandedSimilarId(null);
                                                      setPortionMultiplier(1);
                                                    }}
                                                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-3 py-1.5 text-[11px] font-bold text-slate-950 transition-colors"
                                                  >
                                                    <span>Abrir Receita Completa</span>
                                                    <ArrowRight className="h-3.5 w-3.5" />
                                                  </motion.button>
                                                </div>
                                              </motion.div>
                                            )}
                                          </AnimatePresence>
                                        </motion.div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                          </motion.div>
                        )}

                        {activeDetailTab === 'SHOPPING' && (
                          <motion.div
                            key="tab-shopping"
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            transition={{ duration: 0.16 }}
                            className="space-y-4"
                          >
                            {/* BARRA DE PROGRESSO DO CARRINHO */}
                            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-2">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="font-semibold text-white flex items-center gap-1.5">
                                  <ShoppingCart className="h-4 w-4 text-emerald-400" />
                                  Checklist Interativo no Mercado (Clique para marcar no carrinho)
                                </span>
                                <span className="tabular-nums text-slate-300">
                                  <strong>
                                    {shoppingProgress.checkedCount}/{shoppingProgress.total}
                                  </strong>{' '}
                                  pegos ({shoppingProgress.pct}%) · Faltam{' '}
                                  <strong className="text-amber-300">
                                    R$ {shoppingProgress.remainingCash.toFixed(2)}
                                  </strong>
                                </span>
                              </div>
                              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                                <motion.div
                                  animate={{ width: `${shoppingProgress.pct}%` }}
                                  transition={{ duration: 0.25 }}
                                  className="h-full bg-emerald-500"
                                />
                              </div>
                            </div>

                            {/* LISTA RANQUEADA POR CADEIA FRIA */}
                            <div className="space-y-2.5">
                              {activeRecipe.ingredientsBreakdown.map((ing) => {
                                const checked = activeCartIds.includes(ing.productId);
                                const scaledQty = formatQty(
                                  ing.requiredBaseQty * portionMultiplier,
                                  ing.baseUnit
                                );
                                const scaledSurplus = formatQty(
                                  ing.surplusBaseQty * portionMultiplier,
                                  ing.baseUnit
                                );
                                return (
                                  <motion.button
                                    key={ing.productId}
                                    layout
                                    whileTap={{ scale: 0.99 }}
                                    type="button"
                                    onClick={() => toggleCartItem(activeRecipe.recipeId, ing.productId)}
                                    className={`w-full text-left rounded-xl border p-3.5 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                                      checked
                                        ? 'border-emerald-500/40 bg-emerald-950/20 opacity-75'
                                        : getTierBorderClass(ing.perishabilityTier)
                                    }`}
                                  >
                                    <div className="flex items-start gap-3">
                                      <div
                                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                                          checked
                                            ? 'border-emerald-400 bg-emerald-500 text-slate-950'
                                            : 'border-slate-600 bg-slate-950'
                                        }`}
                                      >
                                        {checked && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                                      </div>
                                      <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span
                                            className={`text-[11px] font-bold ${getTierTextColor(
                                              ing.perishabilityTier
                                            )}`}
                                          >
                                            {ing.perishabilityLabel}
                                          </span>
                                          <span className="text-[11px] text-slate-500">·</span>
                                          <span className="text-[11px] text-slate-300 font-medium">
                                            {ing.bestStoreName}
                                          </span>
                                        </div>
                                        <p
                                          className={`text-sm font-bold mt-0.5 ${
                                            checked ? 'line-through text-slate-400' : 'text-white'
                                          }`}
                                        >
                                          {ing.productName}
                                        </p>
                                        <p className="text-[11px] text-slate-400 mt-0.5">
                                          {ing.perishabilityReason}
                                        </p>
                                      </div>
                                    </div>

                                    <div className="flex sm:flex-col items-end justify-between sm:justify-center gap-1 shrink-0 tabular-nums pl-8 sm:pl-0">
                                      <span className="text-sm font-bold text-amber-300">
                                        R$ {(ing.cashOutlayCost * portionMultiplier).toFixed(2)} (
                                        {Math.ceil(ing.packagesNeeded * portionMultiplier)}x)
                                      </span>
                                      <span className="text-[11px] text-slate-300">
                                        Usa {scaledQty} (R${' '}
                                        {(ing.proportionalCost * portionMultiplier).toFixed(2)})
                                      </span>
                                      {ing.surplusBaseQty > 0 && (
                                        <span className="text-[10px] text-emerald-300">
                                          Sobra p/ despensa: {scaledSurplus}
                                        </span>
                                      )}
                                    </div>
                                  </motion.button>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}

                        {activeDetailTab === 'COOKING' && (
                          <motion.div
                            key="tab-cooking"
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            transition={{ duration: 0.16 }}
                            className="space-y-4"
                          >
                            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-2">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="font-semibold text-white flex items-center gap-1.5">
                                  <ChefHat className="h-4 w-4 text-emerald-400" />
                                  Passo a Passo Interativo ({activeRecipe.prepTimeMinutes} min estimados)
                                </span>
                                <span className="tabular-nums text-emerald-300 font-semibold">
                                  {cookingProgress.done}/{cookingProgress.total} etapas concluídas (
                                  {cookingProgress.pct}%)
                                </span>
                              </div>
                              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                                <motion.div
                                  animate={{ width: `${cookingProgress.pct}%` }}
                                  transition={{ duration: 0.25 }}
                                  className="h-full bg-emerald-500"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                              {/* Ingredientes na bancada */}
                              <div className="md:col-span-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2.5">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                                  Medidas na Bancada ({portionMultiplier}x)
                                </h4>
                                <ul className="space-y-2 text-xs">
                                  {activeRecipe.ingredientsBreakdown.map((ing) => (
                                    <li
                                      key={ing.productId}
                                      className="flex items-center justify-between gap-2 border-b border-slate-800/60 pb-1.5"
                                    >
                                      <span className="text-slate-200">{ing.productName.split('(')[0].trim()}</span>
                                      <span className="font-bold text-emerald-300 tabular-nums shrink-0">
                                        {formatQty(ing.requiredBaseQty * portionMultiplier, ing.baseUnit)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>

                              {/* Passos clicáveis */}
                              <div className="md:col-span-7 space-y-2.5">
                                {activeRecipe.instructionSteps.map((step, idx) => {
                                  const isDone = activeDoneSteps.includes(idx);
                                  return (
                                    <motion.button
                                      key={idx}
                                      whileTap={{ scale: 0.99 }}
                                      type="button"
                                      onClick={() => toggleCookingStep(activeRecipe.recipeId, idx)}
                                      className={`w-full text-left rounded-xl border p-3.5 flex items-start gap-3 transition-colors ${
                                        isDone
                                          ? 'border-emerald-500/40 bg-emerald-950/20'
                                          : 'border-slate-800 bg-slate-950/60 hover:bg-slate-800/40'
                                      }`}
                                    >
                                      <span
                                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                                          isDone
                                            ? 'bg-emerald-500 text-slate-950'
                                            : 'bg-slate-800 text-slate-200'
                                        }`}
                                      >
                                        {isDone ? <Check className="h-3.5 w-3.5 stroke-[3]" /> : idx + 1}
                                      </span>
                                      <span
                                        className={`text-sm leading-relaxed ${
                                          isDone ? 'line-through text-slate-400' : 'text-slate-100'
                                        }`}
                                      >
                                        {step}
                                      </span>
                                    </motion.button>
                                  );
                                })}
                              </div>
                            </div>
                          </motion.div>
                        )}

                        {activeDetailTab === 'MARKETS' && (
                          <motion.div
                            key="tab-markets"
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            transition={{ duration: 0.16 }}
                            className="space-y-4"
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                              <p className="text-xs text-slate-400">
                                Comparativo atualizado para comprar todos os ingredientes em um único supermercado vs. divisão otimizada
                              </p>
                              <button
                                type="button"
                                onClick={() => handleShowOnMap('SINGLE_STORE')}
                                className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1 whitespace-nowrap"
                              >
                                <MapPin className="h-3.5 w-3.5" />
                                Ver melhor mercado único no mapa
                              </button>
                            </div>

                            <div className="overflow-x-auto">
                              <table className="w-full text-left border-collapse text-xs">
                                <thead>
                                  <tr className="border-b border-slate-800 text-slate-400">
                                    <th className="py-2.5 px-3 font-semibold">Supermercado</th>
                                    <th className="py-2.5 px-3 font-semibold">Cobertura</th>
                                    <th className="py-2.5 px-3 font-semibold text-right">
                                      Uso Proporcional
                                    </th>
                                    <th className="py-2.5 px-3 font-semibold text-right">
                                      Caixa (Embalagens)
                                    </th>
                                    <th className="py-2.5 px-3 font-semibold text-right">
                                      vs. Menor Dividido
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/70">
                                  {activeRecipe.storeQuotes.map((sq, idx) => {
                                    const cashScaled = sq.totalCashCost * portionMultiplier;
                                    const propScaled = sq.totalProportionalCost * portionMultiplier;
                                    const diff =
                                      cashScaled -
                                      activeRecipe.lowestPossibleCashCost * portionMultiplier;
                                    const isBestSingle = idx === 0;
                                    return (
                                      <tr
                                        key={sq.storeId}
                                        className={
                                          isBestSingle ? 'bg-emerald-950/15' : 'hover:bg-slate-800/30'
                                        }
                                      >
                                        <td className="py-2.5 px-3">
                                          <div className="font-semibold text-white">
                                            {sq.storeName}
                                            {isBestSingle && (
                                              <span className="ml-2 text-[11px] font-medium text-emerald-400">
                                                Melhor Mercado Único
                                              </span>
                                            )}
                                          </div>
                                          <div className="text-[11px] text-slate-400">{sq.address}</div>
                                        </td>
                                        <td className="py-2.5 px-3 tabular-nums text-slate-300">
                                          {sq.matchedIngredientsCount}/{sq.totalIngredientsCount} itens (
                                          {sq.coveragePct}%)
                                        </td>
                                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-200">
                                          R$ {propScaled.toFixed(2)}
                                        </td>
                                        <td className="py-2.5 px-3 text-right tabular-nums font-bold text-white">
                                          R$ {cashScaled.toFixed(2)}
                                        </td>
                                        <td className="py-2.5 px-3 text-right tabular-nums text-amber-300">
                                          {diff <= 0.01 ? 'Menor preço' : `+ R$ ${diff.toFixed(2)}`}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </section>

                    {/* COMPARATIVO HISTÓRICO DIRETO: MERCADO SOUZA VS. NE SUPERMERCADO */}
                    <RecipeStoreComparisonCard
                      recipe={activeRecipe}
                      portionMultiplier={portionMultiplier}
                    />

                    {/* PAINEL DO MAPA & LINHA DO TEMPO DA CADEIA FRIA ("MOSTRAR NO MAPA") */}
                    <AnimatePresence>
                      {showMap && activeRecipe.routeAnalysis && (
                        <motion.section
                          ref={mapSectionRef}
                          id="recipe-map-panel"
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 12 }}
                          transition={{ duration: 0.25 }}
                          className="rounded-xl border border-emerald-500/40 bg-slate-900/80 p-5 space-y-5 shadow-xl shadow-black/30"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
                            <div>
                              <h3 className="text-base font-bold text-white flex items-center gap-2">
                                <Navigation className="h-4 w-4 text-emerald-400" />
                                Mapa de Rota &amp; Cadeia Fria: &ldquo;{activeRecipe.recipeName}&rdquo;
                              </h3>
                              <p className="text-xs text-slate-400 mt-0.5">
                                {activeRecipe.routeAnalysis.coldChainProtectedMinutes} min de proteção fora da geladeira para perecíveis/congelados ao deixá-los para a última parada.
                              </p>
                            </div>

                            <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs shrink-0">
                              <button
                                type="button"
                                onClick={() => setMapMode('SINGLE_STORE')}
                                className={`rounded-md px-3 py-1.5 font-semibold transition-colors whitespace-nowrap ${
                                  mapMode === 'SINGLE_STORE'
                                    ? 'bg-emerald-500 text-slate-950'
                                    : 'text-slate-300 hover:text-white'
                                }`}
                              >
                                Mercado Único ({singleScenario?.totalDistanceKm ?? 0} km)
                              </button>
                              <button
                                type="button"
                                onClick={() => setMapMode('SPLIT_STORES')}
                                className={`rounded-md px-3 py-1.5 font-semibold transition-colors whitespace-nowrap ${
                                  mapMode === 'SPLIT_STORES'
                                    ? 'bg-amber-500 text-slate-950'
                                    : 'text-slate-300 hover:text-white'
                                }`}
                              >
                                Rota Multi-Mercados ({splitScenario?.totalDistanceKm ?? 0} km)
                              </button>
                            </div>
                          </div>

                          {/* TIMELINE HORIZONTAL DA ROTA */}
                          {mapMode === 'SPLIT_STORES' &&
                            activeRecipe.routeAnalysis.splitStoreOrder.length > 0 && (
                              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/70 px-3.5 py-2.5 text-xs">
                                <span className="font-semibold text-emerald-300">🏠 Casa</span>
                                {activeRecipe.routeAnalysis.splitStoreOrder.map((stop) => (
                                  <React.Fragment key={stop.storeId}>
                                    <ArrowRight className="h-3.5 w-3.5 text-slate-600 shrink-0" />
                                    <span
                                      className={`font-semibold ${
                                        stop.maxPerishabilityRank >= 3
                                          ? 'text-rose-300'
                                          : 'text-amber-300'
                                      }`}
                                    >
                                      {stop.stopOrder}º {stop.storeName} (Rank {stop.maxPerishabilityRank}/4)
                                    </span>
                                  </React.Fragment>
                                ))}
                                <ArrowRight className="h-3.5 w-3.5 text-slate-600 shrink-0" />
                                <span className="font-semibold text-emerald-300">
                                  🏠 Casa (Geladeira)
                                </span>
                              </div>
                            )}

                          {singleScenario && splitScenario && (
                            <ArgusLogisticsMap
                              homeLocation={homeLocation}
                              singleScenario={singleScenario}
                              splitScenario={splitScenario}
                              activeMode={mapMode}
                            />
                          )}

                          {/* RESUMO LOGÍSTICO DA ROTA ATIVA */}
                          {(() => {
                            const current =
                              mapMode === 'SPLIT_STORES' ? splitScenario : singleScenario;
                            if (!current) return null;
                            return (
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs tabular-nums">
                                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                                  <span className="text-slate-400 block">Distância &amp; Tempo</span>
                                  <strong className="text-sm text-white flex items-center gap-1 mt-0.5">
                                    <Clock className="h-3.5 w-3.5 text-emerald-400" />
                                    {current.totalDistanceKm} km · {current.totalDurationMin} min
                                  </strong>
                                </div>
                                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                                  <span className="text-slate-400 block">Embalagens (Caixa)</span>
                                  <strong className="text-sm text-emerald-400 mt-0.5 block">
                                    R$ {current.productsCost.toFixed(2)}
                                  </strong>
                                </div>
                                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                                  <span className="text-slate-400 block">Total c/ Gasolina</span>
                                  <strong className="text-sm text-white mt-0.5 block">
                                    R$ {current.totalWithGas.toFixed(2)} (comb: R${' '}
                                    {current.gasCost.toFixed(2)})
                                  </strong>
                                </div>
                                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                                  <span className="text-slate-400 block">Total c/ Uber</span>
                                  <strong className="text-sm text-amber-300 mt-0.5 block">
                                    R$ {current.totalWithUber.toFixed(2)} (corrida: R${' '}
                                    {current.uberCost.toFixed(2)})
                                  </strong>
                                </div>
                              </div>
                            );
                          })()}

                          {/* SEQUÊNCIA DE PARADAS ANTI-PERECÍVEIS */}
                          {mapMode === 'SPLIT_STORES' &&
                            activeRecipe.routeAnalysis.splitStoreOrder.length > 0 && (
                              <div className="space-y-3">
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                                  Detalhe por Parada (Não Perecíveis 1º → Perecíveis/Congelados por Último)
                                </h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  {activeRecipe.routeAnalysis.splitStoreOrder.map((stop) => (
                                    <div
                                      key={`${stop.storeId}-${stop.stopOrder}`}
                                      className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 space-y-2"
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div>
                                          <p className="text-xs font-semibold text-amber-300">
                                            Parada {stop.stopOrder} · {stop.coldChainStageLabel}
                                          </p>
                                          <h5 className="text-sm font-bold text-white mt-0.5">
                                            {stop.storeName}
                                          </h5>
                                        </div>
                                        <span className="text-xs font-bold text-emerald-400 tabular-nums shrink-0">
                                          R$ {(stop.subtotalCashCost * portionMultiplier).toFixed(2)}
                                        </span>
                                      </div>
                                      <p className="text-[11px] text-slate-400 leading-relaxed">
                                        {stop.coldChainReason}
                                      </p>
                                      <ul className="space-y-1 pt-1 border-t border-slate-800/80 text-xs">
                                        {stop.items.map((it) => (
                                          <li
                                            key={it.productId}
                                            className="flex items-center justify-between gap-2 text-slate-200"
                                          >
                                            <span className="truncate">
                                              [{it.perishabilityRank}º] {it.productName}
                                            </span>
                                            <span className="tabular-nums text-slate-300 shrink-0">
                                              {Math.ceil(it.packagesNeeded * portionMultiplier)}x · R${' '}
                                              {(it.cashOutlayCost * portionMultiplier).toFixed(2)}
                                            </span>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                        </motion.section>
                      )}
                    </AnimatePresence>
                  </motion.div>
                </AnimatePresence>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
