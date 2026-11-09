import path from 'node:path';
import dotenv from 'dotenv';
import { withArgusTransaction } from '../src/lib/db';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  console.log('======================================================================');
  console.log('🧹 ARGUS (moneta-argus) - Limpando Dados de Demonstração (Schema argus)');
  console.log('======================================================================');

  await withArgusTransaction(async (client) => {
    await client.query(`DELETE FROM argus.recipe_ingredients`);
    await client.query(`DELETE FROM argus.recipes`);
    await client.query(`DELETE FROM argus.receipt_items`);
    await client.query(`DELETE FROM argus.receipts`);
    await client.query(`DELETE FROM argus.product_aliases`);
    await client.query(`DELETE FROM argus.canonical_products`);
    await client.query(`DELETE FROM argus.stores`);
  });

  console.log(' ✅ Todos os dados de demonstração do schema `argus` foram removidos com segurança.');
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('[Argus Clear Demo] Erro:', err);
  process.exit(1);
});
