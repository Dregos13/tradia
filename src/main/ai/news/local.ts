/**
 * Analizador léxico local de titulares — respaldo sin coste del LLM.
 *
 * Funciona sin red ni claves: detecta los activos del titular (cashtags,
 * tickers en mayúsculas y nombres de empresa del universo) y estima el
 * sentimiento por activo con un léxico financiero en español e inglés.
 *
 * Reglas relevantes para la evaluación sobre `headlines.labeled.json`:
 * - Negación: 'no', 'not', 'fails to', 'niega', 'apenas'… invierten el
 *   peso del término que tienen a menos de tres palabras ('does not
 *   disappoint' → favorable, 'fails to impress' → desfavorable).
 * - Contraste y concesión: lo que va tras 'but/pero/however' pesa ×1,4 y
 *   lo anterior ×0,6; las cláusulas concesivas ('despite', 'pese a',
 *   'although', 'while') pesan ×0,4–0,6. Así 'beats sales but warns on
 *   margins' resuelve desfavorable, como reacciona el mercado.
 * - Sarcasmo: los eventos duros (quiebra, recall, multa, profit warning,
 *   plunges) pesan ×2–3 y las palabras de elogio ×1, así 'Brilliant move:
 *   plunges 6 %' queda desfavorable.
 * - Inyección: los tramos entre corchetes/comillas angulares con palabras
 *   de instrucción se eliminan antes de puntuar, y cualquier término de
 *   sentimiento a menos de 5 palabras tras una palabra de instrucción
 *   ('ignore', 'output', 'clasifica', 'sentiment', 'json'…) se ignora.
 * - 'mixto' exige fuerza en ambos lados (≥2 cada uno y ratio ≥ 0,5) o un
 *   marcador explícito ('mixed', 'mixto', 'agridulce').
 *
 * Umbral documentado del conjunto etiquetado (`eval.ts`): ≥ 90 % de
 * acierto en el activo y ≥ 70 % en el sentimiento con este analizador.
 *
 * Nunca crea señales: solo describe el titular por activo.
 */
import { DEFAULT_ASSET_ALIASES, type AssetAlias } from '../../news/poller';
import { TICKER_PATTERN, type NewsSentiment } from '../../../shared/ipc';
import type {
  AssetSentiment,
  NewsAnalysisInput,
  NewsAnalysisResult,
  NewsHeadlineAnalyzer,
} from './types';

// ---------------------------------------------------------------------------
// Universo y alias de activos
// ---------------------------------------------------------------------------

/** Universo inicial de la app (alcance.md §1: 10 ETF + 15 acciones). */
export const NEWS_ASSET_UNIVERSE = [
  'SPY',
  'QQQ',
  'DIA',
  'IWM',
  'VTI',
  'XLF',
  'XLK',
  'XLE',
  'XLV',
  'TLT',
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'JPM',
  'XOM',
  'JNJ',
  'PG',
  'V',
  'HD',
  'KO',
  'AVGO',
  'AMD',
] as const;

/** Nombres de empresa del universo: los del lector más los que faltaban. */
export const NEWS_ASSET_ALIASES: Readonly<Record<string, readonly AssetAlias[]>> = {
  ...DEFAULT_ASSET_ALIASES,
  AMD: [{ name: 'Advanced Micro Devices' }],
};

// ---------------------------------------------------------------------------
// Léxico de sentimiento (minúsculas y sin tildes, como el texto normalizado)
// ---------------------------------------------------------------------------

/** Entrada terminada en '*': casa por raíz ('plunge*' caza 'plunges'). */
type LexEntry = readonly [term: string, weight: number];

/**
 * Frases multi-palabra (se evalúan antes que las palabras sueltas y
 * consumen sus tokens para no puntuar dos veces).
 */
