export const CANONICAL_STORE_NE = 'NE SUPERMERCADO';
export const CANONICAL_STORE_SOUZA = 'MERCADO SOUZA';

export type StoreMatchRule =
  | 'MERCADO_SOUZA'
  | 'SIGLA_NE'
  | 'CLUBE_FIDELIDADE_NE'
  | 'RAZAO_SOCIAL_NOVA_EPOCA'
  | 'REGISTRO_NAO_SOUZA_ATUAL'
  | 'PLACEHOLDER'
  | 'GENERIC';

export interface StoreNormalizationResult {
  rawName: string;
  normalizedKey: string;
  canonicalName: string;
  matchedRule: StoreMatchRule;
  isGenericPlaceholder: boolean;
}

const GENERIC_PLACEHOLDER_PATTERNS = [
  /^$/,
  /^LOJA NAO IDENTIFICADA$/,
  /^MERCADO IDENTIFICADO$/,
  /^PENDENTE( NA FILA)?$/,
  /^CUPOM FISCAL( EM FILA)?$/,
  /^DESCONHECID[OA]$/,
  /^NAO IDENTIFICAD[OA]$/,
  /^NULL$/,
  /^UNDEFINED$/,
  /^N\/?A$/,
  /^NONE$/
];

/**
 * Normaliza texto para comparação de nomes de supermercados (sem acentos, maiúsculo, espaços simples).
 */
export function normalizeStoreTextKey(rawName: string | null | undefined): string {
  return (rawName ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function isGenericStorePlaceholder(rawName: string | null | undefined): boolean {
  const key = normalizeStoreTextKey(rawName);
  return GENERIC_PLACEHOLDER_PATTERNS.some((rx) => rx.test(key));
}

export function isMercadoSouzaVariant(rawName: string | null | undefined): boolean {
  const key = normalizeStoreTextKey(rawName);
  if (!key) return false;
  return /\bSOUZA\b/.test(key);
}

export function detectNeSupermercadoRule(
  rawName: string | null | undefined
): Exclude<StoreMatchRule, 'MERCADO_SOUZA' | 'REGISTRO_NAO_SOUZA_ATUAL' | 'PLACEHOLDER' | 'GENERIC'> | null {
  const key = normalizeStoreTextKey(rawName);
  if (!key) return null;

  if (/\bCLUBE\s+(N\s*E|NOVA\s+EPOCA)\b/.test(key) || /\b(N\s*E|NOVA\s+EPOCA)\s+CLUBE\b/.test(key)) {
    return 'CLUBE_FIDELIDADE_NE';
  }

  if (/\bNOVA\s+EPOCA\b/.test(key)) {
    return 'RAZAO_SOCIAL_NOVA_EPOCA';
  }

  if (
    key === 'NE' ||
    key === 'N E' ||
    /\bN\s*E\s+SUPERMERCAD/.test(key) ||
    /\bSUPERMERCAD[OA]S?\s+N\s*E\b/.test(key) ||
    /\bMERCAD[OA]\s+N\s*E\b/.test(key) ||
    /\bOFERTAS\s+N\s*E\b/.test(key) ||
    /\bREDE\s+N\s*E\b/.test(key) ||
    /\bNE\s+ATACAD/.test(key)
  ) {
    return 'SIGLA_NE';
  }

  return null;
}

/**
 * Classifica e normaliza nomes de estabelecimentos capturados por OCR de cupons,
 * fotos de gôndola, flyers/panfletos ou comandos manuais.
 */
export function classifyAndNormalizeStoreName(
  rawName: string | null | undefined
): StoreNormalizationResult {
  const cleanRaw = (rawName ?? '').trim();
  const normalizedKey = normalizeStoreTextKey(cleanRaw);

  if (isGenericStorePlaceholder(cleanRaw)) {
    return {
      rawName: cleanRaw || 'Loja Não Identificada',
      normalizedKey: normalizedKey || 'LOJA NAO IDENTIFICADA',
      canonicalName: cleanRaw || 'Loja Não Identificada',
      matchedRule: 'PLACEHOLDER',
      isGenericPlaceholder: true
    };
  }

  if (isMercadoSouzaVariant(cleanRaw)) {
    return {
      rawName: cleanRaw,
      normalizedKey,
      canonicalName: CANONICAL_STORE_SOUZA,
      matchedRule: 'MERCADO_SOUZA',
      isGenericPlaceholder: false
    };
  }

  const neRule = detectNeSupermercadoRule(cleanRaw);
  if (neRule) {
    return {
      rawName: cleanRaw,
      normalizedKey,
      canonicalName: CANONICAL_STORE_NE,
      matchedRule: neRule,
      isGenericPlaceholder: false
    };
  }

  return {
    rawName: cleanRaw,
    normalizedKey,
    canonicalName: cleanRaw.replace(/\s+/g, ' ').trim(),
    matchedRule: 'GENERIC',
    isGenericPlaceholder: false
  };
}

/**
 * Regra de saneamento da base atual: todo registro identificado que não for
 * Mercado Souza é analisado e consolidado sob NE SUPERMERCADO como nome principal.
 */
export function classifyStoreForCurrentSweep(
  rawName: string | null | undefined
): StoreNormalizationResult {
  const base = classifyAndNormalizeStoreName(rawName);
  if (base.isGenericPlaceholder || base.matchedRule !== 'GENERIC') {
    return base;
  }
  return {
    ...base,
    canonicalName: CANONICAL_STORE_NE,
    matchedRule: 'REGISTRO_NAO_SOUZA_ATUAL'
  };
}
