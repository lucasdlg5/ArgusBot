import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { queryArgus } from '../lib/db';
import {
  CANONICAL_STORE_NE,
  CANONICAL_STORE_SOUZA,
  classifyAndNormalizeStoreName,
  classifyStoreForCurrentSweep,
  normalizeStoreTextKey
} from '../lib/store-normalization';

export interface SqlQueryRunner {
  query: <R extends Record<string, any> = Record<string, any>>(
    text: string,
    values?: unknown[]
  ) => Promise<{ rows: R[] }>;
}

let initialNeHealPromise: Promise<void> | null = null;

function computeDeterministicSyntheticCnpj(canonicalStoreName: string): string {
  const cleanStore = (canonicalStoreName || 'MERCADO DESCONHECIDO')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const hashHex = crypto.createHash('sha256').update(cleanStore).digest('hex');
  const numericHash = hashHex
    .split('')
    .map((c) => String(parseInt(c, 16) % 10))
    .join('');
  return `99.${numericHash.slice(0, 3)}.${numericHash.slice(3, 6)}/0001-${numericHash.slice(6, 8)}`;
}

function isRealCnpj(cnpj?: string | null): boolean {
  const digits = (cnpj || '').replace(/\D/g, '');
  return (
    digits.length === 14 &&
    !digits.startsWith('99') &&
    !digits.startsWith('00') &&
    !/^(\d)\1+$/.test(digits)
  );
}

export class ArgusStoreNormalizationService {
  /**
   * Resolve ou cria a loja canônica em `argus.stores`, consultando primeiro
   * `argus.store_aliases` e as regras determinísticas (NE / CLUBE NE / NOVA ÉPOCA -> NE SUPERMERCADO).
   */
  async resolveOrUpsertCanonicalStore(
    client: SqlQueryRunner,
    params: {
      cnpj?: string;
      rawName: string;
      tradingName: string;
      address?: string;
      latitude?: number;
      longitude?: number;
    }
  ): Promise<{ storeId: string; canonicalTradingName: string; canonicalCnpj: string }> {
    const rawCandidate = (params.tradingName || params.rawName || '').trim();
    const classified = classifyAndNormalizeStoreName(rawCandidate);
    const canonicalName = classified.canonicalName;
    const rawKey = normalizeStoreTextKey(rawCandidate);
    const hasRealInputCnpj = isRealCnpj(params.cnpj);
    const fallbackCnpj = hasRealInputCnpj
      ? params.cnpj!.trim()
      : computeDeterministicSyntheticCnpj(canonicalName);

    const addr = params.address?.trim() || 'Localização pendente (Coleta de Gôndola/Flyer)';
    const lat = params.latitude ?? env.HOME_LAT - 0.01;
    const lng = params.longitude ?? env.HOME_LNG - 0.01;

    // 1. Consulta tabela de aliases se existir
    if (rawKey) {
      try {
        const aliasRes = await client.query<{
          store_id: string;
          trading_name: string;
          cnpj: string;
        }>(
          `SELECT s.id AS store_id, s.trading_name, s.cnpj
           FROM argus.store_aliases sa
           JOIN argus.stores s ON s.id = sa.canonical_store_id
           WHERE sa.alias_normalized = $1
           LIMIT 1`,
          [rawKey]
        );
        if (aliasRes.rows.length > 0) {
          const hit = aliasRes.rows[0];
          if (hasRealInputCnpj && !isRealCnpj(hit.cnpj)) {
            await client
              .query(
                `UPDATE argus.stores
                 SET cnpj = $1
                 WHERE id = $2
                   AND NOT EXISTS (SELECT 1 FROM argus.stores s2 WHERE s2.cnpj = $1 AND s2.id <> $2)`,
                [fallbackCnpj, hit.store_id]
              )
              .catch(() => {});
          }
          return {
            storeId: hit.store_id,
            canonicalTradingName: hit.trading_name,
            canonicalCnpj: hasRealInputCnpj ? fallbackCnpj : hit.cnpj
          };
        }
      } catch {
        // Tabela store_aliases pode não existir em ambiente mock ou antes da migration 006
      }
    }

    // 2. Se já existir loja pelo CNPJ real ou pelo trading_name canônico, reutiliza o mesmo registro!
    try {
      const existingRes = await client.query<{ id: string; trading_name: string; cnpj: string }>(
        `SELECT id, trading_name, cnpj
         FROM argus.stores
         WHERE ($1::boolean AND cnpj = $2)
            OR UPPER(trading_name) = UPPER($3)
         ORDER BY CASE WHEN $1::boolean AND cnpj = $2 THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`,
        [hasRealInputCnpj, fallbackCnpj, canonicalName]
      );

      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        if (rawKey && rawKey !== normalizeStoreTextKey(existing.trading_name)) {
          await client
            .query(
              `INSERT INTO argus.store_aliases (alias_normalized, raw_alias, canonical_store_id, match_reason)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (alias_normalized) DO UPDATE SET canonical_store_id = $3`,
              [rawKey, rawCandidate, existing.id, classified.matchedRule]
            )
            .catch(() => {});
        }
        return {
          storeId: existing.id,
          canonicalTradingName: existing.trading_name || canonicalName,
          canonicalCnpj: existing.cnpj || fallbackCnpj
        };
      }
    } catch {
      // Continua para upsert padrão em mock/fallback
    }

