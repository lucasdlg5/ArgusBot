import { NextResponse } from 'next/server';
import { ArgusOptimizerService } from '@/services/ArgusOptimizerService';

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      recipeId?: string;
      requestedPortions?: number;
      customBasket?: Array<{ canonicalProductId: string; requiredBaseQty: number }>;
    };

    const optimizer = new ArgusOptimizerService();
    const [recipesEvaluations, logisticsVerdict] = await Promise.all([
      optimizer.evaluateRecipeCosts(body.recipeId, body.requestedPortions),
      optimizer.optimizeShoppingTrip(body.customBasket)
    ]);

    return NextResponse.json({
      status: 'ok',
      recipesEvaluations,
      logisticsVerdict
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
