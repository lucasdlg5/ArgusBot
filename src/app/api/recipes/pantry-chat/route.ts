import { NextResponse } from 'next/server';
import { ArgusPantryGuideService } from '@/services/ArgusPantryGuideService';
import type { RecipeCostEvaluation } from '@/types/argus';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      message?: string;
      recipes?: RecipeCostEvaluation[];
    };
    if (!body?.message || !body.message.trim()) {
      return NextResponse.json(
        { status: 'error', message: 'Informe os ingredientes ou sua dúvida no chat.' },
        { status: 400 }
      );
    }
    const service = new ArgusPantryGuideService();
    const result = await service.answerPantryQuery({
      message: body.message,
      recipes: body.recipes
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