const PHRASES: readonly LexEntry[] = [
  // Favorable fuerte.
  ['beats expectations', 3],
  ['beat expectations', 3],
  ['beats estimates', 3],
  ['beat estimates', 3],
  ['tops estimates', 3],
  ['topped estimates', 3],
  ['top estimates', 3],
  ['tops forecasts', 3],
  ['topped forecasts', 3],
  ['top forecasts', 3],
  ['better than expected', 3],
  ['above expectations', 3],
  ['supera previsiones', 3],
  ['supera las previsiones', 3],
  ['supera expectativas', 3],
  ['supera las expectativas', 3],
  ['mejor de lo esperado', 3],
  ['mejor de lo previsto', 3],
  ['por encima de lo esperado', 3],
  ['record high', 3],
  ['record profit', 3],
  ['record revenue', 3],
  ['record earnings', 3],
  ['record sales', 3],
  ['all-time high', 3],
  ['all time high', 3],
  ['maximo historico', 3],
  ['maximos historicos', 3],
  ['beneficio record', 3],
  ['ingresos record', 3],
  ['ventas record', 3],
  ['blowout quarter', 3],
  ['blowout earnings', 3],
  ['raises guidance', 3],
  ['raised guidance', 3],
  ['raises forecast', 3],
  ['raises outlook', 3],
  ['boosts guidance', 3],
  ['boosts outlook', 3],
  ['lifts guidance', 3],
  ['lifts forecast', 3],
  ['ups guidance', 3],
  ['eleva previsiones', 3],
  ['eleva sus previsiones', 3],
  ['mejora previsiones', 3],
  ['mejora sus previsiones', 3],
  ['eleva su guia', 3],
  ['wins approval', 3],
  ['wins fda approval', 3],
  ['fda approval', 3],
  ['aprobado por la fda', 3],
  ['regulatory approval', 3],
  ['luz verde', 3],
  ['green light', 3],
  ['upgrade to buy', 3],
  ['upgraded to buy', 3],
  ['initiates with buy', 3],
  ['initiated with buy', 3],
  ['upgrade to overweight', 3],
  ['upgraded to overweight', 3],
  // Favorable medio.
  ['raises dividend', 2],
  ['raised dividend', 2],
  ['dividend hike', 2],
  ['aumenta dividendo', 2],
  ['aumenta el dividendo', 2],
  ['share buyback', 2],
  ['buyback program', 2],
  ['recompra de acciones', 2],
  ['programa de recompra', 2],
  ['wins contract', 2],
  ['secures deal', 2],
  ['lands deal', 2],
  ['cierra acuerdo', 2],
  ['price target raised', 2],
  ['raises price target', 2],
  ['eleva precio objetivo', 2],
  ['sube precio objetivo', 2],
  ['strong demand', 2],
  ['demanda solida', 2],
  ['beats sales', 3],
  ['outperform rating', 3],
  // Desfavorable fuerte.
  ['profit warning', -3],
  ['misses estimates', -3],
  ['missed estimates', -3],
  ['misses expectations', -3],
  ['miss expectations', -3],
  ['missed expectations', -3],
  ['earnings miss', -3],
  ['revenue miss', -3],
  ['sales miss', -3],
  ['profit miss', -3],
  ['below expectations', -3],
  ['worse than expected', -3],
  ['falls short', -3],
  ['fell short', -3],
  ['fall short', -3],
  ['short of expectations', -3],
  ['no alcanza previsiones', -3],
  ['por debajo de lo esperado', -3],
  ['peor de lo esperado', -3],
  ['cuts guidance', -3],
  ['cut guidance', -3],
  ['slashes guidance', -3],
  ['lowers guidance', -3],
  ['lowered guidance', -3],
  ['trims guidance', -3],
  ['recorta previsiones', -3],
  ['recorta sus previsiones', -3],
  ['rebaja previsiones', -3],
  ['rebaja sus previsiones', -3],
  ['cuts outlook', -3],
  ['lowers outlook', -3],
  ['guidance cut', -3],
  ['cuts dividend', -3],
  ['cut dividend', -3],
  ['slashes dividend', -3],
  ['suspende dividendo', -3],
  ['suspende el dividendo', -3],
  ['recorta dividendo', -3],
  ['recorta el dividendo', -3],
  ['suspends dividend', -3],
  ['suspended dividend', -3],
  ['eliminates dividend', -3],
  ['profit slump', -3],
  ['write-down', -3],
  ['writedown', -3],
  ['data breach', -3],
  ['cyber attack', -3],
  ['cyberattack', -3],
  ['class action', -3],
  ['sec probe', -3],
  ['sec investigation', -3],
  ['criminal probe', -3],
  ['antitrust probe', -3],
  ['accounting probe', -3],
  ['plant closure', -3],
  ['store closures', -3],
  ['plant shutdown', -3],
  ['concurso de acreedores', -3],
  ['suspension de pagos', -3],
  ['files for bankruptcy', -3],
  ['filed for bankruptcy', -3],
  ['chapter 11', -3],
  ['declares bankruptcy', -3],
  ['downgrade to sell', -3],
  ['downgraded to sell', -3],
  ['restates earnings', -3],
  ['accounting irregularities', -3],
  ['export ban', -3],
  ['export curbs', -3],
  ['chip ban', -3],
  ['job cuts', -3],
  ['cuts jobs', -3],
  ['cut jobs', -3],
  ['slash jobs', -3],
  ['slashes jobs', -3],
  ['recorte de empleo', -3],
  ['recortes de empleo', -3],
  // Desfavorable medio.
  ['price target cut', -2],
  ['cuts price target', -2],
  ['recorta precio objetivo', -2],
  ['rebaja precio objetivo', -2],
  ['regulatory scrutiny', -2],
  ['under investigation', -2],
  ['sales decline', -2],
  ['demand slows', -2],
  ['demand weakness', -2],
  ['slowing growth', -2],
  ['growth slows', -2],
  ['margin pressure', -2],
  ['presion en margenes', -2],
  ['supply issues', -2],
  ['refinery outage', -2],
  ['credit downgrade', -2],
  ['debt downgrade', -2],
];

