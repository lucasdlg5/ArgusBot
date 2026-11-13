import { NextResponse } from 'next/server';
import {
  ArgusCatalogBiService,
  type UpdateStoreInput
} from '@/services/ArgusCatalogBiService';

export async function GET() {
  try {
    const service = new ArgusCatalogBiService();
    const { storesBi } = await service.getCatalogAndStoreBi();
    return NextResponse.json({
      status: 'ok',
      generatedAt: new Date().toISOString(),
      storesBi
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as UpdateStoreInput;
    if (!body?.storeId || !body?.tradingName) {
      return NextResponse.json(
        { status: 'error', message: 'Campos obrigatórios ausentes (storeId, tradingName).' },
        { status: 400 }
      );
    }
    const service = new ArgusCatalogBiService();
    const result = await service.updateStoreDetails(body);
    return NextResponse.json({ status: 'ok', ...result });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
