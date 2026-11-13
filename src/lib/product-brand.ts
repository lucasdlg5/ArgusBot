import { normalizePtText } from './perishability';

const KNOWN_BR_BRANDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\btio\s+joao\b/, label: 'Tio João' },
  { pattern: /\bprato\s+fino\b/, label: 'Prato Fino' },
  { pattern: /\bcamil\b/, label: 'Camil' },
  { pattern: /\bsaboroso\b/, label: 'Saboroso' },
  { pattern: /\bkicaldo\b/, label: 'Kicaldo' },
  { pattern: /\bbroto\s+legal\b/, label: 'Broto Legal' },
  { pattern: /\bnamorado\b/, label: 'Namorado' },
  { pattern: /\b3\s*coracoes\b|\btres\s*coracoes\b/, label: '3 Corações' },
  { pattern: /\bpilao\b/, label: 'Pilão' },
  { pattern: /\bmelitta\b/, label: 'Melitta' },
  { pattern: /\bcaboclo\b/, label: 'Caboclo' },
  { pattern: /\bpele\b/, label: 'Pelé' },
  { pattern: /\bitalac\b/, label: 'Italac' },
  { pattern: /\bpiracanjuba\b/, label: 'Piracanjuba' },
  { pattern: /\belege\b/, label: 'Elegê' },
  { pattern: /\bparmalat\b/, label: 'Parmalat' },
  { pattern: /\bnestle\b/, label: 'Nestlé' },
  { pattern: /\bninho\b/, label: 'Ninho' },
  { pattern: /\baviacao\b/, label: 'Aviação' },
  { pattern: /\bvigor\b/, label: 'Vigor' },
  { pattern: /\bqualy\b/, label: 'Qualy' },
  { pattern: /\bdoriana\b/, label: 'Doriana' },
  { pattern: /\bdelicia\b/, label: 'Delícia' },
  { pattern: /\bsadia\b/, label: 'Sadia' },
  { pattern: /\bperdigao\b/, label: 'Perdigão' },
  { pattern: /\bseara\b/, label: 'Seara' },
  { pattern: /\bfriboi\b/, label: 'Friboi' },
  { pattern: /\bswift\b/, label: 'Swift' },
  { pattern: /\baurora\b/, label: 'Aurora' },
  { pattern: /\bliza\b/, label: 'Liza' },
  { pattern: /\bsoya\b/, label: 'Soya' },
  { pattern: /\bgallo\b/, label: 'Gallo' },
  { pattern: /\bandorinha\b/, label: 'Andorinha' },
  { pattern: /\bcarbonell\b/, label: 'Carbonell' },
  { pattern: /\bborges\b/, label: 'Borges' },
  { pattern: /\bype\b/, label: 'Ypê' },
  { pattern: /\bomo\b/, label: 'Omo' },
  { pattern: /\bbrilhante\b/, label: 'Brilhante' },
  { pattern: /\btixan\b/, label: 'Tixan' },
  { pattern: /\bcomfort\b/, label: 'Comfort' },
  { pattern: /\bdowny\b/, label: 'Downy' },
  { pattern: /\bveja\b/, label: 'Veja' },
  { pattern: /\bpinho\s+sol\b/, label: 'Pinho Sol' },
  { pattern: /\bqboa\b/, label: 'Qboa' },
  { pattern: /\bcolgate\b/, label: 'Colgate' },
  { pattern: /\bsorriso\b/, label: 'Sorriso' },
  { pattern: /\bdove\b/, label: 'Dove' },
  { pattern: /\bnivea\b/, label: 'Nivea' },
  { pattern: /\brexona\b/, label: 'Rexona' },
  { pattern: /\bneve\b/, label: 'Neve' },
  { pattern: /\bpersonal\b/, label: 'Personal' },
  { pattern: /\bcoca[\s-]*cola\b/, label: 'Coca-Cola' },
  { pattern: /\bguarana\s+antarctica\b|\bantarctica\b/, label: 'Antarctica' },
  { pattern: /\bpepsi\b/, label: 'Pepsi' },
  { pattern: /\bfanta\b/, label: 'Fanta' },
  { pattern: /\bsprite\b/, label: 'Sprite' },
  { pattern: /\bheinz\b/, label: 'Heinz' },
  { pattern: /\bhellmanns?\b/, label: "Hellmann's" },
  { pattern: /\bquero\b/, label: 'Quero' },
  { pattern: /\bfugini\b/, label: 'Fugini' },
  { pattern: /\bpredilecta\b/, label: 'Predilecta' },
  { pattern: /\bbarilla\b/, label: 'Barilla' },
  { pattern: /\brenata\b/, label: 'Renata' },
  { pattern: /\badria\b/, label: 'Adria' },
  { pattern: /\bpiraque\b/, label: 'Piraquê' },
  { pattern: /\bdona\s+benta\b/, label: 'Dona Benta' },
  { pattern: /\buniao\b/, label: 'União' },
  { pattern: /\bcaravelas\b/, label: 'Caravelas' },
  { pattern: /\bda\s+barra\b/, label: 'Da Barra' },
  { pattern: /\bbauducco\b/, label: 'Bauducco' },
  { pattern: /\bmarilan\b/, label: 'Marilan' },
  { pattern: /\belma\s+chips\b/, label: 'Elma Chips' },
  { pattern: /\blacta\b/, label: 'Lacta' },
  { pattern: /\bgaroto\b/, label: 'Garoto' },
  { pattern: /\bnescau\b/, label: 'Nescau' },
  { pattern: /\btoddynho\b|\btoddy\b/, label: 'Toddy' },
  { pattern: /\bdanone\b/, label: 'Danone' },
  { pattern: /\bactivia\b/, label: 'Activia' },
  { pattern: /\byakult\b/, label: 'Yakult' },
  { pattern: /\bcatupiry\b/, label: 'Catupiry' },
  { pattern: /\bpolenghi\b/, label: 'Polenghi' },
  { pattern: /\btirolez\b/, label: 'Tirolez' },
  { pattern: /\bpresident\b/, label: 'Président' },
  { pattern: /\bknorr\b/, label: 'Knorr' },
  { pattern: /\bmaggi\b/, label: 'Maggi' },
  { pattern: /\barisco\b/, label: 'Arisco' },
  { pattern: /\bsazon\b/, label: 'Sazón' },
  { pattern: /\bwickbold\b/, label: 'Wickbold' },
  { pattern: /\bpullman\b/, label: 'Pullman' },
  { pattern: /\bplus\s*vita\b/, label: 'Plus Vita' },
  { pattern: /\bcisne\b/, label: 'Cisne' },
  { pattern: /\blebre\b/, label: 'Lebre' },
  { pattern: /\bheineken\b/, label: 'Heineken' },
  { pattern: /\bbrahma\b/, label: 'Brahma' },
  { pattern: /\bskol\b/, label: 'Skol' },
  { pattern: /\bamstel\b/, label: 'Amstel' },
  { pattern: /\broyal\b/, label: 'Royal' },
  { pattern: /\balbany\b/, label: 'Albany' },
  { pattern: /\bfrancis\b/, label: 'Francis' },
  { pattern: /\bprotex\b/, label: 'Protex' },
  { pattern: /\bphebo\b/, label: 'Phebo' },
  { pattern: /\bgranado\b/, label: 'Granado' },
  { pattern: /\blux\b/, label: 'Lux' },
  { pattern: /\bpalmolive\b/, label: 'Palmolive' },
  { pattern: /\bjohnsons?\b/, label: "Johnson's" },
  { pattern: /\bseda\b/, label: 'Seda' },
  { pattern: /\bpantene\b/, label: 'Pantene' },
  { pattern: /\belseve\b/, label: 'Elseve' },
  { pattern: /\bclear\b/, label: 'Clear' },
  { pattern: /\btresemme\b/, label: 'TRESemmé' },
  { pattern: /\bgarnier\b/, label: 'Garnier' },
  { pattern: /\boral[\s-]*b\b/, label: 'Oral-B' },
  { pattern: /\bsensodyne\b/, label: 'Sensodyne' },
  { pattern: /\bclose[\s-]*up\b/, label: 'Close Up' },
  { pattern: /\bbombril\b/, label: 'Bombril' },
  { pattern: /\bassolan\b/, label: 'Assolan' },
  { pattern: /\bscott\b/, label: 'Scott' },
  { pattern: /\belite\b/, label: 'Elite' },
  { pattern: /\bajax\b/, label: 'Ajax' },
  { pattern: /\bvanish\b/, label: 'Vanish' },
  { pattern: /\blysoform\b/, label: 'Lysoform' },
  { pattern: /\bminuano\b/, label: 'Minuano' },
  { pattern: /\blimpol\b/, label: 'Limpol' },
  { pattern: /\bpanco\b/, label: 'Panco' },
  { pattern: /\bseven\s+boys\b/, label: 'Seven Boys' },
  { pattern: /\bvisconti\b/, label: 'Visconti' },
  { pattern: /\bnutrella\b/, label: 'Nutrella' },
  { pattern: /\bnutella\b/, label: 'Nutella' },
  { pattern: /\bferrero\b/, label: 'Ferrero' },
  { pattern: /\bmilka\b/, label: 'Milka' },
  { pattern: /\bhersheys?\b/, label: "Hershey's" },
  { pattern: /\boreo\b/, label: 'Oreo' },
  { pattern: /\btrakinas\b/, label: 'Trakinas' },
  { pattern: /\bnegresco\b/, label: 'Negresco' },
  { pattern: /\bpassatempo\b/, label: 'Passatempo' },
  { pattern: /\bclub\s+social\b/, label: 'Club Social' },
  { pattern: /\bmaizena\b/, label: 'Maizena' },
  { pattern: /\bkibon\b/, label: 'Kibon' },
  { pattern: /\bdel\s+valle\b/, label: 'Del Valle' },
  { pattern: /\btang\b/, label: 'Tang' },
  { pattern: /\bgatorade\b/, label: 'Gatorade' },
  { pattern: /\bred\s+bull\b/, label: 'Red Bull' },
  { pattern: /\bmonster\b/, label: 'Monster' },
  { pattern: /\bitambe\b/, label: 'Itambé' },
  { pattern: /\bbetania\b/, label: 'Betânia' },
  { pattern: /\bleitissimo\b/, label: 'Leitíssimo' },
  { pattern: /\bbatavo\b/, label: 'Batavo' },
  { pattern: /\bquata\b/, label: 'Quatá' },
  { pattern: /\bphiladelphia\b/, label: 'Philadelphia' },
  { pattern: /\bclaybom\b/, label: 'Claybom' },
  { pattern: /\bbecel\b/, label: 'Becel' },
  { pattern: /\byoki\b/, label: 'Yoki' },
  { pattern: /\bkitano\b/, label: 'Kitano' },
  { pattern: /\bajinomoto\b/, label: 'Ajinomoto' },
  { pattern: /\bsakura\b/, label: 'Sakura' },
  { pattern: /\bhemmer\b/, label: 'Hemmer' },
  { pattern: /\bguarani\b/, label: 'Guarani' },
  { pattern: /\btaeq\b/, label: 'Taeq' },
  { pattern: /\bqualita\b/, label: 'Qualitá' },
  { pattern: /\bkatayama\b/, label: 'Katayama' },
  { pattern: /\bmantiqueira\b/, label: 'Mantiqueira' },
  { pattern: /\bkorin\b/, label: 'Korin' }
];