/** Palabras sueltas (stem con '*' al final). */
const WORDS: readonly LexEntry[] = [
  // Fuertes.
  ['soar*', 3],
  ['surge*', 3],
  ['dispar*', 3],
  ['skyrocket*', 3],
  ['rocket*', 3],
  ['blowout', 3],
  ['bankrupt*', -3],
  ['quiebr*', -3],
  ['plunge*', -3],
  ['plummet*', -3],
  ['tumble*', -3],
  ['crash*', -3],
  ['collaps*', -3],
  ['colapso*', -3],
  ['desplom*', -3],
  ['hund*', -3],
  ['meltdown*', -3],
  ['selloff*', -3],
  ['sell-off*', -3],
  ['fraud*', -3],
  ['fraude*', -3],
  ['recall*', -3],
  ['retirada*', -3],
  ['default*', -3],
  ['impago*', -3],
  ['insolven*', -3],
  ['bloodbath*', -3],
  // Medias positivas.
  ['rall*', 2],
  ['repunt*', 2],
  ['rebound*', 2],
  ['rebote*', 2],
  ['jump*', 2],
  ['leap*', 2],
  ['gain*', 2],
  ['gananc*', 2],
  ['rise*', 2],
  ['rose', 2],
  ['climb*', 2],
  ['sube*', 2],
  ['suben', 2],
  ['subida*', 2],
  ['avanza*', 2],
  ['gana*', 2],
  ['mejora*', 2],
  ['recupera*', 2],
  ['recovers', 2],
  ['recovery', 2],
  ['beat*', 2],
  ['tops', 2],
  ['top*', 2],
  ['exceed*', 2],
  ['supera*', 2],
  ['outperform*', 2],
  ['upgrade*', 2],
  ['upgrad*', 2],
  ['bullish*', 2],
  ['alcista*', 2],
  ['record*', 2],
  ['expand*', 2],
  ['expansion*', 2],
  ['win*', 2],
  ['won', 2],
  ['approv*', 2],
  ['aprueb*', 2],
  ['aprobac*', 2],
  ['boost*', 2],
  ['impuls*', 2],
  ['solid*', 2],
  ['solido*', 2],
  ['strong*', 2],
  ['fuerte*', 2],
  ['breakthrough*', 2],
  ['milestone*', 2],
  ['resilien*', 2],
  ['optimis*', 2],
  ['optimist*', 2],
  // Medias negativas.
  ['sink*', -2],
  ['slump*', -2],
  ['fall*', -2],
  ['fell', -2],
  ['drop*', -2],
  ['slide*', -2],
  ['slid*', -2],
  ['slip*', -2],
  ['declin*', -2],
  ['cae*', -2],
  ['caid*', -2],
  ['baja*', -2],
  ['bajan', -2],
  ['descens*', -2],
  ['pierde*', -2],
  ['perdida*', -2],
  ['loss*', -2],
  ['warn*', -2],
  ['warning*', -2],
  ['adviert*', -2],
  ['alerta*', -1],
  ['miss*', -2],
  ['disappoint*', -2],
  ['decepcion*', -2],
  ['layoff*', -2],
  ['despid*', -2],
  ['lawsuit*', -2],
  ['demanda*', -2],
  ['sue*', -2],
  ['sued', -2],
  ['settlement*', -2],
  ['fine*', -2],
  ['fined', -2],
  ['multa*', -2],
  ['sanction*', -2],
  ['sancion*', -2],
  ['probe*', -2],
  ['investiga*', -2],
  ['scrutiny*', -2],
  ['downgrade*', -2],
  ['rebaja*', -2],
  ['bearish*', -2],
  ['bajista*', -2],
  ['cut*', -2],
  ['recort*', -2],
  ['slash*', -2],
  ['halt*', -2],
  ['suspend*', -2],
  ['ban*', -2],
  ['veto*', -2],
  ['outage*', -2],
  ['apagon*', -2],
  ['breach*', -2],
  ['hack*', -2],
  ['hackeo*', -2],
  ['delay*', -2],
  ['retras*', -2],
  ['weak*', -2],
  ['debil*', -2],
  ['worse*', -2],
  ['peor*', -2],
  ['woes*', -2],
  ['trouble*', -2],
  ['recession*', -2],
  ['recesion*', -2],
  ['resign*', -2],
  ['dimit*', -2],
  ['scandal*', -2],
  ['escandal*', -2],
  ['setback*', -2],
  ['reves*', -2],
  ['slow*', -2],
  ['lawsuits*', -2],
  ['glut*', -2],
  ['oversuppl*', -2],
  // Suaves (sarcasmo y tono).
  ['good', 1],
  ['great', 1],
  ['wonderful', 1],
  ['brilliant', 1],
  ['genial', 1],
  ['nice', 1],
  ['positive*', 1],
  ['positiv*', 1],
  ['upbeat*', 1],
  ['hope*', 1],
  ['esperanza*', 1],
  ['steady*', 1],
  ['stable*', 1],
  ['estable*', 1],
  ['perfect*', 1],
  ['perfecto*', 1],
  ['sure', 1],
  ['just what', 1],
  ['concern*', -1],
  ['preocup*', -1],
  ['caution*', -1],
  ['cautel*', -1],
  ['uncertain*', -1],
  ['incertidumbr*', -1],
  ['risk*', -1],
  ['riesgo*', -1],
  ['fear*', -1],
  ['miedo*', -1],
  ['worr*', -1],
  ['volatile*', -1],
  ['volatil*', -1],
];

