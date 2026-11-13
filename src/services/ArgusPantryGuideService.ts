import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  buildDeterministicGuideReply,
  type PantryRecipeMatch
} from '../lib/pantry-matcher';
import type { RecipeCostEvaluation } from '../types/argus';
import { ArgusRecipeService } from './ArgusRecipeService';

export interface PantryChatResult {
  status: 'ok';
  sourceMode: 'LOCAL_ONLY';
  usedAi: boolean;
  replyText: string;
  matches: PantryRecipeMatch[];
}

export class ArgusPantryGuideService {
  private recipeService = new ArgusRecipeService();

  async answerPantryQuery(params: {
    message: string;
    recipes?: RecipeCostEvaluation[];
  }): Promise<PantryChatResult> {
    const cleanMsg = (params.message || '').trim();
    const localRecipes =
      params.recipes && params.recipes.length > 0
        ? params.recipes
        : await this.recipeService.evaluateRecipesWithRoutes();

    const deterministic = buildDeterministicGuideReply(cleanMsg, localRecipes);

    if (!env.GEMINI_API_KEY || localRecipes.length === 0) {
      return {
        status: 'ok',
        sourceMode: 'LOCAL_ONLY',
        usedAi: false,
        replyText: deterministic.replyText,
        matches: deterministic.matches
      };
    }

    try {
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
      const compactCatalog = localRecipes.slice(0, 25).map((r) => ({
        recipeId: r.recipeId,
        recipeName: r.recipeName,
        servings: r.servings,
        prepTimeMinutes: r.prepTimeMinutes,
        fullCost: r.lowestPossibleCashCost,
        ingredients: r.ingredientsBreakdown.map((i) => ({
          name: i.productName,
          qty: `${i.requiredBaseQty} ${i.baseUnit}`,
          cost: i.cashOutlayCost
        }))
      }));

      const matchSummary = deterministic.matches.map((m) => ({
        recipeName: m.recipe.recipeName,
        similarityPct: m.similarityPct,
        matched: m.matchedIngredients.map((i) => `${i.ingredientName} (${i.note})`),
        missing: m.missingIngredients.map((i) => `${i.productName} (~R$ ${i.cashOutlayCost.toFixed(2)})`),
        missingEstimatedCost: m.missingEstimatedCost
      }));

      const prompt = [
        'Você é o Guia Culinário da Geladeira do Argus.',
        'REGRAS ESTRITAS:',
        '1. Consulte APENAS as receitas cadastradas na BASE LOCAL abaixo. NUNCA invente receitas novas nem cite receitas da internet que não estejam na base local.',
        '2. Analise os ingredientes, quantidades (ex: 500g de frango, 1 pepino, restinho de molho madeira) e vontades que o usuário informou.',
        '3. Diga qual receita cadastrada tem maior semelhança, se as quantidades informadas são suficientes ou se falta completar algo, quais itens faltam comprar e o custo estimado apenas do que falta.',
        '4. Se nenhuma receita da base local combinar com os ingredientes, diga claramente que ainda não há receita compatível cadastrada na base local (sem sugerir receitas externas).',
        '5. Seja direto, amigável e conciso (máximo 2 parágrafos curtos, português do Brasil).',
        '',
        `MENSAGEM DO USUÁRIO: "${cleanMsg}"`,
        '',
        `PRÉ-ANÁLISE NUMÉRICA (BASE LOCAL): ${JSON.stringify(matchSummary)}`,
        '',
        `RECEITAS CADASTRADAS NA BASE LOCAL: ${JSON.stringify(compactCatalog)}`
      ].join('\n');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      const response = await ai.models.generateContent({
        model: env.GEMINI_MODEL || 'gemini-2.5-flash',
        contents: prompt,
        config: { abortSignal: controller.signal }
      });
      clearTimeout(timer);

      const aiText = (response.text || '').trim();
      if (aiText) {
        return {
          status: 'ok',
          sourceMode: 'LOCAL_ONLY',
          usedAi: true,
          replyText: aiText,
          matches: deterministic.matches
        };
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        '[ArgusPantryGuide] Fallback para motor determinístico local'
      );
    }

    return {
      status: 'ok',
      sourceMode: 'LOCAL_ONLY',
      usedAi: false,
      replyText: deterministic.replyText,
      matches: deterministic.matches
    };
  }
}