const GENERIC_TOKENS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'com',
  'sem',
  'para',
  'e',
  'em',
  'tipo',
  't1',
  't2',
  'kg',
  'g',
  'gr',
  'ml',
  'l',
  'lt',
  'un',
  'und',
  'pct',
  'pc',
  'tp',
  'vd',
  'cx',
  'fd',
  'fr',
  'gf',
  'pt',
  'sc',
  'extra',
  'tradicional',
  'trad',
  'integral',
  'desnatado',
  'semidesnatado',
  'uht',
  'bov',
  'bovino',
  'bovina',
  'file',
  'peito',
  'moido',
  'moida',
  'cubos',
  'osso',
  'branco',
  'brancos',
  'vermelho',
  'grande',
  'grandes',
  'medio',
  'pequeno',
  'fresco',
  'fresca',
  'congelado',
  'congelada',
  'resfriado',
  'resfriada',
  'especial',
  'selecionado',
  'agulhinha',
  'carioca',
  'preto',
  'virgem',
  'portugues',
  'refinado',
  'cristal',
  'sal',
  'acucar',
  'arroz',
  'feijao',
  'leite',
  'cafe',
  'oleo',
  'azeite',
  'manteiga',
  'margarina',
  'creme',
  'carne',
  'frango',
  'ovos',
  'ovo',
  'pao',
  'farinha',
  'macarrao',
  'molho',
  'extrato',
  'tomate',
  'cebola',
  'alho',
  'batata',
  'banana',
  'maca',
  'detergente',
  'sabao',
  'amaciante',
  'papel',
  'higienico',
  'pasta',
  'sabonete',
  'shampoo',
  'refrigerante',
  'cerveja',
  'biscoito',
  'bolacha',
  'chocolate',
  'queijo',
  'mussarela',
  'presunto',
  'iogurte'
]);

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Extrai a marca provável a partir da descrição bruta do cupom/gôndola/flyer,
 * priorizando catálogo de marcas reais do varejo BR e fallback por token diferencial.
 */