/** Marcadores explícitos de sentimiento mixto: suman 2 a cada lado. */
const MIXED_MARKERS = ['mixed', 'mixto*', 'mixta*', 'agridulce*', 'bittersweet*'];

/** Negadores: invierten el peso del término a menos de 3 palabras. */
const NEGATIONS = new Set([
  'no',
  'not',
  "n't",
  'never',
  'nunca',
  'jamas',
  'sin',
  'ni',
  'fails',
  'failed',
  'failing',
  'falla',
  'fallo',
  'unable',
  'denies',
  'denied',
  'deny',
  'niega',
  'negado',
  'barely',
  'hardly',
  'scarcely',
  'apenas',
  'far',
  'lejos',
]);

/**
 * Palabras de instrucción (prompt injection): un término de sentimiento a
 * menos de 5 palabras DESPUÉS de una de estas se ignora. Las frases del
 * léxico ya están casadas de forma segura; esta regla solo protege las
 * palabras sueltas ('positivo', 'negativo', 'bullish'…).
 */
const INSTRUCTION_WORDS = new Set([
  'ignore',
  'ignora',
  'ignorar',
  'olvida',
  'olvidar',
  'forget',
  'instruccion',
  'instrucciones',
  'instruction',
  'instructions',
  'system',
  'sistema',
  'prompt',
  'output',
  'salida',
  'respond',
  'responde',
  'responder',
  'reply',
  'clasifica',
  'clasificar',
  'classify',
  'sentiment',
  'sentimiento',
  'json',
  'schema',
  'esquema',
  'etiqueta',
  'label',
  'assistant',
  'asistente',
  'llm',
  'note',
]);

