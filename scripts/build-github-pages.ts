import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { env } from '../src/config/env';
import { ArgusDashboardBuilderService } from '../src/services/ArgusDashboardBuilderService';

async function ensurePublicStorageBucket() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      '⚠️ [Storage] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente nos secrets deste workflow.'
    );
    return;
  }
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const bucket = env.SUPABASE_STORAGE_BUCKET || 'FotosArgus';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY.trim();
  const isJwt = serviceKey.split('.').length === 3 && serviceKey.startsWith('eyJ');
  const authHeaders: Record<string, string> = isJwt
    ? { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
    : { apikey: serviceKey };

  try {
    const res = await fetch(`${baseUrl}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
      method: 'PUT',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ public: true, allowed_mime_types: null })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `⚠️ [Storage] Aviso ao configurar bucket '${bucket}' (HTTP ${res.status}): ${body.slice(0, 200)}`
      );
    }
  } catch (err) {
    console.warn('⚠️ [Storage] Erro de rede ao verificar bucket:', (err as Error).message);
  }
}

async function main() {
  const rootDir = process.cwd();
  const apiDir = path.join(rootDir, 'src', 'app', 'api');
  const stashApiDir = path.join(rootDir, '.stash-next-api');
  const snapshotPath = path.join(rootDir, 'public', 'data', 'dashboard-snapshot.json');

  console.log('🚀 [1/4] Preparando dados do Argus Vision BI para o GitHub Pages...');
  await ensurePublicStorageBucket();

  if (env.DATABASE_URL) {
    try {
      const builder = new ArgusDashboardBuilderService();
      const { localPath, supabasePublicUrl, storageErrorReason } =
        await builder.publishDashboardSnapshot();
      console.log(`✅ Snapshot gerado com dados reais do Supabase: ${localPath}`);
      if (supabasePublicUrl) {
        console.log(`☁️  Live Feed publicado no Supabase Storage: ${supabasePublicUrl}`);
      } else {
        console.warn(
          `⚠️ [Storage] Live Feed NÃO publicado no Supabase Storage: ${
            storageErrorReason || 'motivo não informado'
          }`
        );
      }
    } catch (err) {
      console.warn('⚠️ Aviso ao consultar banco durante o build; mantendo snapshot existente:', (err as Error).message);
    }
  } else {
    console.warn('⚠️ [Build] DATABASE_URL não definida; mantendo snapshot estático fallback.');
  }

  if (!existsSync(snapshotPath)) {
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(
      snapshotPath,
      JSON.stringify(
        {
          status: 'ok',
          generatedAt: new Date().toISOString(),
          homeLocation: { lat: env.HOME_LAT, lng: env.HOME_LNG, address: env.HOME_ADDRESS },
          kpis: {
            totalMonthSpent: 0,
            potentialMonthlySavings: 0,
            vrVaBurnAmount: 0,
            vrVaMonthlyBudget: 850,
            vrVaBurnRatePct: 0,
            reconciliationRatePct: 100,
            scannedReceiptsCount: 0,
            pluggyTransactionsCount: 0,
            collectedPricesCount: 0
          },
          currentPrices: [],
          heatmap: [],
          inflation: [],
          spendingBreakdown: [],
          priceEvolutionSeries: [],
          recipesEvaluations: [],
          logisticsVerdict: {
            singleStoreBest: {
              mode: 'SINGLE_STORE',
              title: 'Mercado Único Mais Barato',
              storesVisited: [],
              productsCost: 0,
              totalDistanceKm: 0,
              totalDurationMin: 0,
              gasCost: 0,
              uberCost: 0,
              totalWithGas: 0,
              totalWithUber: 0,
              routePolylines: []
            },
            splitStoreBest: {
              mode: 'SPLIT_STORES',
              title: 'Compra Dividida Otimizada',
              storesVisited: [],
              productsCost: 0,
              totalDistanceKm: 0,
              totalDurationMin: 0,
              gasCost: 0,
              uberCost: 0,
              totalWithGas: 0,
              totalWithUber: 0,
              routePolylines: []
            },
            grossProductSavings: 0,
            netSavingsWithGas: 0,
            netSavingsWithUber: 0,
            minSavingsHurdle: 25,
            recommendSplitWithGas: false,
            recommendSplitWithUber: false,
            argusVerdictText: 'Aguardando cupons reais no banco argus.'
          },
          reconciliation: {
            scannedReceipts: 0,
            pluggyTransactions: 0,
            autoReconciledCount: 0,
            vrVaSyncedCount: 0,
            totalReconciled: 0,
            reconciliationRatePct: 100,
            sheetsSyncedRows: 0
          },
          openFinanceTransactions: [],
          collectedPrices: [],
          queueSummary: [],
          scannedProducts: [],
          storesBi: []
        },
        null,
        2
      ),
      'utf8'
    );
  }

  console.log('📦 [2/4] Isolando rotas dinâmicas de servidor para compilação estática (output: export)...');
  const hadApiDir = existsSync(apiDir);
  if (hadApiDir) {
    if (existsSync(stashApiDir)) {
      await fs.rm(stashApiDir, { recursive: true, force: true });
    }
    await fs.rename(apiDir, stashApiDir);
  }

  try {
    console.log('🔨 [3/4] Executando next build em modo STATIC_EXPORT=true...');
    execSync('npx next build', {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        STATIC_EXPORT: 'true',
        NEXT_PUBLIC_BASE_PATH: process.env.NEXT_PUBLIC_BASE_PATH ?? '/ArgusBot',
        NEXT_PUBLIC_SUPABASE_URL: env.SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET: env.SUPABASE_STORAGE_BUCKET
      }
    });

    const outDir = path.join(rootDir, 'out');
    if (existsSync(outDir)) {
      await fs.writeFile(path.join(outDir, '.nojekyll'), '', 'utf8');
      console.log('✅ [4/4] Build estático concluído em ./out (com .nojekyll para GitHub Pages)!');
    }
  } finally {
    if (hadApiDir && existsSync(stashApiDir)) {
      await fs.rename(stashApiDir, apiDir);
      console.log('🔄 Diretório src/app/api restaurado com sucesso.');
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro no build para GitHub Pages:', err);
    process.exit(1);
  });
