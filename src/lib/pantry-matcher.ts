import type { RecipeCostEvaluation, RecipeIngredientBreakdownItem } from '../types/argus';

export interface ParsedPantryItem {
  rawPhrase: string;
  normalizedName: string;
  tokens: string[];
  quantity: number | null;
  unit: 'g' | 'ml' | 'un' | null;
  isLeftoverHint: boolean;
}

export type IngredientSufficiency = 'SUFFICIENT' | 'PARTIAL' | 'HAVE_UNMEASURED';

export interface MatchedIngredientDetail {
  ingredientName: string;
  pantryPhrase: string;
  recipeRequiredQty: number;
  recipeRequiredUnit: string;
  sufficiency: IngredientSufficiency;
  note: string;
}

export interface PantryRecipeMatch {
  recipe: RecipeCostEvaluation;
  similarityPct: number;
  matchedCount: number;
  totalIngredients: number;
  matchedIngredients: MatchedIngredientDetail[];
  missingIngredients: RecipeIngredientBreakdownItem[];
  missingEstimatedCost: number;
  fullRecipeCost: number;
  estimatedSavings: number;
}

const STOP_WORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'com',
  'sem',
  'para',
  'pra',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'um',
  'uma',
  'uns',
  'umas',
  'o',
  'a',
  'os',
  'as',
  'e',
  'ou',
  'que',
  'eu',
  'tenho',
  'tem',
  'aqui',
  'minha',
  'meu',
  'geladeira',
  'despensa',
  'freezer',
  'congelado',
  'congelada',
  'fresco',
  'fresca',
  'grande',
  'pequeno',
  'pequena',
  'medio',
  'media',
  'restinho',
  'resto',
  'sobra',
  'sobras',
  'pouco',
  'pouquinho',
  'pacote',
  'pacotes',
  'caixa',
  'caixas',
  'lata',
  'latas',
  'pote',
  'potes',
  'gostaria',
  'fazer',
  'receita',
  'receitas',
  'quais',
  'posso',
  'usar',
  'utilizar',
  'utilizasse',
  'usando',
  'junto',
  'porque',
  'estou',
  'vontade',
  'olha',
  'tipo',
  'mais',
  'menos',
  'uns'
]);

const SYNONYM_GROUPS: string[][] = [
  ['frango', 'peito', 'file', 'sobrecoxa', 'coxa', 'galinha'],
  ['queijo', 'mussarela', 'mucarela', 'prato', 'parmesao', 'cheddar', 'requeijao'],
  ['creme', 'nata'],
  ['molho', 'extrato', 'polpa'],
  ['batata', 'palha'],
  ['alho', 'dente'],
  ['cebola', 'cebolinha'],
  ['carne', 'bife', 'patinho', 'acem', 'alcatra', 'moida'],
  ['ovo', 'ovos'],
  ['leite', 'integral', 'desnatado'],
  ['manteiga', 'margarina'],
  ['pimenta', 'reino'],
  ['cogumelo', 'cogumelos', 'champignon']
];

export function normalizeTextForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function expandTokenSynonyms(token: string): string[] {
  const stemmed = stemToken(token);
  const out = new Set<string>([token, stemmed]);
  for (const group of SYNONYM_GROUPS) {
    if (group.includes(token) || group.includes(stemmed)) {
      for (const g of group) out.add(g);
    }
  }
  return Array.from(out);
}

