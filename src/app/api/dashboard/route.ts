import { NextResponse } from 'next/server';
import { ArgusDashboardBuilderService } from '@/services/ArgusDashboardBuilderService';

export async function GET() {
  try {
    const builder = new ArgusDashboardBuilderService();
    const payload = await builder.buildDashboardPayload();
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
