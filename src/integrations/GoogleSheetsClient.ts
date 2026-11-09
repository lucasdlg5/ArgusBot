import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface ArgusLedgerSheetsPayload {
  openFinanceRows: (string | number)[][];
  receiptItemsRows: (string | number)[][];
  storeComparisonRows: (string | number)[][];
  recipeCostsRows: (string | number)[][];
}

/**
 * Adapter de sincronização em lote com o Google Sheets ("Argus - Controle de Mercado & Receitas").
 * Herdado de `MonetaSync/apps/backend/src/integrations/GoogleSheetsClient.ts`,
 * garantindo operação em lote (`batchUpdate`/`values.append`) sem tocar na planilha do MonetaSync.
 */
export class ArgusGoogleSheetsClient {
  private readonly localMirrorPath = path.resolve(process.cwd(), 'data', 'argus-ledger-mirror.json');

  private getSheetsApi() {
    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
      return null;
    }
    const auth = new google.auth.JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: env.GOOGLE_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return google.sheets({ version: 'v4', auth });
  }

  async syncAllTabsBatch(payload: ArgusLedgerSheetsPayload): Promise<{
    syncedOnline: boolean;
    totalRowsSynced: number;
    spreadsheetId: string;
    mirrorFile: string;
  }> {
    const totalRows =
      payload.openFinanceRows.length +
      payload.receiptItemsRows.length +
      payload.storeComparisonRows.length +
      payload.recipeCostsRows.length;

    // Salva espelho local auditável sempre
    try {
      fs.mkdirSync(path.dirname(this.localMirrorPath), { recursive: true });
      fs.writeFileSync(
        this.localMirrorPath,
        JSON.stringify(
          {
            title: 'Argus - Controle de Mercado & Receitas',
            updatedAt: new Date().toISOString(),
            tabs: {
              Transacoes_OpenFinance: payload.openFinanceRows,
              Historico_Itens: payload.receiptItemsRows,
              Comparativo_Mercados: payload.storeComparisonRows,
              Receitas_Custos: payload.recipeCostsRows
            }
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (err) {
      logger.warn({ err }, '[ArgusGoogleSheetsClient] Aviso ao gravar espelho local JSON');
    }

    const sheets = this.getSheetsApi();
    const sheetId = env.GOOGLE_SPREADSHEET_ID;

    if (!sheets || !sheetId || sheetId === 'argus-ledger-sheet-pending') {
      return {
        syncedOnline: false,
        totalRowsSynced: totalRows,
        spreadsheetId: sheetId || 'local-mirror-only',
        mirrorFile: this.localMirrorPath
      };
    }

    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            {
              range: 'Transacoes_OpenFinance!A2',
              values: payload.openFinanceRows
            },
            {
              range: 'Historico_Itens!A2',
              values: payload.receiptItemsRows
            },
            {
              range: 'Comparativo_Mercados!A2',
              values: payload.storeComparisonRows
            },
            {
              range: 'Receitas_Custos!A2',
              values: payload.recipeCostsRows
            }
          ]
        }
      });

      return {
        syncedOnline: true,
        totalRowsSynced: totalRows,
        spreadsheetId: sheetId,
        mirrorFile: this.localMirrorPath
      };
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        '[ArgusGoogleSheetsClient] Falha no Google Sheets remoto; mantido espelho local.'
      );
      return {
        syncedOnline: false,
        totalRowsSynced: totalRows,
        spreadsheetId: sheetId,
        mirrorFile: this.localMirrorPath
      };
    }
  }
}