/** Conectores concesivos: la cláusula que abren pesa ×0,4. */
const CONCESSIVE = [
  'despite',
  'in spite of',
  'a pesar de',
  'pese a',
  'although',
  'even though',
  'aunque',
] as const;

/** Conectores de contraste: lo anterior pesa ×0,6, lo posterior ×1,4. */
const CONTRAST = [
  'but',
  'pero',
  'however',
  'sin embargo',
  'nevertheless',
  'no obstante',
  'yet',
] as const;

/** Coordinadas concesivas ('A sube while B cae': la cláusula B pesa ×0,6). */
const SEMI_CONCESSIVE = ['while', 'whilst', 'whereas', 'mientras'] as const;

// ---------------------------------------------------------------------------
// Normalización y segmentación
// ---------------------------------------------------------------------------

/**
 * Normalización que PRESERVA la longitud: minúsculas y una pasada por
 * carácter que cambia la base sin marcas ('ó'→'o', 'ñ'→'n'). Así los
 * índices hallados sobre el texto normalizado valen para el original.
 */
const normalize = (text: string): string =>
  [...text.toLowerCase()].map((c) => c.normalize('NFD').replace(/\p{M}/gu, '')).join('');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Patrón de una entrada del léxico: palabra completa o raíz con '*'. */
const termPattern = (term: string): RegExp =>
  term.endsWith('*')
    ? new RegExp(`\\b${escapeRegExp(term.slice(0, -1))}\\w*\\b`)
    : new RegExp(`\\b${escapeRegExp(term)}\\b`);

const WORD_PATTERNS: readonly (readonly [RegExp, string, number])[] = WORDS.map(
  ([term, weight]) => [termPattern(term), term, weight],
);
const MIXED_PATTERNS = MIXED_MARKERS.map(termPattern);
const INSTRUCTION_PATTERN = new RegExp(
  `\\b(${[...INSTRUCTION_WORDS].map(escapeRegExp).join('|')})\\b`,
);

/**
 * Elimina tramos entre `[]`, `<>` o `{}` que contengan palabras de
 * instrucción: un titular real no lleva `[SYSTEM: ...]` ni `<user: ...>`,
 * así que quitarlos no cuesta precisión y cierra la vía de inyección.
 */
