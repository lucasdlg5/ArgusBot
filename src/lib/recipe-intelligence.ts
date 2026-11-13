import type {
  BaseUnit,
  ProductCategory,
  RecipeCostEvaluation,
  RecipeDifficulty,
  SimilarRecipeSuggestion
} from '../types/argus';
import { normalizePtText } from './perishability';

export function splitInstructionSteps(instructions: string): string[] {
  const cleaned = (instructions || '').trim();
  if (!cleaned) {
    return ['Separe os ingredientes nas quantidades indicadas e prepare conforme o ponto desejado.'];
  }

  // Quebra por linhas ou padrões numerados ("1. ... 2. ... 3. ...")
  const numberedSplit = cleaned
    .replace(/\r/g, '\n')
    .replace(/\s+(?=\d+\.\s+)/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\d+[.)\-:\s]+/, '').trim())
    .filter((line) => line.length >= 4);

  if (numberedSplit.length >= 2) {
    return numberedSplit;
  }

  // Fallback por frases
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/^\d+[.)\-:\s]+/, '').trim())
    .filter((s) => s.length >= 4);

  return sentences.length > 0 ? sentences : [cleaned];
}

export function deriveRecipeMetadata(input: {
  name: string;
  servings: number;
  instructions: string;
  ingredients: Array<{
    name: string;
    category: ProductCategory;
    baseUnit: BaseUnit;
    requiredBaseQty: number;
  }>;
}): {
  prepTimeMinutes: number;
  difficulty: RecipeDifficulty;
  cuisineTags: string[];
  estimatedCaloriesPerPortion: number;
  instructionSteps: string[];
} {
  const norm = normalizePtText(`${input.name} ${input.instructions}`);
  const steps = splitInstructionSteps(input.instructions);
  const ingCount = input.ingredients.length;

  let prepTimeMinutes = 15 + steps.length * 5 + Math.min(15, ingCount * 2);
  if (/\b(forno|assar|assado|gratinar|escondidinho|lasanha|bolo)\b/.test(norm)) {
    prepTimeMinutes += 15;
  }
  if (/\b(rapido|simples|omelete|panqueca|salada|grelhado)\b/.test(norm)) {
    prepTimeMinutes = Math.max(12, prepTimeMinutes - 10);
  }
  prepTimeMinutes = Math.min(90, Math.max(10, Math.round(prepTimeMinutes / 5) * 5));

  let difficulty: RecipeDifficulty = 'Fácil';
  if (ingCount >= 8 || steps.length >= 6 || /\b(risoto|lasanha|gratinar|assado)\b/.test(norm)) {
    difficulty = 'Elaborada';
  } else if (ingCount >= 5 || steps.length >= 4) {
    difficulty = 'Média';
  }

  const tags = new Set<string>();
  if (prepTimeMinutes <= 25) tags.add('Rápida');
  if (input.servings >= 4) tags.add('Ideal p/ Marmita');
  if (input.ingredients.some((i) => i.category === 'Carnes')) tags.add('Rica em Proteína');
  if (/\b(forno|escondidinho|gratin|assa)\b/.test(norm)) tags.add('Forno');
  if (/\b(arroz|feijao|carreteiro|strogonoff|frango|carne)\b/.test(norm)) tags.add('Caseira BR');
  if (/\b(bolo|doce|torta|sobremesa|pudim|panqueca)\b/.test(norm)) tags.add('Café & Doce');
  if (tags.size === 0) tags.add('Dia a Dia');

  // Estimativa nutricional realista baseada nas categorias e quantidades da receita
  let totalKcal = 0;
  for (const ing of input.ingredients) {
    const ingNorm = normalizePtText(ing.name);
    if (ing.baseUnit === 'un') {
      totalKcal += ingNorm.includes('ovo') ? ing.requiredBaseQty * 75 : ing.requiredBaseQty * 60;
    } else if (ing.baseUnit === 'ml') {
      const kcalPerMl = /\b(azeite|oleo)\b/.test(ingNorm) ? 8.8 : 0.65;
      totalKcal += ing.requiredBaseQty * kcalPerMl;
    } else {
      let kcalPerGram = 1.4;
      if (/\b(manteiga|margarina|bacon)\b/.test(ingNorm)) kcalPerGram = 7.1;
      else if (/\b(arroz|macarrao|farinha|aveia|acucar|catchup)\b/.test(ingNorm)) kcalPerGram = 3.5;
      else if (/\b(creme de leite|queijo|mussarela|parmesao)\b/.test(ingNorm)) kcalPerGram = 2.6;
      else if (ing.category === 'Carnes') kcalPerGram = 1.65;
      else if (ing.category === 'Hortifruti') kcalPerGram = 0.55;
      totalKcal += ing.requiredBaseQty * kcalPerGram;
    }
  }

  const estimatedCaloriesPerPortion = Math.max(
    110,
    Math.round(totalKcal / Math.max(1, input.servings) / 5) * 5
  );

  return {
    prepTimeMinutes,
    difficulty,
    cuisineTags: Array.from(tags).slice(0, 3),
    estimatedCaloriesPerPortion,
    instructionSteps: steps
  };
}

