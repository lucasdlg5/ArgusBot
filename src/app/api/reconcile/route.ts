import { NextResponse } from 'next/server';
import { ArgusReconciliationService } from '@/services/ArgusReconciliationService';

export async function POST() {
  try {
    const reconciler = new ArgusReconciliationService();
    const result = await reconciler.reconcileAndSyncSheets();
    return NextResponse.json({
      status: 'ok',
      ...result
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