function tokenizeMeaningful(text: string): string[] {
  const norm = normalizeTextForMatch(text);
  return norm
    .split(/\s+/)
    .map((t) => t.replace(/[.,]/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

export function parsePantryPrompt(prompt: string): ParsedPantryItem[] {
  const cleaned = prompt
    .replace(/\b(olha|oi|ola|ei|bom dia|boa tarde|boa noite)\b[,!.\s]*/gi, ' ')
    .replace(
      /\b(eu tenho|tenho|na minha geladeira|na geladeira|na despensa|quais receitas.*|que receitas.*|eu gostaria de fazer uma receita que utilizasse|gostaria de fazer.*|quero fazer.*|porque estou com vontade)\b/gi,
      ','
    )
    .replace(/\bjunto com\b|\be tambem\b|\balem de\b|\bmais\b/gi, ',');

  const rawSegments = cleaned
    .split(/[,;\n]+|\s+e\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);

  const items: ParsedPantryItem[] = [];
  for (const seg of rawSegments) {
    const normSeg = normalizeTextForMatch(seg);
    const isLeftoverHint = /\b(restinho|resto|sobra|pouco|pouquinho|meio|metade)\b/.test(normSeg);

    let quantity: number | null = null;
    let unit: 'g' | 'ml' | 'un' | null = null;

    const qtyMatch = normSeg.match(
      /(\d+(?:[.,]\d+)?)\s*(kg|kilo|kilos|g|gr|grama|gramas|ml|l|lt|litro|litros|un|unidade|unidades|pacote|pacotes|lata|latas|caixa|caixas)?\b/
    );
    if (qtyMatch) {
      const val = Number(qtyMatch[1].replace(',', '.'));
      const rawUnit = (qtyMatch[2] || '').toLowerCase();
      if (Number.isFinite(val) && val > 0) {
        if (rawUnit === 'kg' || rawUnit === 'kilo' || rawUnit === 'kilos') {
          quantity = val * 1000;
          unit = 'g';
        } else if (rawUnit === 'g' || rawUnit === 'gr' || rawUnit === 'grama' || rawUnit === 'gramas') {
          quantity = val;
          unit = 'g';
        } else if (rawUnit === 'l' || rawUnit === 'lt' || rawUnit === 'litro' || rawUnit === 'litros') {
          quantity = val * 1000;
          unit = 'ml';
        } else if (rawUnit === 'ml') {
          quantity = val;
          unit = 'ml';
        } else {
          quantity = val;
          unit = 'un';
        }
      }
    }

    const tokens = tokenizeMeaningful(seg);
    if (tokens.length === 0) continue;

    items.push({
      rawPhrase: seg,
      normalizedName: tokens.join(' '),
      tokens,
      quantity,
      unit,
      isLeftoverHint
    });
  }

  // Fallback se a frase não separou bem em vírgulas: extrai tokens globais
  if (items.length === 0) {
    const fallbackTokens = tokenizeMeaningful(prompt);
    for (const tok of fallbackTokens) {
      items.push({
        rawPhrase: tok,
        normalizedName: tok,
        tokens: [tok],
        quantity: null,
        unit: null,
        isLeftoverHint: false
      });
    }
  }

  return items;
}

function scoreIngredientMatch(
  pantryItem: ParsedPantryItem,
  ing: RecipeIngredientBreakdownItem
): number {
  const ingTokens = tokenizeMeaningful(ing.productName);
  if (ingTokens.length === 0) return 0;

  const ingExpanded = new Set<string>();
  for (const t of ingTokens) {
    for (const ex of expandTokenSynonyms(t)) {
      ingExpanded.add(ex);
    }
  }

  let hits = 0;
  for (const pt of pantryItem.tokens) {
    const pStem = stemToken(pt);
    if (ingExpanded.has(pt) || ingExpanded.has(pStem)) {
      hits += 1;
    } else if (
      ingTokens.some((it) => it.includes(pStem) || pStem.includes(stemToken(it)))
    ) {
      hits += 0.75;
    }
  }

  if (hits === 0) return 0;
  return hits / Math.max(1, Math.min(pantryItem.tokens.length, ingTokens.length));
}

function evaluateSufficiency(
  pantry: ParsedPantryItem,
  ing: RecipeIngredientBreakdownItem
): { sufficiency: IngredientSufficiency; note: string } {
  if (pantry.isLeftoverHint) {
    return {
      sufficiency: 'PARTIAL',
      note: 'você tem um restinho (pode precisar completar)'
    };
  }
  if (pantry.quantity !== null && pantry.unit && pantry.unit === ing.baseUnit) {
    if (pantry.quantity >= ing.requiredBaseQty) {
      return {
        sufficiency: 'SUFFICIENT',
        note: `suficiente (${pantry.quantity}${pantry.unit} ≥ ${ing.requiredBaseQty}${ing.baseUnit})`
      };
    }
    const diff = Number((ing.requiredBaseQty - pantry.quantity).toFixed(1));
    return {
      sufficiency: 'PARTIAL',
      note: `parcial (tem ${pantry.quantity}${pantry.unit}, falta ~${diff}${ing.baseUnit})`
    };
  }
  return {
    sufficiency: 'HAVE_UNMEASURED',
    note: 'disponível na sua lista'
  };
}

export function matchPantryAgainstRecipes(
  prompt: string,
  recipes: RecipeCostEvaluation[]
): {
  parsedItems: ParsedPantryItem[];
  matches: PantryRecipeMatch[];
} {
  const parsedItems = parsePantryPrompt(prompt);
  const matches: PantryRecipeMatch[] = [];

  for (const recipe of recipes) {
    const matchedIngredients: MatchedIngredientDetail[] = [];
    const missingIngredients: RecipeIngredientBreakdownItem[] = [];

    for (const ing of recipe.ingredientsBreakdown) {
      let bestPantry: ParsedPantryItem | null = null;
      let bestScore = 0;

      for (const p of parsedItems) {
        const sc = scoreIngredientMatch(p, ing);
        if (sc > bestScore) {
          bestScore = sc;
          bestPantry = p;
        }
      }

      if (bestPantry && bestScore >= 0.45) {
        const suf = evaluateSufficiency(bestPantry, ing);
        matchedIngredients.push({
          ingredientName: ing.productName,
          pantryPhrase: bestPantry.rawPhrase,
          recipeRequiredQty: ing.requiredBaseQty,
          recipeRequiredUnit: ing.baseUnit,
          sufficiency: suf.sufficiency,
          note: suf.note
        });
      } else {
        missingIngredients.push(ing);
      }
    }

    const totalIngredients = recipe.ingredientsBreakdown.length || 1;
    const matchedCount = matchedIngredients.length;
    const baseCoverage = (matchedCount / totalIngredients) * 100;

    // Bônus se o nome da receita ou tags baterem diretamente com a vontade do usuário
    const normPrompt = normalizeTextForMatch(prompt);
    const normTitle = normalizeTextForMatch(recipe.recipeName);
    const titleWords = normTitle.split(' ').filter((w) => w.length >= 4);
    const titleBonus = titleWords.some((w) => normPrompt.includes(w)) ? 12 : 0;

    const similarityPct = Math.min(100, Math.round(baseCoverage + (matchedCount > 0 ? titleBonus : 0)));
    const missingEstimatedCost = Number(
      missingIngredients.reduce((acc, ing) => acc + (ing.cashOutlayCost || 0), 0).toFixed(2)
    );
    const fullRecipeCost = Number((recipe.lowestPossibleCashCost || 0).toFixed(2));
    const estimatedSavings = Number(Math.max(0, fullRecipeCost - missingEstimatedCost).toFixed(2));

    matches.push({
      recipe,
      similarityPct,
      matchedCount,
      totalIngredients,
      matchedIngredients,
      missingIngredients,
      missingEstimatedCost,
      fullRecipeCost,
      estimatedSavings
    });
  }

  matches.sort((a, b) => {
    if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
    if (b.similarityPct !== a.similarityPct) return b.similarityPct - a.similarityPct;
    return a.missingEstimatedCost - b.missingEstimatedCost;
  });

  return { parsedItems, matches };
}

export function buildDeterministicGuideReply(
  prompt: string,
  recipes: RecipeCostEvaluation[]
): {
  replyText: string;
  matches: PantryRecipeMatch[];
} {
  if (recipes.length === 0) {
    return {
      replyText:
        'Ainda não há receitas cadastradas na base local. Adicione sua primeira receita aqui no painel ou enviando um link/foto para o @MonetaArgusBot!',
      matches: []
    };
  }

  const { parsedItems, matches } = matchPantryAgainstRecipes(prompt, recipes);
  const relevant = matches.filter((m) => m.matchedCount > 0).slice(0, 4);

  if (relevant.length === 0) {
    const names = parsedItems.map((p) => p.rawPhrase).join(', ');
    return {
      replyText: [
        `Analisei sua base local (${recipes.length} receita(s) cadastrada(s)) para: **${names || prompt}**.`,
        'Não encontrei nenhuma receita cadastrada que utilize esses ingredientes específicos no momento.',
        '_(Modo atual: consulta apenas suas receitas locais cadastradas, sem busca externa na internet.)_'
      ].join('\n\n'),
      matches: []
    };
  }

  const top = relevant[0];
  const lines: string[] = [
    `Consultei suas **${recipes.length} receita(s) cadastrada(s)** na base local.`,
    `A mais compatível agora é **${top.recipe.recipeName}** (${top.similarityPct}% de semelhança — você já tem **${top.matchedCount} de ${top.totalIngredients}** ingredientes).`
  ];

  if (top.missingIngredients.length === 0) {
    lines.push('🎉 Você já tem **todos** os ingredientes dessa receita na geladeira!');
  } else {
    const missingNames = top.missingIngredients
      .slice(0, 5)
      .map((i) => i.productName)
      .join(', ');
    lines.push(
      `Falta comprar apenas **${top.missingIngredients.length} item(ns)** (${missingNames}${
        top.missingIngredients.length > 5 ? '...' : ''
      }) — custo estimado só do que falta: **R$ ${top.missingEstimatedCost.toFixed(2)}** (economia de R$ ${top.estimatedSavings.toFixed(2)} usando o que você já tem).`
    );
  }

  return {
    replyText: lines.join('\n\n'),
    matches: relevant
  };
}