/**
 * Calcula receitas similares ordenadas por interseção de ingredientes e aproveitamento de sobras da despensa.
 */
export function computeSimilarRecipes(
  target: RecipeCostEvaluation,
  allRecipes: RecipeCostEvaluation[],
  limit = 3
): SimilarRecipeSuggestion[] {
  const targetProdIds = new Set(target.ingredientsBreakdown.map((i) => i.productId));
  const targetSurplusByProd = new Map(
    target.ingredientsBreakdown.map((i) => [i.productId, i.surplusBaseQty])
  );

  const suggestions: SimilarRecipeSuggestion[] = [];

  for (const cand of allRecipes) {
    if (cand.recipeId === target.recipeId) continue;

    const sharedItems = cand.ingredientsBreakdown.filter((item) =>
      targetProdIds.has(item.productId)
    );
    const sharedCount = sharedItems.length;
    if (sharedCount === 0) continue;

    const unionSize = new Set([
      ...targetProdIds,
      ...cand.ingredientsBreakdown.map((i) => i.productId)
    ]).size;

    // Quanto da receita candidata aproveita itens (e sobras) já comprados na receita ativa
    const candRatio = sharedCount / Math.max(1, cand.ingredientsBreakdown.length);
    const jaccard = sharedCount / Math.max(1, unionSize);
    const similarityPct = Math.min(98, Math.round((0.65 * candRatio + 0.35 * jaccard) * 100));

    let additionalOutlayEstimate = 0;
    for (const item of cand.ingredientsBreakdown) {
      const surplusFromTarget = targetSurplusByProd.get(item.productId) ?? 0;
      if (surplusFromTarget >= item.requiredBaseQty * 0.6) {
        // Já coberto pela sobra da embalagem da receita atual
        continue;
      }
      additionalOutlayEstimate += item.cashOutlayCost;
    }

    suggestions.push({
      recipeId: cand.recipeId,
      recipeName: cand.recipeName,
      sharedIngredients: sharedItems.map((s) => s.productName.split('(')[0].trim()),
      sharedCount,
      similarityPct,
      lowestPossibleCashCost: cand.lowestPossibleCashCost,
      proportionalCostPerPortion: cand.proportionalCostPerPortion,
      servings: cand.servings,
      prepTimeMinutes: cand.prepTimeMinutes,
      difficulty: cand.difficulty,
      additionalOutlayEstimate: Number(additionalOutlayEstimate.toFixed(2))
    });
  }

  return suggestions
    .sort((a, b) => {
      if (b.sharedCount !== a.sharedCount) return b.sharedCount - a.sharedCount;
      return b.similarityPct - a.similarityPct;
    })
    .slice(0, limit);
}