    // 3. Insere nova loja com o nome canônico normalizado
    const upserted = await client.query<{ id: string; trading_name?: string; cnpj?: string }>(
      `INSERT INTO argus.stores (cnpj, raw_name, trading_name, address, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cnpj) DO UPDATE SET
         trading_name = EXCLUDED.trading_name
       RETURNING id, trading_name, cnpj`,
      [fallbackCnpj, canonicalName, canonicalName, addr, lat, lng]
    );

    const storeId = upserted.rows[0].id;
    if (rawKey && rawKey !== normalizeStoreTextKey(canonicalName)) {
      await client
        .query(
          `INSERT INTO argus.store_aliases (alias_normalized, raw_alias, canonical_store_id, match_reason)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (alias_normalized) DO UPDATE SET canonical_store_id = $3`,
          [rawKey, rawCandidate, storeId, classified.matchedRule]
        )
        .catch(() => {});
    }

    return {
      storeId,
      canonicalTradingName: upserted.rows[0].trading_name || canonicalName,
      canonicalCnpj: upserted.rows[0].cnpj || fallbackCnpj
    };
  }

  /**
   * Executa a migration 006 de forma idempotente quando um banco PostgreSQL real
   * ainda possuir variantes não consolidadas (NE, CLUBE NE, NOVA ÉPOCA SUPERMERCADOS).
   */
  async ensureInitialNeMigrationApplied(): Promise<void> {
    const dbUrl = env.DIRECT_URL || env.DATABASE_URL;
    if (!dbUrl || dbUrl.includes('pending')) return;

    if (initialNeHealPromise) {
      return initialNeHealPromise;
    }

    initialNeHealPromise = (async () => {
      try {
        const check = await queryArgus<{
          has_alias_table: boolean;
          unmerged_ne_count: number;
          total_stores: number;
        }>(
          `SELECT
             (to_regclass('argus.store_aliases') IS NOT NULL) AS has_alias_table,
             (SELECT COUNT(*)::int FROM argus.stores
              WHERE UPPER(trading_name) IN ('NE', 'CLUBE NE', 'NOVA ÉPOCA SUPERMERCADOS', 'NOVA EPOCA SUPERMERCADOS')
             ) AS unmerged_ne_count,
             (SELECT COUNT(*)::int FROM argus.stores) AS total_stores`
        );

        const row = check[0];
        if (!row) return;

        // Aplica somente se a tabela de aliases ainda não existir OU se variantes explícitas de NE ainda estiverem soltas
        if (!row.has_alias_table || row.unmerged_ne_count > 0) {
          const migrationPath = path.resolve(
            process.cwd(),
            'migrations',
            '006_normalize_ne_supermercado_stores.sql'
          );
          const sql = await fs.readFile(migrationPath, 'utf8');
          await queryArgus(sql);
          logger.info(
            {
              hadAliasTable: row.has_alias_table,
              previousTotalStores: row.total_stores,
              unmergedNeCount: row.unmerged_ne_count
            },
            '[ArgusStoreNormalization] Normalização do banco para NE SUPERMERCADO + MERCADO SOUZA aplicada com sucesso'
          );
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          '[ArgusStoreNormalization] Aviso ao verificar/aplicar normalização automática de mercados'
        );
      }
    })();

    return initialNeHealPromise;
  }

  /**
   * Normaliza um payload ou arquivo `dashboard-snapshot.json` consolidando todas as variantes
   * não-Mercado Souza sob `NE SUPERMERCADO` e recalculando o Heatmap e o Veredito Logístico.
   */
  normalizeDashboardSnapshotPayload<T extends Record<string, any>>(snapshot: T): {
    normalized: T;
    report: {
      storesBefore: string[];
      storesAfter: string[];
      mergedNeVariants: Array<{ rawName: string; canonicalName: string; rule: string; itemsCount: number }>;
      currentPricesBefore: number;
      currentPricesAfter: number;
    };
  } {
    const rawPrices = Array.isArray(snapshot.currentPrices) ? snapshot.currentPrices : [];
    const storesBeforeSet = new Set<string>();
    const variantCounter = new Map<string, { canonicalName: string; rule: string; count: number }>();

    // Escolhe o store_id canônico do NE SUPERMERCADO dentre os existentes no snapshot
    // (preferência para o que tiver mais produtos: NOVA ÉPOCA SUPERMERCADOS)
    const countByStoreId = new Map<string, { name: string; count: number }>();
    let souzaStoreId: string | null = null;
    for (const p of rawPrices) {
      const sName = String(p.store_name || '').trim();
      const sId = String(p.store_id || '').trim();
      if (sName) storesBeforeSet.add(sName);
      const cls = classifyStoreForCurrentSweep(sName);
      if (cls.canonicalName === CANONICAL_STORE_SOUZA && !souzaStoreId) {
        souzaStoreId = sId;
      } else if (cls.canonicalName === CANONICAL_STORE_NE) {
        const cur = countByStoreId.get(sId) || { name: sName, count: 0 };
        cur.count += 1;
        countByStoreId.set(sId, cur);
      }
    }

    const bestNeEntry = Array.from(countByStoreId.entries()).sort((a, b) => b[1].count - a[1].count)[0];
    const canonicalNeStoreId = bestNeEntry?.[0] || 'ne-supermercado-canonical';
    const canonicalSouzaStoreId = souzaStoreId || 'mercado-souza-canonical';

    // Mescla currentPrices por (canonical_product_id, canonical_store_id)
    const mergedPriceMap = new Map<string, any>();

    for (const row of rawPrices) {
      const sName = String(row.store_name || '').trim();
      const cls = classifyStoreForCurrentSweep(sName);
      const targetName = cls.canonicalName;
      const targetStoreId =
        targetName === CANONICAL_STORE_SOUZA ? canonicalSouzaStoreId : canonicalNeStoreId;

      if (targetName === CANONICAL_STORE_NE && sName) {
        const prev = variantCounter.get(sName) || {
          canonicalName: targetName,
          rule: cls.matchedRule,
          count: 0
        };
        prev.count += 1;
        variantCounter.set(sName, prev);
      }

      const key = `${row.canonical_product_id}::${targetStoreId}`;
      const existing = mergedPriceMap.get(key);
      if (!existing) {
        mergedPriceMap.set(key, {
          ...row,
          store_id: targetStoreId,
          store_name: targetName
        });
      } else {
        const rowTime = new Date(row.last_seen_at || 0).getTime();
        const exTime = new Date(existing.last_seen_at || 0).getTime();
        const newer = rowTime >= exTime ? row : existing;
        const older = rowTime >= exTime ? existing : row;

        const obsNew = Number(newer.observations_count || 1);
        const obsOld = Number(older.observations_count || 1);
        const totalObs = obsNew + obsOld;

        // Ponderado mantendo maior peso para a leitura mais recente (70% mais recente + 30% histórico anterior)
        const estBase = Number(
          (
            0.7 * Number(newer.estimated_base_price) +
            0.3 * Number(older.estimated_base_price)
          ).toFixed(6)
        );
        const stdPkg = Number(newer.standard_package_size || older.standard_package_size || 1);
        const estPkg = Number((estBase * stdPkg).toFixed(2));

        mergedPriceMap.set(key, {
          ...newer,
          store_id: targetStoreId,
          store_name: targetName,
          estimated_base_price: estBase,
          estimated_package_price: estPkg,
          min_historical_price: Math.min(
            Number(existing.min_historical_price),
            Number(row.min_historical_price)
          ),
          max_historical_price: Math.max(
            Number(existing.max_historical_price),
            Number(row.max_historical_price)
          ),
          days_since_last_seen: Math.min(
            Number(existing.days_since_last_seen ?? 0),
            Number(row.days_since_last_seen ?? 0)
          ),
          last_seen_at: newer.last_seen_at,
          observations_count: totalObs
        });
      }
    }

    const mergedPrices = Array.from(mergedPriceMap.values()).sort((a, b) => {
      const cmp = String(a.product_name).localeCompare(String(b.product_name), 'pt-BR');
      if (cmp !== 0) return cmp;
      return Number(a.estimated_package_price) - Number(b.estimated_package_price);
    });

    // Recalcula exatamente a View 2 (v_store_category_heatmap) sobre os preços já consolidados em 2 lojas
    const avgPkgByProduct = new Map<string, number>();
    const prodGroup = new Map<string, number[]>();
    for (const p of mergedPrices) {
      const list = prodGroup.get(p.canonical_product_id) || [];
      list.push(Number(p.estimated_package_price));
      prodGroup.set(p.canonical_product_id, list);
    }
    for (const [pid, prices] of prodGroup.entries()) {
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      avgPkgByProduct.set(pid, avg);
    }

    const heatmapBuckets = new Map<
      string,
      {
        store_id: string;
        store_name: string;
        category: string;
        products: Set<string>;
        ratios: number[];
        basketCost: number;
        daysList: number[];
      }
    >();

    for (const p of mergedPrices) {
      const bKey = `${p.store_id}::${p.category}`;
      let bucket = heatmapBuckets.get(bKey);
      if (!bucket) {
        bucket = {
          store_id: p.store_id,
          store_name: p.store_name,
          category: p.category,
          products: new Set<string>(),
          ratios: [],
          basketCost: 0,
          daysList: []
        };
        heatmapBuckets.set(bKey, bucket);
      }
      bucket.products.add(p.canonical_product_id);
      const bench = avgPkgByProduct.get(p.canonical_product_id) || Number(p.estimated_package_price);
      const ratio = bench > 0 ? (Number(p.estimated_package_price) / bench) * 100 : 100;
      bucket.ratios.push(ratio);
      bucket.basketCost += Number(p.estimated_package_price);
      bucket.daysList.push(Number(p.days_since_last_seen ?? 0));
    }

    const mergedHeatmap = Array.from(heatmapBuckets.values())
      .map((b) => {
        const avgRatio = b.ratios.reduce((x, y) => x + y, 0) / b.ratios.length;
        const avgDays = b.daysList.reduce((x, y) => x + y, 0) / b.daysList.length;
        return {
          store_id: b.store_id,
          store_name: b.store_name,
          category: b.category,
          products_tracked: b.products.size,
          competitiveness_index: Number(avgRatio.toFixed(1)),
          basket_category_cost: Number(b.basketCost.toFixed(2)),
          min_days_since_seen: Math.min(...b.daysList),
          max_days_since_seen: Math.max(...b.daysList),
          freshness_tier:
            avgDays < 15 ? '< 15 dias' : avgDays <= 30 ? '15-30 dias' : '> 30 dias'
        };
      })
      .sort((a, b) => {
        const sCmp = a.store_name.localeCompare(b.store_name, 'pt-BR');
        if (sCmp !== 0) return sCmp;
        return a.category.localeCompare(b.category, 'pt-BR');
      });

    // Normaliza collectedPrices e logisticsVerdict no snapshot
    const normalizedCollected = Array.isArray(snapshot.collectedPrices)
      ? snapshot.collectedPrices.map((cp: any) => {
          const cls = classifyStoreForCurrentSweep(cp.store_name || cp.store_name_detected);
          return {
            ...cp,
            ...(cp.store_name !== undefined ? { store_name: cls.canonicalName } : {}),
            ...(cp.store_name_detected !== undefined
              ? { store_name_detected: cls.canonicalName }
              : {})
          };
        })
      : [];

    let updatedLogistics = snapshot.logisticsVerdict;
    if (updatedLogistics && typeof updatedLogistics === 'object') {
      const normalizeScenario = (sc: any) => {
        if (!sc || !Array.isArray(sc.storesVisited)) return sc;
        const groupedStores = new Map<string, any>();
        for (const st of sc.storesVisited) {
          const cls = classifyStoreForCurrentSweep(st.storeName);
          const canonId =
            cls.canonicalName === CANONICAL_STORE_SOUZA
              ? canonicalSouzaStoreId
              : canonicalNeStoreId;
          const prev = groupedStores.get(canonId);
          if (!prev) {
            groupedStores.set(canonId, {
              ...st,
              storeId: canonId,
              storeName: cls.canonicalName
            });
          } else {
            const itemsMerged = [...(prev.items || []), ...(st.items || [])];
            groupedStores.set(canonId, {
              ...prev,
              itemsCount: itemsMerged.length,
              subtotalProducts: Number(
                (Number(prev.subtotalProducts || 0) + Number(st.subtotalProducts || 0)).toFixed(2)
              ),
              items: itemsMerged
            });
          }
        }
        const storesList = Array.from(groupedStores.values());
        return {
          ...sc,
          title:
            storesList.length === 1
              ? `Mercado Único: ${storesList[0].storeName}`
              : `Compra Dividida (${storesList.map((s) => s.storeName).join(' + ')})`,
          storesVisited: storesList
        };
      };

      const singleStoreBest = normalizeScenario(updatedLogistics.singleStoreBest);
      const splitStoreBest = normalizeScenario(updatedLogistics.splitStoreBest);
      const bestSingleName =
        singleStoreBest?.storesVisited?.[0]?.storeName || CANONICAL_STORE_NE;

      updatedLogistics = {
        ...updatedLogistics,
        singleStoreBest,
        splitStoreBest,
        argusVerdictText:
          splitStoreBest?.storesVisited?.length <= 1
            ? `👁️ VEREDITO ARGUS: Compra consolidada no ${bestSingleName} (apenas 1 mercado necessário após normalização da base).`
            : String(updatedLogistics.argusVerdictText || '').replace(
                /\b(CLUBE NE|NOVA ÉPOCA SUPERMERCADOS|NE)\b/g,
                CANONICAL_STORE_NE
              )
      };
    }

    const storesAfterSet = Array.from(new Set(mergedPrices.map((p) => String(p.store_name)))).sort();

    return {
      normalized: {
        ...snapshot,
        generatedAt: new Date().toISOString(),
        currentPrices: mergedPrices,
        heatmap: mergedHeatmap,
        collectedPrices: normalizedCollected,
        logisticsVerdict: updatedLogistics
      },
      report: {
        storesBefore: Array.from(storesBeforeSet).sort(),
        storesAfter: storesAfterSet,
        mergedNeVariants: Array.from(variantCounter.entries()).map(([rawName, info]) => ({
          rawName,
          canonicalName: info.canonicalName,
          rule: info.rule,
          itemsCount: info.count
        })),
        currentPricesBefore: rawPrices.length,
        currentPricesAfter: mergedPrices.length
      }
    };
  }

  async normalizeSnapshotFile(
    filePath = path.resolve(process.cwd(), 'public', 'data', 'dashboard-snapshot.json')
  ) {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, any>;
    const { normalized, report } = this.normalizeDashboardSnapshotPayload(parsed);
    await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
    return report;
  }
}