export function stripInstructionSpans(text: string): string {
  let out = '';
  let i = 0;
  const open: Record<string, string> = { '[': ']', '<': '>', '{': '}' };
  while (i < text.length) {
    const ch = text[i]!;
    const close = open[ch];
    if (close === undefined) {
      out += ch;
      i += 1;
      continue;
    }
    const end = text.indexOf(close, i + 1);
    const span = end === -1 ? '' : text.slice(i + 1, end);
    if (end !== -1 && span.length <= 500 && INSTRUCTION_PATTERN.test(normalize(span))) {
      i = end + 1; // se descarta el tramo entero
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// División en cláusulas con pesos retóricos
// ---------------------------------------------------------------------------

interface Clause {
  /** Texto original (saneado) de la cláusula. */
  raw: string;
  /** Texto normalizado para puntuar. */
  norm: string;
  /** Multiplicador retórico (concesión/contraste). */
  boost: number;
}

const CLAUSE_SEPARATOR = /[.;:!?…\n—–()]+/;
const CONNECTOR_PATTERN = new RegExp(
  `\\b(${[...CONCESSIVE, ...CONTRAST, ...SEMI_CONCESSIVE]
    .map(escapeRegExp)
    .join('|')})\\b`,
  'g',
);

function splitClause(raw: string, boost: number, out: Clause[]): void {
  const norm = normalize(raw);
  CONNECTOR_PATTERN.lastIndex = 0;
  const match = CONNECTOR_PATTERN.exec(norm);
  if (match === null) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) out.push({ raw: trimmed, norm: norm.trim(), boost });
    return;
  }
  const connector = match[0];
  const before = raw.slice(0, match.index);
  const after = raw.slice(match.index + connector.length);
  if ((CONCESSIVE as readonly string[]).includes(connector)) {
    // 'despite X, Y': la parte concesiva pesa poco, manda la principal.
    splitClause(before, boost, out);
    splitClause(after, boost * 0.4, out);
    return;
  }
  if ((SEMI_CONCESSIVE as readonly string[]).includes(connector)) {
    // 'A rallies while B probes': la cláusula 'while' es secundaria.
    splitClause(before, boost, out);
    splitClause(after, boost * 0.6, out);
    return;
  }
  // Contraste: lo que sigue a 'but/however/pero' domina.
  splitClause(before, boost * 0.6, out);
  splitClause(after, boost * 1.4, out);
}

function clausesOf(text: string): Clause[] {
  const clauses: Clause[] = [];
  let start = 0;
  for (const match of text.matchAll(new RegExp(CLAUSE_SEPARATOR.source, 'g'))) {
    splitClause(text.slice(start, match.index), 1, clauses);
    start = match.index! + match[0].length;
  }
  splitClause(text.slice(start), 1, clauses);
  return clauses;
}

// ---------------------------------------------------------------------------
// Puntuación de una cláusula
// ---------------------------------------------------------------------------

interface Token {
  norm: string;
  /** Índice del token en la lista (posición en la cláusula). */
  index: number;
  /** true si un token de frase lo consumió ya. */
  consumed: boolean;
  /** true si está bajo el radio de una palabra de instrucción. */
  suppressed: boolean;
}

interface Score {
  pos: number;
  neg: number;
  /** Término del léxico con mayor |peso| (para el resumen). */
  cue: string | null;
  cueWeight: number;
}

function tokenize(norm: string): Token[] {
  const tokens: Token[] = [];
  for (const match of norm.matchAll(/[\p{L}\p{N}']+/gu)) {
    tokens.push({ norm: match[0], index: tokens.length, consumed: false, suppressed: false });
  }
  return tokens;
}

function markSuppressed(tokens: Token[]): void {
  let lastInstruction = -100;
  for (const token of tokens) {
    if (INSTRUCTION_WORDS.has(token.norm)) {
      lastInstruction = token.index;
      token.suppressed = true;
      continue;
    }
    if (token.index - lastInstruction <= 5) token.suppressed = true;
  }
}

/** true si algún negador está a ≤3 palabras antes del token `index`. */
function negated(tokens: Token[], index: number): boolean {
  for (let i = Math.max(0, index - 3); i < index; i += 1) {
    if (NEGATIONS.has(tokens[i]!.norm)) return true;
  }
  return false;
}

/** Frases multi-palabra ordenadas de más a menos tokens (casa la mayor). */
const PHRASE_LIST: readonly (readonly [string[], string, number])[] = PHRASES.map(
  ([phrase, weight]) => [phrase.split(' '), phrase, weight] as const,
).sort((a, b) => b[0].length - a[0].length);

function scoreClause(clause: Clause): Score {
  const tokens = tokenize(clause.norm);
  markSuppressed(tokens);
  let pos = 0;
  let neg = 0;
  let cue: string | null = null;
  let cueWeight = 0;

  const apply = (weight: number, cueText: string): void => {
    const boosted = weight * clause.boost;
    if (boosted > 0) pos += boosted;
    else if (boosted < 0) neg += -boosted;
    if (Math.abs(boosted) > Math.abs(cueWeight)) {
      cue = cueText;
      cueWeight = boosted;
    }
  };

  // Marcadores de mixto: fuerzan presencia en ambos lados.
  for (const pattern of MIXED_PATTERNS) {
    if (pattern.test(clause.norm)) {
      pos += 2 * clause.boost;
      neg += 2 * clause.boost;
      cue ??= 'mixed';
    }
  }

  // Frases primero: consumen sus tokens para no puntuar dos veces.
  for (const [phraseTokens, phrase, baseWeight] of PHRASE_LIST) {
    const n = phraseTokens.length;
    for (let i = 0; i + n <= tokens.length; i += 1) {
      if (tokens.slice(i, i + n).some((t) => t.consumed)) continue;
      if (!tokens.slice(i, i + n).every((t, k) => t.norm === phraseTokens[k])) continue;
      for (let k = 0; k < n; k += 1) tokens[i + k]!.consumed = true;
      apply(negated(tokens, i) ? -baseWeight : baseWeight, phrase);
      i += n - 1;
    }
  }

  // Palabras sueltas.
  for (const token of tokens) {
    if (token.consumed || token.suppressed) continue;
    for (const [pattern, term, baseWeight] of WORD_PATTERNS) {
      if (!pattern.test(token.norm)) continue;
      token.consumed = true;
      apply(negated(tokens, token.index) ? -baseWeight : baseWeight, term);
      break;
    }
  }

  return { pos, neg, cue, cueWeight };
}

// ---------------------------------------------------------------------------
// Detección de activos
// ---------------------------------------------------------------------------

const CASHTAG = /\$([A-Za-z0-9][A-Za-z0-9.-]{0,11})\b/g;

interface MentionMatchers {
  ticker: string;
  patterns: RegExp[];
}

function mentionMatchers(ticker: string, aliases: readonly AssetAlias[]): MentionMatchers {
  const patterns: RegExp[] = [new RegExp(`\\$${escapeRegExp(ticker)}\\b`, 'i')];
  // El ticker pelado exige mayúsculas en el texto original (como el lector).
  if (ticker.length >= 2) patterns.push(new RegExp(`\\b${escapeRegExp(ticker)}\\b`));
  for (const alias of aliases) {
    patterns.push(
      new RegExp(`\\b${escapeRegExp(alias.name)}\\b`, alias.caseSensitive ? '' : 'i'),
    );
  }
  return { ticker, patterns };
}

/**
 * Activos del universo mencionados en el texto: $cashtags, tickers en
 * mayúsculas y nombres de empresa (alias). Sirve cuando el titular no
 * trae candidatos ligados por el lector.
 */
export function detectAssets(
  text: string,
  universe: readonly string[] = NEWS_ASSET_UNIVERSE,
  aliases: Readonly<Record<string, readonly AssetAlias[]>> = NEWS_ASSET_ALIASES,
): string[] {
  const inUniverse = new Set(universe.map((t) => t.toUpperCase()));
  const found = new Set<string>();
  for (const match of text.matchAll(CASHTAG)) {
    const ticker = match[1]!.toUpperCase();
    if (inUniverse.has(ticker)) found.add(ticker);
  }
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9.]{1,11}\b/g)) {
    if (inUniverse.has(match[0])) found.add(match[0]);
  }
  for (const ticker of inUniverse) {
    for (const alias of aliases[ticker] ?? []) {
      const pattern = new RegExp(
        `\\b${escapeRegExp(alias.name)}\\b`,
        alias.caseSensitive ? '' : 'i',
      );
      if (pattern.test(text)) found.add(ticker);
    }
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Decisión de sentimiento
// ---------------------------------------------------------------------------

/**
 * Umbrales de la decisión: un lado manda con ≥ 1,5 de peso; 'mixto' exige
 * fuerza en ambos lados (≥ 2 y ratio ≥ 0,5); si no, 'neutro'.
 */
export const LOCAL_SENTIMENT_DOMINANCE = 1.5;
export const LOCAL_SENTIMENT_MIXED_MIN = 2;
export const LOCAL_SENTIMENT_MIXED_RATIO = 0.5;

export function sentimentFromScore(pos: number, neg: number): NewsSentiment {
  if (
    pos >= LOCAL_SENTIMENT_MIXED_MIN &&
    neg >= LOCAL_SENTIMENT_MIXED_MIN &&
    Math.min(pos, neg) / Math.max(pos, neg) >= LOCAL_SENTIMENT_MIXED_RATIO
  ) {
    return 'mixto';
  }
  const dominant = Math.max(pos, neg);
  if (dominant < LOCAL_SENTIMENT_DOMINANCE || pos === neg) return 'neutro';
  return pos > neg ? 'positivo' : 'negativo';
}

const SENTIMENT_LABEL: Record<NewsSentiment, string> = {
  positivo: 'favorable',
  negativo: 'desfavorable',
  neutro: 'neutral',
  mixto: 'mixto',
};

// ---------------------------------------------------------------------------
// Analizador
// ---------------------------------------------------------------------------

export interface LocalNewsAnalyzerDeps {
  /** Universo de tickers detectables; por defecto `NEWS_ASSET_UNIVERSE`. */
  universe?: readonly string[];
  /** Nombres de empresa por ticker; por defecto `NEWS_ASSET_ALIASES`. */
  aliases?: Readonly<Record<string, readonly AssetAlias[]>>;
}

/** Nombre visible de cada sentimiento para el resumen generado. */
export function localSummaryFor(ticker: string, sentiment: NewsSentiment, cue: string | null): string {
  const label = SENTIMENT_LABEL[sentiment];
  const reason =
    cue !== null && cue !== 'mixed' ? ` (señal «${cue}»)` : cue === 'mixed' ? ' (señales en ambos sentidos)' : '';
  return `Análisis local del titular: efecto ${label} estimado para ${ticker}${reason}.`;
}

/**
 * Analizador léxico local: sin red, sin claves y determinista. Con
 * `candidateTickers` solo puntúa esos activos (vía normal del servicio);
 * sin candidatos detecta los activos del propio texto.
 */
export function createLocalNewsAnalyzer(deps: LocalNewsAnalyzerDeps = {}): NewsHeadlineAnalyzer {
  const universe = deps.universe ?? NEWS_ASSET_UNIVERSE;
  const aliases = deps.aliases ?? NEWS_ASSET_ALIASES;

  const analyze = async (input: NewsAnalysisInput): Promise<NewsAnalysisResult> => {
    const text = `${input.title} ${input.summary ?? ''}`;
    const sanitized = stripInstructionSpans(text);
    const candidates = (input.candidateTickers ?? [])
      .map((t) => t.trim().toUpperCase())
      .filter((t) => TICKER_PATTERN.test(t));
    const tickers =
      candidates.length > 0 ? candidates : detectAssets(sanitized, universe, aliases);
    if (tickers.length === 0) return { assets: [] };

    const clauses = clausesOf(sanitized).map((clause) => ({
      ...clause,
      score: scoreClause(clause),
    }));
    const matchers = tickers.map((ticker) => mentionMatchers(ticker, aliases[ticker] ?? []));

    const assets: AssetSentiment[] = matchers.map(({ ticker, patterns }) => {
      const own = clauses.filter((clause) => patterns.some((p) => p.test(clause.raw)));
      const used = own.length > 0 ? own : clauses;
      let pos = 0;
      let neg = 0;
      let cue: string | null = null;
      let cueWeight = 0;
      for (const clause of used) {
        pos += clause.score.pos;
        neg += clause.score.neg;
        if (Math.abs(clause.score.cueWeight) > Math.abs(cueWeight)) {
          cue = clause.score.cue;
          cueWeight = clause.score.cueWeight;
        }
      }
      const sentiment = sentimentFromScore(pos, neg);
      return { ticker, summary: localSummaryFor(ticker, sentiment, cue), sentiment };
    });

    return { assets };
  };

  return { analyzer: 'local', model: null, analyze };
}