export function extractBrandFromDescription(
  rawDescription: string,
  canonicalProductName?: string | null
): string {
  const normRaw = normalizePtText(rawDescription || '');
  if (!normRaw) return 'Não especificada';

  for (const entry of KNOWN_BR_BRANDS) {
    if (entry.pattern.test(normRaw)) {
      return entry.label;
    }
  }

  const canonicalTokens = new Set(
    normalizePtText(canonicalProductName || '')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );

  const rawTokens = normRaw
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter(
      (t) =>
        t.length >= 3 &&
        !/^\d+$/.test(t) &&
        !/^\d+(kg|g|ml|l|lt|un)$/i.test(t) &&
        !GENERIC_TOKENS.has(t) &&
        !canonicalTokens.has(t)
    );

  if (rawTokens.length > 0) {
    return toTitleCase(rawTokens[0]);
  }

  return 'Não especificada';
}

export function matchesProductSearch(
  entry: {
    canonicalProductName: string;
    rawDescription: string;
    brandName: string;
    storeName: string;
    storeLocation: string;
    category: string;
  },
  rawQuery: string
): boolean {
  const normQuery = normalizePtText(rawQuery);
  if (!normQuery) return true;
  const tokens = normQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystack = normalizePtText(
    [
      entry.canonicalProductName,
      entry.rawDescription,
      entry.brandName,
      entry.storeName,
      entry.storeLocation,
      entry.category
    ].join(' ')
  );

  return tokens.every((t) => haystack.includes(t));
}
