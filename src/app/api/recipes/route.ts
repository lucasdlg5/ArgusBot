import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/config/env';
import { queryArgus } from '@/lib/db';
import {
  ArgusRecipeService,
  type ExtractedRecipeInput
} from '@/services/ArgusRecipeService';
import { RecipeFetchError, UnsafeUrlError } from '@/lib/url-security';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id') || undefined;
    const q = searchParams.get('q') || undefined;
    const portionsParam = searchParams.get('portions');
    const requestedPortions = portionsParam ? Math.max(1, Number(portionsParam)) : undefined;

    const recipeService = new ArgusRecipeService();
    const recipes = await recipeService.evaluateRecipesWithRoutes({
      recipeId: id,
      nameQuery: q,
      requestedPortions
    });

    return NextResponse.json({
      status: 'ok',
      homeLocation: {
        lat: env.HOME_LAT,
        lng: env.HOME_LNG,
        address: env.HOME_ADDRESS
      },
      recipes
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      rawText?: string;
      recipeUrl?: string;
      previewOnly?: boolean;
      imageBase64?: string;
      mimeType?: string;
      recipe?: ExtractedRecipeInput;
    };

    const recipeService = new ArgusRecipeService();
    let extracted: ExtractedRecipeInput;

    if (body.recipeUrl && body.recipeUrl.trim().length > 0) {
      extracted = await recipeService.extractRecipeFromUrl(body.recipeUrl);
    } else if (body.imageBase64 && body.imageBase64.trim().length > 0) {
      const cleanBase64 = body.imageBase64.replace(/^data:[^;]+;base64,/, '').trim();
      const buffer = Buffer.from(cleanBase64, 'base64');
      extracted = await recipeService.extractRecipeFromImage(
        buffer,
        body.mimeType || 'image/jpeg',
        body.rawText
      );
      if (extracted.isRecipe === false || extracted.ingredients.length === 0) {
        return NextResponse.json(
          {
            status: 'error',
            message:
              'A imagem enviada não parece conter uma receita com ingredientes legíveis.'
          },
          { status: 400 }
        );
      }
    } else if (body.rawText && body.rawText.trim().length > 0) {
      extracted = await recipeService.extractRecipeFromText(body.rawText);
    } else if (body.recipe && body.recipe.name && Array.isArray(body.recipe.ingredients)) {
      extracted = body.recipe;
    } else {
      return NextResponse.json(
        {
          status: 'error',
          message:
            'Envie o texto da receita (rawText), um link (recipeUrl), uma imagem (imageBase64) ou o objeto estruturado recipe.'
        },
        { status: 400 }
      );
    }

    if (body.previewOnly) {
      return NextResponse.json({ status: 'ok', preview: extracted }, { status: 200 });
    }

    const saved = await recipeService.saveRecipeToDatabase(extracted);
    return NextResponse.json({ status: 'ok', saved }, { status: 201 });
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ status: 'error', message: err.message }, { status: 400 });
    }
    if (err instanceof RecipeFetchError) {
      return NextResponse.json(
        { status: 'error', message: err.message },
        { status: err.statusCode || 422 }
      );
    }
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 400 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { status: 'error', message: 'Parâmetro id é obrigatório.' },
        { status: 400 }
      );
    }
    await queryArgus(`DELETE FROM argus.recipes WHERE id = $1`, [id]);
    return NextResponse.json({ status: 'ok', deletedId: id });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: (err as Error).message },
      { status: 500 }
    );
  }
}
