import { NextResponse } from 'next/server';
import { ArgusCatalogBiService } from '@/services/ArgusCatalogBiService';

export async function GET() {
  try {
    const service = new ArgusCatalogBiService();
    const { receiptsDetailed, storesBi } = await service.getCatalogAndStoreBi();
    return NextResponse.json({
      status: 'ok',
      generatedAt: new Date().toISOString(),
      receiptsDetailed,
      storesBi
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
