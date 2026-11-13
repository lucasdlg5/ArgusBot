import fs from 'node:fs';
import path from 'node:path';
import { Client as PgClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[Argus Migrate] Nenhuma DATABASE_URL configurada. O repositório local em JSON será utilizado.');
    return;
  }

  const migrationFiles = [
    '001_init_argus_schema.sql',
    '002_add_security_audit_logs.sql',
    '004_add_price_scans_and_media_queue.sql',
    '005_add_recipe_perishability.sql',
    '006_normalize_ne_supermercado_stores.sql'
  ];

  const client = new PgClient({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.resolve(process.cwd(), 'migrations', file), 'utf8');
      await client.query(sql);
      console.log(`[Argus Migrate] Migration \`${file}\` aplicada com sucesso.`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[Argus Migrate] Falha:', err);
  process.exit(1);
});
