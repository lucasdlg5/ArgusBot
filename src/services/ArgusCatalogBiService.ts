import { queryArgus } from '../lib/db';
import { extractBrandFromDescription } from '../lib/product-brand';
import { classifyAndNormalizeStoreName } from '../lib/store-normalization';
import type {
  BaseUnit,
  PaymentMethod,
  ScannedProductEntry,
  ScannedProductSourceKind,
  StoreBiCategoryPoint,
  StoreBiDetail,
  StoreBiMonthlyPoint,
  StoreBiProductStat,
  StoreBiReceiptSummary,
  StoreBiWeekdayPoint
} from '../types/argus';

const PT_BR_MONTH_SHORT = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez'
];

const PT_BR_WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  PIX: 'Pix',
  CREDIT_CARD: 'Cartão de Crédito',
  DEBIT: 'Cartão de Débito',
  VR_VA: 'Vale Refeição / Alimentação (VR/VA)',
  CASH: 'Dinheiro'
};

interface RawStoreRow {
  id: string;
  cnpj: string;
  raw_name: string;
  trading_name: string;
  address: string;
  google_maps_url?: string | null;
  latitude: string | number;
  longitude: string | number;
}

export interface UpdateProductInput {
  id: string;
  sourceKind: ScannedProductSourceKind;
  canonicalProductId?: string | null;
  canonicalProductName: string;
  rawDescription: string;
  category: string;
  baseUnit: BaseUnit;
  standardPackageSize: number;
  isEssential: boolean;
  quantity: number;
  unitType: string;
  unitPrice: number;
  totalPrice: number;
}

export interface UpdateStoreInput {
  storeId: string;
  tradingName: string;
  cnpj?: string;
  address: string;
  googleMapsUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export function computeNormalizedPricePerBaseUnit(params: {
  baseUnit: BaseUnit;
  standardPackageSize: number;
  quantity: number;
  unitType: string;
  totalPrice: number;
}): number {
  const u = (params.unitType || 'un').trim().toLowerCase();
  const qty = Math.max(0.0001, Number(params.quantity) || 1);
  const pkgSize = Math.max(1, Number(params.standardPackageSize) || 1);
  let totalBaseUnits = qty;

  if (params.baseUnit === 'g') {
    if (u === 'kg') {
      totalBaseUnits = qty * 1000;
    } else if (u === 'g' || u === 'gr' || u === 'grama' || u === 'gramas') {
      totalBaseUnits = qty;
    } else {
      totalBaseUnits = qty * pkgSize;
    }
  } else if (params.baseUnit === 'ml') {
    if (u === 'l' || u === 'lt' || u === 'litro' || u === 'litros') {
      totalBaseUnits = qty * 1000;
    } else if (u === 'ml') {
      totalBaseUnits = qty;
    } else {
      totalBaseUnits = qty * pkgSize;
    }
  }

  return totalBaseUnits > 0 ? Number((params.totalPrice / totalBaseUnits).toFixed(6)) : params.totalPrice;
}

export function extractCoordsFromGoogleMapsUrl(
  url?: string | null
): { lat: number; lng: number } | null {
  if (!url) return null;
  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) {
    return { lat: Number(atMatch[1]), lng: Number(atMatch[2]) };
  }
  const qMatch = url.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) {
    return { lat: Number(qMatch[1]), lng: Number(qMatch[2]) };
  }
  return null;
}

interface RawReceiptRow {
  id: string;
  store_id: string;
  store_name: string;
  store_address?: string;
  purchase_date: string;
  total_amount: string | number;
  discount_amount?: string | number;
  payment_method: PaymentMethod;
  reconciled: boolean;
}

interface RawReceiptItemRow {
  id: string;
  receipt_id: string;
  store_id: string | null;
  store_name: string;
  store_address: string | null;
  purchase_date: string;
  payment_method: PaymentMethod | null;
  raw_description: string;
  canonical_product_id: string;
  canonical_product_name: string;
  category: string;
  base_unit: BaseUnit;
  standard_package_size: string | number;
  is_essential: boolean;
  quantity: string | number;
  unit_type: string;
  unit_price: string | number;
  total_price: string | number;
  normalized_price_per_base_unit: string | number;
}

