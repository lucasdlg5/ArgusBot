import { NextResponse } from 'next/server';
import {
  ArgusCatalogBiService,
  type UpdateProductInput
} from '@/services/ArgusCatalogBiService';

export async function GET() {
  try {
    const service = new ArgusCatalogBiService();
    const { scannedProducts, storesBi } = await service.getCatalogAndStoreBi();
    return NextResponse.json({
      status: 'ok',
      generatedAt: new Date().toISOString(),
      scannedProducts,
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
    const body = (await req.json()) as UpdateProductInput;
    if (!body?.id || !body?.canonicalProductName) {
      return NextResponse.json(
        { status: 'error', message: 'Campos obrigatórios ausentes (id, canonicalProductName).' },
        { status: 400 }
      );
    }
    const service = new ArgusCatalogBiService();
    const result = await service.updateScannedProduct(body);
    return NextResponse.json({ status: 'ok', ...result });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
