import type {
  PerishabilityClassification,
  PerishabilityTier,
  ProductCategory
} from '../types/argus';

export function normalizePtText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifica cada ingrediente na cadeia fria:
 * Rank 1 = Não perecíveis / Despensa seca (comprar primeiro)
 * Rank 2 = Hortifruti & Ovos frescos (comprar no meio)
 * Rank 3 = Laticínios & Refrigerados (comprar perto do fim)
 * Rank 4 = Carnes, Congelados & Delicados (comprar por último para preservar frescor/cadeia fria)
 */
export function classifyIngredientPerishability(
  productName: string,
  category?: ProductCategory,
  aiTierHint?: PerishabilityTier
): PerishabilityClassification {
  const norm = normalizePtText(productName);

  const isFrozenOrDelicateKeyword =
    /\b(congelad|sorvete|picole|polpa|nuggets|hamburguer|lasanha congelada|peixe|salmao|tilapia|bacalhau|atum fresco|camarao|frutos do mar|frango|peito de frango|coxa|sobrecoxa|carne|patinho|acem|alcatra|picanha|contrafile|mignon|costela|bovino|suino|porco|lombo|pernil|linguica|salsicha|bacon|presunto|peito de peru|mortadela|salame|alface|rucula|agriao|espinafre|morango|framboesa|mirtilo|ricota|queijo fresco|minas frescal|cottage|chantilly|gelo|acai)\b/.test(
      norm
    );

  const isPlainSalt =
    /\bsal\b/.test(norm) &&
    !/\b(com sal|sem sal|manteiga|margarina|queijo|requeijao|carne|peixe|frango|bacon|presunto|bacalhau)\b/.test(
      norm
    );

  const isShelfStableOverride =
    (isPlainSalt ||
      /\b(conserva|enlatad|em lata|lata|vidro|em po|desidratad|seco|seca|leite condensado|extrato de tomate|molho de tomate|catchup|ketchup|mostarda|maionese|shoyu|azeite|oleo|vinagre|arroz|feijao|macarrao|espaguete|penne|farinha|fuba|polvilho|aveia|acucar|cafe|cacau|chocolate em po|achocolatado|amido|maisena|fermento|milho verde|ervilha|palmito|champignon|azeitona|oregano|pimenta|cominho|temper|caldo)\b/.test(
        norm
      )) &&
    !/\b(congelad|fresco|resfriad)\b/.test(norm);

  const isEgg = /\b(ovo|ovos)\b/.test(norm);

  let tier: PerishabilityTier;
  if (isEgg) {
    tier = 'SEMI_PERISHABLE';
  } else if (isShelfStableOverride) {
    tier = 'NON_PERISHABLE';
  } else if (
    isFrozenOrDelicateKeyword ||
    category === 'Carnes' ||
    aiTierHint === 'FROZEN_OR_DELICATE'
  ) {
    tier = 'FROZEN_OR_DELICATE';
  } else if (
    /\b(manteiga|margarina|queijo|mussarela|parmesao|prato|cheddar|requeijao|cream cheese|creme de leite|leite|iogurte|coalhada|nata|massa fresca)\b/.test(
      norm
    ) ||
    category === 'Laticínios' ||
    aiTierHint === 'REFRIGERATED'
  ) {
    tier = 'REFRIGERATED';
  } else if (
    /\b(batata|cebola|alho|tomate|cenoura|abobrinha|berinjela|pimentao|pepino|beterraba|mandioca|inhame|chuchu|brocolis|couve|repolho|banana|maca|laranja|limao|mamao|abacate|manga|melancia|melao|abacaxi|cheiro verde|salsinha|cebolinha|coentro)\b/.test(
      norm
    ) ||
    category === 'Hortifruti' ||
    aiTierHint === 'SEMI_PERISHABLE'
  ) {
    tier = 'SEMI_PERISHABLE';
  } else {
    tier = 'NON_PERISHABLE';
  }

  switch (tier) {
    case 'NON_PERISHABLE':
      return {
        tier,
        rank: 1,
        label: '1º Não Perecível (Despensa)',
        shoppingOrderHint: 'Comprar primeiro',
        reason:
          'Estável em temperatura ambiente; pode permanecer no carro/sacola durante todo o trajeto sem perder qualidade.'
      };
    case 'SEMI_PERISHABLE':
      return {
        tier,
        rank: 2,
        label: '2º Hortifruti & Ovos (Fresco)',
        shoppingOrderHint: 'Comprar no meio da rota',
        reason:
          'Sensível a calor prolongado e amassamento; ideal comprar após os itens secos da despensa.'
      };
    case 'REFRIGERATED':
      return {
        tier,
        rank: 3,
        label: '3º Refrigerado / Laticínio',
        shoppingOrderHint: 'Comprar perto do fim',
        reason:
          'Exige refrigeração constante; manter na etapa final da compra reduz aquecimento fora da geladeira.'
      };
    case 'FROZEN_OR_DELICATE':
      return {
        tier,
        rank: 4,
        label: '4º Carnes, Congelados & Delicados',
        shoppingOrderHint: 'Comprar por último',
        reason:
          'Cadeia fria crítica ou frescor delicado; deve ser a última parada antes de retornar para casa.'
      };
  }
}

export function getStageLabelForRank(rank: 1 | 2 | 3 | 4): string {
  switch (rank) {
    case 1:
      return 'Etapa 1 • Não Perecíveis / Despensa';
    case 2:
      return 'Etapa 2 • Hortifruti & Frescos';
    case 3:
      return 'Etapa 3 • Laticínios & Refrigerados';
    case 4:
      return 'Etapa Final • Carnes, Congelados & Delicados';
  }
}