interface RawCollectedPriceRow {
  id: string;
  source_kind: string;
  store_id?: string | null;
  store_name: string;
  store_neighborhood: string | null;
  raw_product_description: string;
  canonical_product_id?: string | null;
  canonical_product_name?: string | null;
  category?: string | null;
  is_essential?: boolean | null;
  unit_type: string;
  base_unit?: BaseUnit | null;
  package_size_in_base_unit?: string | number | null;
  standard_package_size?: string | number | null;
  price: string | number;
  promo_or_club_price: string | number | null;
  normalized_price_per_base_unit?: string | number | null;
  confidence_score: string | number;
  missing_info_flags: string[] | null;
  collected_at: string;
}

interface RawHeatmapRow {
  store_id: string;
  store_name: string;
  category: string;
  competitiveness_index: string | number;
}

function monthKeyFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabelFromKey(key: string): string {
  const [yr, mo] = key.split('-');
  const idx = Number(mo) - 1;
  const label = PT_BR_MONTH_SHORT[idx] ?? mo;
  return `${label}/${yr.slice(2)}`;
}

export class ArgusCatalogBiService {
  async getCatalogAndStoreBi(referenceDate: Date = new Date()): Promise<{
    scannedProducts: ScannedProductEntry[];
    storesBi: StoreBiDetail[];
  }> {
    await queryArgus(
      `ALTER TABLE argus.stores ADD COLUMN IF NOT EXISTS google_maps_url TEXT`
    ).catch(() => {});

    const [storesRaw, receiptsRaw, receiptItemsRaw, collectedPricesRaw, heatmapRaw] =
      await Promise.all([
        queryArgus<RawStoreRow>(
          `SELECT id, cnpj, raw_name, trading_name, address, google_maps_url, latitude, longitude
           FROM argus.stores
           ORDER BY trading_name ASC`
        ),
        queryArgus<RawReceiptRow>(
          `SELECT
             r.id,
             r.store_id,
             s.trading_name AS store_name,
             s.address AS store_address,
             r.purchase_date::text AS purchase_date,
             r.total_amount::float8 AS total_amount,
             r.discount_amount::float8 AS discount_amount,
             r.payment_method,
             r.reconciled
           FROM argus.receipts r
           JOIN argus.stores s ON s.id = r.store_id
           ORDER BY r.purchase_date DESC`
        ),
        queryArgus<RawReceiptItemRow>(
          `SELECT
             ri.id,
             ri.receipt_id,
             r.store_id,
             s.trading_name AS store_name,
             s.address AS store_address,
             r.purchase_date::text AS purchase_date,
             r.payment_method,
             ri.raw_description,
             ri.canonical_product_id,
             cp.name AS canonical_product_name,
             cp.category,
             cp.base_unit,
             cp.standard_package_size::float8 AS standard_package_size,
             cp.is_essential,
             ri.quantity::float8 AS quantity,
             ri.unit_type,
             ri.unit_price::float8 AS unit_price,
             ri.total_price::float8 AS total_price,
             ri.normalized_price_per_base_unit::float8 AS normalized_price_per_base_unit
           FROM argus.receipt_items ri
           JOIN argus.receipts r ON r.id = ri.receipt_id
           JOIN argus.stores s ON s.id = r.store_id
           JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
           ORDER BY r.purchase_date DESC, ri.id DESC
           LIMIT 500`
        ),
        queryArgus<RawCollectedPriceRow>(
          `SELECT
             cp_obs.id,
             cp_obs.source_type AS source_kind,
             cp_obs.store_id,
             COALESCE(s.trading_name, cp_obs.store_name_detected, 'MERCADO') AS store_name,
             COALESCE(cp_obs.store_location_detected, s.address) AS store_neighborhood,
             cp_obs.raw_product_description,
             cp_obs.canonical_product_id,
             COALESCE(cp.name, cp_obs.canonical_product_name, cp_obs.raw_product_description) AS canonical_product_name,
             COALESCE(cp.category, cp_obs.category, 'Mercearia') AS category,
             COALESCE(cp.is_essential, TRUE) AS is_essential,
             cp_obs.unit_type,
             COALESCE(cp.base_unit, cp_obs.base_unit, 'un') AS base_unit,
             cp_obs.package_size_in_base_unit::float8 AS package_size_in_base_unit,
             COALESCE(cp.standard_package_size, cp_obs.package_size_in_base_unit, 1)::float8 AS standard_package_size,
             cp_obs.collected_price::float8 AS price,
             cp_obs.promo_club_price::float8 AS promo_or_club_price,
             cp_obs.normalized_price_per_base_unit::float8 AS normalized_price_per_base_unit,
             cp_obs.confidence_score_pct::float8 AS confidence_score,
             cp_obs.missing_info_flags,
             cp_obs.collected_at::text AS collected_at
           FROM argus.collected_prices cp_obs
           LEFT JOIN argus.stores s ON s.id = cp_obs.store_id
           LEFT JOIN argus.canonical_products cp ON cp.id = cp_obs.canonical_product_id
           ORDER BY cp_obs.collected_at DESC
           LIMIT 300`
        ).catch(() => []),
        queryArgus<RawHeatmapRow>(
          `SELECT store_id, store_name, category, competitiveness_index::float8 AS competitiveness_index
           FROM argus.v_store_category_heatmap`
        ).catch(() => [])
      ]);

    const storeById = new Map<string, RawStoreRow>();
    const storeByCanonicalName = new Map<string, RawStoreRow>();
    for (const s of storesRaw) {
      storeById.set(s.id, s);
      const normName = classifyAndNormalizeStoreName(s.trading_name || s.raw_name).canonicalName;
      if (!storeByCanonicalName.has(normName)) {
        storeByCanonicalName.set(normName, s);
      }
    }

    // 1. Monta lista unificada de produtos escaneados (Cupons NFC-e + Gôndola/Flyers/Vídeos)
    const scannedProducts: ScannedProductEntry[] = [];

    for (const item of receiptItemsRaw) {
      const stdPkg = Math.max(1, Number(item.standard_package_size) || 1);
      const normPerBase = Number(item.normalized_price_per_base_unit) || 0;
      const pkgPrice = Number((normPerBase * stdPkg).toFixed(2));
      const store = item.store_id ? storeById.get(item.store_id) : undefined;
      const canonicalStoreName =
        store?.trading_name || classifyAndNormalizeStoreName(item.store_name).canonicalName;
      const brandName = extractBrandFromDescription(
        item.raw_description,
        item.canonical_product_name
      );

      scannedProducts.push({
        id: item.id,
        observedAt: new Date(item.purchase_date).toISOString(),
        sourceKind: 'RECEIPT_ITEM',
        storeId: item.store_id,
        storeName: canonicalStoreName,
        storeLocation: item.store_address || store?.address || 'Local do cupom não informado',
        rawDescription: item.raw_description,
        brandName,
        canonicalProductId: item.canonical_product_id,
        canonicalProductName: item.canonical_product_name,
        category: item.category || 'Mercearia',
        baseUnit: (item.base_unit || 'un') as BaseUnit,
        standardPackageSize: stdPkg,
        isEssential: Boolean(item.is_essential),
        quantity: Number(item.quantity) || 1,
        unitType: item.unit_type || 'UN',
        unitPrice: Number(item.unit_price) || 0,
        totalPrice: Number(item.total_price) || 0,
        promoPrice: null,
        normalizedPricePerBaseUnit: normPerBase,
        normalizedPackagePrice: pkgPrice,
        confidenceScorePct: 100,
        paymentMethod: item.payment_method,
        missingInfoFlags: []
      });
    }

    for (const col of collectedPricesRaw) {
      const normalizedStore = classifyAndNormalizeStoreName(col.store_name).canonicalName;
      const matchedStore =
        (col.store_id ? storeById.get(col.store_id) : undefined) ||
        storeByCanonicalName.get(normalizedStore);
      const stdPkg = Math.max(1, Number(col.standard_package_size) || 1);
      const pkgQty = Math.max(1, Number(col.package_size_in_base_unit) || stdPkg);
      const rawPrice = Number(col.price) || 0;
      const normPerBase =
        Number(col.normalized_price_per_base_unit) || (pkgQty > 0 ? rawPrice / pkgQty : rawPrice);
      const pkgPrice = Number((normPerBase * stdPkg).toFixed(2));
      const canonicalName = col.canonical_product_name || col.raw_product_description;
      const brandName = extractBrandFromDescription(col.raw_product_description, canonicalName);
      const sourceKind = (['SHELF_PHOTO', 'MARKET_FLYER', 'AISLE_VIDEO'].includes(col.source_kind)
        ? col.source_kind
        : 'SHELF_PHOTO') as ScannedProductSourceKind;

      scannedProducts.push({
        id: col.id,
        observedAt: new Date(col.collected_at).toISOString(),
        sourceKind,
        storeId: matchedStore?.id ?? col.store_id ?? null,
        storeName: matchedStore?.trading_name ?? normalizedStore,
        storeLocation:
          col.store_neighborhood || matchedStore?.address || 'Localização não especificada',
        rawDescription: col.raw_product_description,
        brandName,
        canonicalProductId: col.canonical_product_id ?? null,
        canonicalProductName: canonicalName,
        category: col.category || 'Mercearia',
        baseUnit: (col.base_unit || 'un') as BaseUnit,
        standardPackageSize: stdPkg,
        isEssential: col.is_essential ?? true,
        quantity: pkgQty,
        unitType: col.unit_type || 'UN',
        unitPrice: rawPrice,
        totalPrice: rawPrice,
        promoPrice: col.promo_or_club_price !== null ? Number(col.promo_or_club_price) : null,
        normalizedPricePerBaseUnit: normPerBase,
        normalizedPackagePrice: pkgPrice,
        confidenceScorePct: Number(col.confidence_score) || 85,
        paymentMethod: null,
        missingInfoFlags: Array.isArray(col.missing_info_flags) ? col.missing_info_flags : []
      });
    }

    scannedProducts.sort(
      (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime()
    );

    // 2. Consolida B.I. detalhado por mercado
    const now = referenceDate;
    const currentMonthKey = monthKeyFromDate(now);
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthKey = monthKeyFromDate(prevMonthDate);
    const elapsedDaysInCurrentMonth = Math.max(1, now.getDate());

    const rolling6MonthKeys: string[] = [];
    for (let offset = -5; offset <= 0; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      rolling6MonthKeys.push(monthKeyFromDate(d));
    }

    const heatmapByStoreCat = new Map<string, number>();
    for (const hm of heatmapRaw) {
      heatmapByStoreCat.set(`${hm.store_id}::${hm.category}`, Number(hm.competitiveness_index));
    }

    const storesBi: StoreBiDetail[] = storesRaw.map((store) => {
      const storeReceipts = receiptsRaw.filter((r) => r.store_id === store.id);
      const storeItems = scannedProducts.filter(
        (p) => p.sourceKind === 'RECEIPT_ITEM' && p.storeId === store.id
      );
      const storeCollectedCount = scannedProducts.filter(
        (p) => p.sourceKind !== 'RECEIPT_ITEM' && p.storeId === store.id
      ).length;

      const receiptItemCounts = new Map<string, number>();
      for (const it of receiptItemsRaw) {
        if (it.store_id === store.id) {
          receiptItemCounts.set(it.receipt_id, (receiptItemCounts.get(it.receipt_id) ?? 0) + 1);
        }
      }

      const totalSpentAllTime = Number(
        storeReceipts.reduce((acc, r) => acc + Number(r.total_amount || 0), 0).toFixed(2)
      );
      const totalDiscountAllTime = Number(
        storeReceipts.reduce((acc, r) => acc + Number(r.discount_amount || 0), 0).toFixed(2)
      );
      const receiptsCount = storeReceipts.length;
      const avgTicket =
        receiptsCount > 0 ? Number((totalSpentAllTime / receiptsCount).toFixed(2)) : 0;

      // Mês atual vs mês anterior
      let currentMonthSpent = 0;
      let currentMonthReceiptsCount = 0;
      let previousMonthSpent = 0;

      const monthlyMap = new Map<string, { total: number; count: number }>();
      for (const mk of rolling6MonthKeys) {
        monthlyMap.set(mk, { total: 0, count: 0 });
      }

      const weekdayMap = new Map<number, { total: number; count: number }>();
      for (let wd = 0; wd < 7; wd++) {
        weekdayMap.set(wd, { total: 0, count: 0 });
      }

      const paymentMap = new Map<PaymentMethod, { total: number; count: number }>();
      const purchaseTimestamps: number[] = [];

      for (const r of storeReceipts) {
        const dt = new Date(r.purchase_date);
        const ts = dt.getTime();
        if (!Number.isNaN(ts)) {
          purchaseTimestamps.push(ts);
          const mk = monthKeyFromDate(dt);
          if (mk === currentMonthKey) {
            currentMonthSpent += Number(r.total_amount || 0);
            currentMonthReceiptsCount += 1;
          } else if (mk === prevMonthKey) {
            previousMonthSpent += Number(r.total_amount || 0);
          }

          if (monthlyMap.has(mk)) {
            const slot = monthlyMap.get(mk)!;
            slot.total += Number(r.total_amount || 0);
            slot.count += 1;
          }

          const wd = dt.getDay();
          const wSlot = weekdayMap.get(wd)!;
          wSlot.total += Number(r.total_amount || 0);
          wSlot.count += 1;
        }

        const pm = r.payment_method || 'PIX';
        const pSlot = paymentMap.get(pm) || { total: 0, count: 0 };
        pSlot.total += Number(r.total_amount || 0);
        pSlot.count += 1;
        paymentMap.set(pm, pSlot);
      }

      currentMonthSpent = Number(currentMonthSpent.toFixed(2));
      previousMonthSpent = Number(previousMonthSpent.toFixed(2));
      const momSpendDeltaPct =
        previousMonthSpent > 0
          ? Number((((currentMonthSpent - previousMonthSpent) / previousMonthSpent) * 100).toFixed(1))
          : null;

      purchaseTimestamps.sort((a, b) => a - b);
      const firstPurchaseMs = purchaseTimestamps.length > 0 ? purchaseTimestamps[0] : null;
      const lastPurchaseMs =
        purchaseTimestamps.length > 0 ? purchaseTimestamps[purchaseTimestamps.length - 1] : null;

      const activeSpanDays =
        firstPurchaseMs !== null
          ? Math.max(1, Math.floor((now.getTime() - firstPurchaseMs) / 86400000) + 1)
          : 0;

      const dailySpendRateHistorical =
        activeSpanDays > 0 ? Number((totalSpentAllTime / activeSpanDays).toFixed(2)) : 0;
      const dailySpendRateCurrentMonth = Number(
        (currentMonthSpent / elapsedDaysInCurrentMonth).toFixed(2)
      );

      const avgDaysBetweenVisits =
        receiptsCount >= 2 && firstPurchaseMs !== null && lastPurchaseMs !== null
          ? Number(
              Math.max(
                0.1,
                (lastPurchaseMs - firstPurchaseMs) / 86400000 / (receiptsCount - 1)
              ).toFixed(1)
            )
          : null;

      const visitsPerWeek =
        activeSpanDays > 0 ? Number(((receiptsCount / activeSpanDays) * 7).toFixed(2)) : 0;

      // Top produtos consumidos neste mercado
      const productAgg = new Map<
        string,
        {
          canonicalProductId: string;
          productName: string;
          category: string;
          baseUnit: BaseUnit;
          timesPurchased: number;
          totalQuantityInUnit: number;
          totalSpent: number;
          pkgPriceSum: number;
          lastPurchasedAt: string;
          brandCounts: Map<string, number>;
        }
      >();

      const categoryAgg = new Map<string, { totalSpent: number; itemsCount: number }>();

      for (const item of storeItems) {
        const key = item.canonicalProductId || item.canonicalProductName;
        const curr = productAgg.get(key) || {
          canonicalProductId: key,
          productName: item.canonicalProductName,
          category: item.category,
          baseUnit: item.baseUnit,
          timesPurchased: 0,
          totalQuantityInUnit: 0,
          totalSpent: 0,
          pkgPriceSum: 0,
          lastPurchasedAt: item.observedAt,
          brandCounts: new Map<string, number>()
        };
        curr.timesPurchased += 1;
        curr.totalQuantityInUnit += item.quantity;
        curr.totalSpent += item.totalPrice;
        curr.pkgPriceSum += item.normalizedPackagePrice;
        if (new Date(item.observedAt).getTime() > new Date(curr.lastPurchasedAt).getTime()) {
          curr.lastPurchasedAt = item.observedAt;
        }
        if (item.brandName && item.brandName !== 'Não especificada') {
          curr.brandCounts.set(item.brandName, (curr.brandCounts.get(item.brandName) ?? 0) + 1);
        }
        productAgg.set(key, curr);

        const cSlot = categoryAgg.get(item.category) || { totalSpent: 0, itemsCount: 0 };
        cSlot.totalSpent += item.totalPrice;
        cSlot.itemsCount += 1;
        categoryAgg.set(item.category, cSlot);
      }

      const topProducts: StoreBiProductStat[] = Array.from(productAgg.values())
        .map((p) => {
          let topBrand = 'Variada';
          let topBrandCount = 0;
          for (const [bName, cnt] of p.brandCounts.entries()) {
            if (cnt > topBrandCount) {
              topBrand = bName;
              topBrandCount = cnt;
            }
          }
          return {
            canonicalProductId: p.canonicalProductId,
            productName: p.productName,
            category: p.category,
            baseUnit: p.baseUnit,
            timesPurchased: p.timesPurchased,
            totalQuantityInUnit: Number(p.totalQuantityInUnit.toFixed(3)),
            totalSpent: Number(p.totalSpent.toFixed(2)),
            avgUnitPrice: Number((p.totalSpent / Math.max(1, p.timesPurchased)).toFixed(2)),
            avgNormalizedPackagePrice: Number(
              (p.pkgPriceSum / Math.max(1, p.timesPurchased)).toFixed(2)
            ),
            lastPurchasedAt: p.lastPurchasedAt,
            topBrand
          };
        })
        .sort((a, b) => {
          if (b.timesPurchased !== a.timesPurchased) return b.timesPurchased - a.timesPurchased;
          return b.totalSpent - a.totalSpent;
        });

      const mostConsumedProduct = topProducts[0] ?? null;
      const highestSpendProduct =
        [...topProducts].sort((a, b) => b.totalSpent - a.totalSpent)[0] ?? null;

      const monthlySeries: StoreBiMonthlyPoint[] = rolling6MonthKeys.map((mk) => {
        const slot = monthlyMap.get(mk)!;
        const tot = Number(slot.total.toFixed(2));
        return {
          monthKey: mk,
          monthLabel: monthLabelFromKey(mk),
          totalSpent: tot,
          receiptsCount: slot.count,
          avgTicket: slot.count > 0 ? Number((tot / slot.count).toFixed(2)) : 0
        };
      });

      const weekdaySeries: StoreBiWeekdayPoint[] = PT_BR_WEEKDAYS.map((label, idx) => {
        const slot = weekdayMap.get(idx)!;
        const tot = Number(slot.total.toFixed(2));
        return {
          weekdayIndex: idx,
          weekdayLabel: label,
          totalSpent: tot,
          receiptsCount: slot.count,
          avgSpentPerVisit: slot.count > 0 ? Number((tot / slot.count).toFixed(2)) : 0
        };
      });

      const totalItemsSpend = Array.from(categoryAgg.values()).reduce(
        (acc, c) => acc + c.totalSpent,
        0
      );
      const categoryBreakdown: StoreBiCategoryPoint[] = Array.from(categoryAgg.entries())
        .map(([cat, val]) => ({
          category: cat,
          totalSpent: Number(val.totalSpent.toFixed(2)),
          sharePct:
            totalItemsSpend > 0
              ? Number(((val.totalSpent / totalItemsSpend) * 100).toFixed(1))
              : 0,
          itemsCount: val.itemsCount,
          competitivenessIndex: heatmapByStoreCat.get(`${store.id}::${cat}`) ?? null
        }))
        .sort((a, b) => b.totalSpent - a.totalSpent);

      const paymentBreakdown = Array.from(paymentMap.entries())
        .map(([method, val]) => ({
          method: PAYMENT_LABELS[method] || method,
          totalSpent: Number(val.total.toFixed(2)),
          receiptsCount: val.count,
          sharePct:
            totalSpentAllTime > 0
              ? Number(((val.total / totalSpentAllTime) * 100).toFixed(1))
              : 0
        }))
        .sort((a, b) => b.totalSpent - a.totalSpent);

      const recentReceipts: StoreBiReceiptSummary[] = storeReceipts.map((r) => ({
        receiptId: r.id,
        purchaseDate: new Date(r.purchase_date).toISOString(),
        totalAmount: Number(r.total_amount || 0),
        discountAmount: Number(r.discount_amount || 0),
        paymentMethod: r.payment_method,
        reconciled: Boolean(r.reconciled),
        itemsCount: receiptItemCounts.get(r.id) ?? 0
      }));

      const validIndexes = categoryBreakdown
        .map((c) => c.competitivenessIndex)
        .filter((v): v is number => v !== null && Number.isFinite(v));
      const overallCompetitivenessIndex =
        validIndexes.length > 0
          ? Number((validIndexes.reduce((a, b) => a + b, 0) / validIndexes.length).toFixed(1))
          : null;

      return {
        storeId: store.id,
        tradingName: store.trading_name,
        rawName: store.raw_name,
        cnpj: store.cnpj,
        address: store.address,
        googleMapsUrl: store.google_maps_url ?? null,
        latitude: Number(store.latitude) || 0,
        longitude: Number(store.longitude) || 0,
        totalSpentAllTime,
        totalDiscountAllTime,
        receiptsCount,
        itemsPurchasedCount: storeItems.length,
        collectedPricesCount: storeCollectedCount,
        avgTicket,
        currentMonthLabel: monthLabelFromKey(currentMonthKey),
        currentMonthSpent,
        currentMonthReceiptsCount,
        previousMonthSpent,
        momSpendDeltaPct,
        dailySpendRateHistorical,
        dailySpendRateCurrentMonth,
        activeSpanDays,
        avgDaysBetweenVisits,
        visitsPerWeek,
        firstPurchaseAt: firstPurchaseMs !== null ? new Date(firstPurchaseMs).toISOString() : null,
        lastPurchaseAt: lastPurchaseMs !== null ? new Date(lastPurchaseMs).toISOString() : null,
        mostConsumedProduct,
        highestSpendProduct,
        topProducts: topProducts.slice(0, 15),
        monthlySeries,
        weekdaySeries,
        categoryBreakdown,
        paymentBreakdown,
        recentReceipts,
        overallCompetitivenessIndex
      };
    });

    storesBi.sort((a, b) => {
      if (b.totalSpentAllTime !== a.totalSpentAllTime) {
        return b.totalSpentAllTime - a.totalSpentAllTime;
      }
      return b.collectedPricesCount - a.collectedPricesCount;
    });

    return {
      scannedProducts,
      storesBi
    };
  }

  async updateScannedProduct(input: UpdateProductInput): Promise<{
    updated: boolean;
    normalizedPricePerBaseUnit: number;
  }> {
    const cleanName = input.canonicalProductName.trim();
    const cleanRawDesc = input.rawDescription.trim() || cleanName;
    const cleanCategory = input.category.trim() || 'Mercearia';
    const cleanBaseUnit: BaseUnit =
      input.baseUnit === 'g' || input.baseUnit === 'ml' ? input.baseUnit : 'un';
    const stdPkgSize = Math.max(1, Number(input.standardPackageSize) || 1);
    const qty = Math.max(0.0001, Number(input.quantity) || 1);
    const unitType = (input.unitType || 'UN').trim().toUpperCase();
    const totalPrice = Math.max(0, Number(input.totalPrice) || 0);
    const unitPrice =
      Number(input.unitPrice) > 0
        ? Number(input.unitPrice)
        : Number((totalPrice / qty).toFixed(4));

    const normalizedPricePerBaseUnit = computeNormalizedPricePerBaseUnit({
      baseUnit: cleanBaseUnit,
      standardPackageSize: stdPkgSize,
      quantity: qty,
      unitType,
      totalPrice
    });

    if (input.canonicalProductId) {
      await queryArgus(
        `UPDATE argus.canonical_products
         SET name = $2,
             category = $3,
             base_unit = $4,
             standard_package_size = $5,
             is_essential = $6
         WHERE id = $1`,
        [
          input.canonicalProductId,
          cleanName,
          cleanCategory,
          cleanBaseUnit,
          stdPkgSize,
          Boolean(input.isEssential)
        ]
      );
    }

    if (input.sourceKind === 'RECEIPT_ITEM') {
      await queryArgus(
        `UPDATE argus.receipt_items
         SET raw_description = $2,
             quantity = $3,
             unit_type = $4,
             unit_price = $5,
             total_price = $6,
             normalized_price_per_base_unit = $7
         WHERE id = $1`,
        [
          input.id,
          cleanRawDesc,
          qty,
          unitType,
          unitPrice,
          totalPrice,
          normalizedPricePerBaseUnit
        ]
      );
    } else {
      await queryArgus(
        `UPDATE argus.collected_prices
         SET raw_product_description = $2,
             canonical_product_name = $3,
             category = $4,
             base_unit = $5,
             unit_type = $6,
             package_size_in_base_unit = $7,
             collected_price = $8,
             normalized_price_per_base_unit = $9
         WHERE id = $1`,
        [
          input.id,
          cleanRawDesc,
          cleanName,
          cleanCategory,
          cleanBaseUnit,
          unitType,
          stdPkgSize,
          totalPrice,
          normalizedPricePerBaseUnit
        ]
      );
    }

    return { updated: true, normalizedPricePerBaseUnit };
  }

  async updateStoreDetails(input: UpdateStoreInput): Promise<{ updated: boolean }> {
    await queryArgus(
      `ALTER TABLE argus.stores ADD COLUMN IF NOT EXISTS google_maps_url TEXT`
    ).catch(() => {});

    const cleanTrading = input.tradingName.trim();
    const cleanAddress = input.address.trim();
    const cleanCnpj = (input.cnpj || '').trim();
    const cleanMapsUrl = input.googleMapsUrl ? input.googleMapsUrl.trim() : null;

    let lat =
      input.latitude !== null && input.latitude !== undefined && Number.isFinite(Number(input.latitude))
        ? Number(input.latitude)
        : null;
    let lng =
      input.longitude !== null && input.longitude !== undefined && Number.isFinite(Number(input.longitude))
        ? Number(input.longitude)
        : null;

    if ((lat === null || lng === null || (lat === 0 && lng === 0)) && cleanMapsUrl) {
      const extracted = extractCoordsFromGoogleMapsUrl(cleanMapsUrl);
      if (extracted) {
        lat = extracted.lat;
        lng = extracted.lng;
      }
    }

    await queryArgus(
      `UPDATE argus.stores
       SET trading_name = $2,
           address = $3,
           cnpj = CASE WHEN $4 <> '' THEN $4 ELSE cnpj END,
           google_maps_url = $5,
           latitude = COALESCE($6, latitude),
           longitude = COALESCE($7, longitude)
       WHERE id = $1`,
      [input.storeId, cleanTrading, cleanAddress, cleanCnpj, cleanMapsUrl, lat, lng]
    );

    return { updated: true };
  }
}
