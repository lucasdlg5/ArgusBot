import { queryArgus } from '../lib/db';
import { ArgusPluggyClient } from '../integrations/PluggyClient';
import { ArgusGoogleSheetsClient } from '../integrations/GoogleSheetsClient';
import type { OpenFinanceTransaction, ReconciliationSummary } from '../types/argus';

/**
 * Serviço de Conciliação Open Finance & Sincronização Google Sheets do Argus.
 * - Impede duplicidades via `access_key` e constraints únicas (`open_finance_tx_id`).
 * - Faz match automático de recibos com transações do Pluggy na janela `[-2h, +48h]` e diferença `<= R$ 0,05`.
 * - Lança pagamentos `VR_VA` na carteira de Benefícios.
 * - Sincroniza em lote as 4 abas da planilha "Argus - Controle de Mercado & Receitas".
 */
export class ArgusReconciliationService {
  private readonly pluggy = new ArgusPluggyClient();
  private readonly sheets = new ArgusGoogleSheetsClient();

  async reconcileAndSyncSheets(): Promise<{
    summary: ReconciliationSummary;
    openFinanceTransactions: OpenFinanceTransaction[];
  }> {
    const pluggyTxs = await this.pluggy.fetchRecentTransactions();

    const receipts = await queryArgus<{
      id: string;
      store_id: string;
      store_name: string;
      purchase_date: string;
      total_amount: string;
      payment_method: string;
      access_key: string;
      open_finance_tx_id: string | null;
      reconciled: boolean;
    }>(
      `SELECT
         r.id,
         r.store_id,
         s.trading_name AS store_name,
         r.purchase_date,
         r.total_amount,
         r.payment_method,
         r.access_key,
         r.open_finance_tx_id,
         r.reconciled
       FROM argus.receipts r
       JOIN argus.stores s ON s.id = r.store_id
       ORDER BY r.purchase_date DESC`
    );

    const usedTxIds = new Set<string>(
      receipts.map((r) => r.open_finance_tx_id).filter((id): id is string => Boolean(id))
    );

    const matches: ReconciliationSummary['matches'] = [];
    let newlyMatched = 0;

    for (const receipt of receipts) {
      const receiptTime = new Date(receipt.purchase_date).getTime();
      const receiptAmount = Number(receipt.total_amount);

      if (receipt.reconciled && receipt.open_finance_tx_id) {
        const matchedTx = pluggyTxs.find((t) => t.id === receipt.open_finance_tx_id);
        if (matchedTx) {
          matchedTx.reconciledReceiptId = receipt.id;
          const diffHours = (new Date(matchedTx.transactionDate).getTime() - receiptTime) / 3600000;
          matches.push({
            receiptId: receipt.id,
            storeName: receipt.store_name,
            receiptAmount,
            pluggyTxId: matchedTx.id,
            pluggyDescription: matchedTx.description,
            pluggyAmount: matchedTx.amount,
            timeDiffHours: Number(diffHours.toFixed(2))
          });
        }
        continue;
      }

      // Busca candidato na janela [-2h, +48h] e diferença <= R$ 0,05
      const candidate = pluggyTxs.find((tx) => {
        if (usedTxIds.has(tx.id)) return false;
        const txTime = new Date(tx.transactionDate).getTime();
        const diffHours = (txTime - receiptTime) / 3600000;
        const amountDiff = Math.abs(tx.amount - receiptAmount);
        return diffHours >= -2 && diffHours <= 48 && amountDiff <= 0.05;
      });

      if (candidate) {
        usedTxIds.add(candidate.id);
        candidate.reconciledReceiptId = receipt.id;

        await queryArgus(
          `UPDATE argus.receipts
           SET reconciled = TRUE, open_finance_tx_id = $1
           WHERE id = $2`,
          [candidate.id, receipt.id]
        );

        receipt.reconciled = true;
        receipt.open_finance_tx_id = candidate.id;
        newlyMatched++;

        const diffHours = (new Date(candidate.transactionDate).getTime() - receiptTime) / 3600000;
        matches.push({
          receiptId: receipt.id,
          storeName: receipt.store_name,
          receiptAmount,
          pluggyTxId: candidate.id,
          pluggyDescription: candidate.description,
          pluggyAmount: candidate.amount,
          timeDiffHours: Number(diffHours.toFixed(2))
        });
      } else if (receipt.payment_method === 'VR_VA' && !receipt.reconciled) {
        // Pagamentos VR_VA sem match bancário direto são lançados na carteira de Benefícios VR/VA
        const syntheticVrTxId = `vrva-wallet-${receipt.access_key.slice(-10)}`;
        if (!usedTxIds.has(syntheticVrTxId)) {
          usedTxIds.add(syntheticVrTxId);
          await queryArgus(
            `UPDATE argus.receipts
             SET reconciled = TRUE, open_finance_tx_id = $1
             WHERE id = $2`,
            [syntheticVrTxId, receipt.id]
          );
          receipt.reconciled = true;
          receipt.open_finance_tx_id = syntheticVrTxId;
          newlyMatched++;
        }
      }
    }

    const totalReconciled = receipts.filter((r) => r.reconciled).length;
    const vrVaSyncedCount = receipts.filter((r) => r.payment_method === 'VR_VA').length;
    const reconciliationRatePct =
      receipts.length > 0 ? Number(((totalReconciled / receipts.length) * 100).toFixed(1)) : 0;

    // Prepara linhas para as 4 abas da planilha Google "Argus - Controle de Mercado & Receitas"
    const nowIso = new Date().toISOString();

    const openFinanceRows = pluggyTxs.map((tx) => [
      tx.id,
      tx.transactionDate,
      tx.walletType === 'VR_VA' ? 'Carteira Benefícios (VR/VA)' : 'Conta Bancária / Cartão',
      tx.description,
      tx.amount,
      tx.category,
      tx.reconciledReceiptId ? 'SIM' : 'NÃO (Sem Cupom)',
      tx.reconciledReceiptId ?? '-',
      nowIso
    ]);

    const itemHistory = await queryArgus<{
      purchase_date: string;
      trading_name: string;
      raw_description: string;
      canonical_name: string;
      category: string;
      is_essential: boolean;
      quantity: string;
      unit_type: string;
      total_price: string;
      normalized_price_per_base_unit: string;
    }>(
      `SELECT
         r.purchase_date,
         s.trading_name,
         ri.raw_description,
         cp.name AS canonical_name,
         cp.category,
         cp.is_essential,
         ri.quantity,
         ri.unit_type,
         ri.total_price,
         ri.normalized_price_per_base_unit
       FROM argus.receipt_items ri
       JOIN argus.receipts r ON r.id = ri.receipt_id
       JOIN argus.stores s ON s.id = r.store_id
       JOIN argus.canonical_products cp ON cp.id = ri.canonical_product_id
       ORDER BY r.purchase_date DESC
       LIMIT 250`
    );

    const receiptItemsRows = itemHistory.map((row) => [
      new Date(row.purchase_date).toISOString(),
      row.trading_name,
      row.raw_description,
      row.canonical_name,
      row.category,
      row.is_essential ? 'ESSENCIAL' : 'IMPULSO/BESTEIRA',
      Number(row.quantity),
      row.unit_type,
      Number(row.total_price),
      Number(row.normalized_price_per_base_unit)
    ]);

    const currentPrices = await queryArgus<{
      product_name: string;
      category: string;
      store_name: string;
      estimated_package_price: string;
      min_historical_price: string;
      max_historical_price: string;
      days_since_last_seen: number;
    }>(`SELECT * FROM argus.v_current_product_prices ORDER BY product_name, estimated_package_price ASC`);

    const storeComparisonRows = currentPrices.map((cp) => [
      cp.product_name,
      cp.category,
      cp.store_name,
      Number(cp.estimated_package_price),
      Number(cp.min_historical_price),
      Number(cp.max_historical_price),
      Number(cp.days_since_last_seen),
      Number(cp.estimated_package_price) <= Number(cp.min_historical_price) * 1.03
        ? 'ESTOCAR (Mínima Histórica)'
        : 'Normal'
    ]);

    const collectedPriceItems = await queryArgus<{
      collected_at: string;
      source_type: string;
      store_name_detected: string;
      store_location_detected: string | null;
      raw_product_description: string;
      canonical_product_name: string;
      category: string;
      collected_price: string;
      promo_club_price: string | null;
      normalized_price_per_base_unit: string;
      base_unit: string;
      confidence_score_pct: string;
      confidence_explanation: string;
    }>(
      `SELECT
         collected_at::text,
         source_type,
         store_name_detected,
         store_location_detected,
         raw_product_description,
         canonical_product_name,
         category,
         collected_price::text,
         promo_club_price::text,
         normalized_price_per_base_unit::text,
         base_unit,
         confidence_score_pct::text,
         confidence_explanation
       FROM argus.collected_prices
       ORDER BY collected_at DESC
       LIMIT 300`
    );

    const collectedPricesRows = collectedPriceItems.map((c) => [
      new Date(c.collected_at).toISOString(),
      c.source_type,
      c.store_name_detected,
      c.store_location_detected || 'Local/Filial não identificado',
      c.raw_product_description,
      c.canonical_product_name,
      c.category,
      Number(c.collected_price),
      c.promo_club_price ? Number(c.promo_club_price) : '-',
      `${Number(c.normalized_price_per_base_unit).toFixed(4)}/${c.base_unit}`,
      `${Number(c.confidence_score_pct).toFixed(0)}%`,
      c.confidence_explanation
    ]);

    const sheetSyncRes = await this.sheets.syncAllTabsBatch({
      openFinanceRows,
      receiptItemsRows,
      storeComparisonRows,
      recipeCostsRows: [],
      collectedPricesRows
    });

    return {
      summary: {
        scannedReceipts: receipts.length,
        pluggyTransactions: pluggyTxs.length,
        newlyMatched,
        totalReconciled,
        reconciliationRatePct,
        vrVaSyncedCount,
        sheetsSyncedRows: sheetSyncRes.totalRowsSynced,
        matches
      },
      openFinanceTransactions: pluggyTxs
    };
  }
}
