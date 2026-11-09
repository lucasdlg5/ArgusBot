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
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'migrations', '001_init_argus_schema.sql'), 'utf8');
  const client = new PgClient({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log('[Argus Migrate] Migration `001_init_argus_schema.sql` aplicada com sucesso no schema `argus`!');
}

main().catch((err) => {
  console.error('[Argus Migrate] Falha:', err);
  process.exit(1);
});
