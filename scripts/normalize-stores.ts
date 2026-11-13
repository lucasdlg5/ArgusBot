import fs from 'node:fs/promises';
import path from 'node:path';
import { Client as PgClient } from 'pg';
import dotenv from 'dotenv';
import { ArgusStoreNormalizationService } from '../src/services/ArgusStoreNormalizationService';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const service = new ArgusStoreNormalizationService();
  const dbUrl = (process.env.DIRECT_URL || process.env.DATABASE_URL || '').replace(/^["']|["']$/g, '').trim();

  if (dbUrl && !dbUrl.includes('pending')) {
    const sqlPath = path.resolve(
      process.cwd(),
      'migrations',
      '006_normalize_ne_supermercado_stores.sql'
    );
    const sql = await fs.readFile(sqlPath, 'utf8');
    const client = new PgClient({
      connectionString: dbUrl,
      ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
    });

    await client.connect();
    try {
      const beforeStores = await client.query<{
        id: string;
        cnpj: string;
        raw_name: string;
        trading_name: string;
      }>(`SELECT id, cnpj, raw_name, trading_name FROM argus.stores ORDER BY trading_name`);
      console.log('[Argus Normalize] Lojas antes da normalização:', beforeStores.rows);

      await client.query(sql);

      const afterStores = await client.query<{
        id: string;
        cnpj: string;
        raw_name: string;
        trading_name: string;
      }>(`SELECT id, cnpj, raw_name, trading_name FROM argus.stores ORDER BY trading_name`);
      const aliases = await client.query<{
        alias_normalized: string;
        raw_alias: string;
        match_reason: string;
      }>(`SELECT alias_normalized, raw_alias, match_reason FROM argus.store_aliases ORDER BY alias_normalized`);

      console.log(
        `[Argus Normalize] ✅ Banco PostgreSQL normalizado! Total de lojas agora: ${afterStores.rows.length}`
      );
      console.log('[Argus Normalize] Lojas finais:', afterStores.rows);
      console.log('[Argus Normalize] Aliases registrados:', aliases.rows);
    } finally {
      await client.end().catch(() => {});
    }
  } else {
    console.log(
      '[Argus Normalize] DATABASE_URL não configurada neste ambiente. Aplicando normalização no snapshot local (`public/data/dashboard-snapshot.json`).'
    );
  }

  const snapshotPath = path.resolve(process.cwd(), 'public', 'data', 'dashboard-snapshot.json');
  const report = await service.normalizeSnapshotFile(snapshotPath);
  console.log('[Argus Normalize] ✅ Snapshot consolidado:', JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Argus Normalize] Falha:', err);
    process.exit(1);
  });
