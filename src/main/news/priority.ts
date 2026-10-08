/**
 * Reglas de prioridad, impacto y confirmación — sección 6 del plan.
 *
 * Funciones puras, sin estado ni reloj: el mismo titular con las mismas
 * fuentes y la misma lista de seguimiento produce siempre la misma
 * prioridad. Las palabras clave están en español e inglés y se comparan
 * sobre el texto normalizado (minúsculas y sin tildes) con límite de
 * palabra, así 'fed' no caza 'FedEx' ni 'rating' caza 'grating'.
 *
 * - `classifyNews`: 'maxima' mueve todo el mercado (Fed/BCE/BoE/BoJ y sus
 *   presidentes, nóminas no agrícolas, IPC/PCE/IPP, PIB/PMI/ventas
 *   minoristas, shocks geopolíticos, aranceles, quiebras y crisis de
 *   liquidez). 'activo' exige que el titular toque un activo de la lista de
 *   seguimiento y encaje en las categorías por activo (resultados, guías,
 *   M&A, directivos, analistas, ampliaciones, dividendos, litigios,
 *   regulación, recalls, ciberataques, índices y cripto regulatorio o
 *   hackeos); gana a 'media' porque el interés del usuario manda. 'media'
 *   cubre el impacto sectorial (resultados de grandes empresas no
 *   seguidas, EIA, OPEP, subastas de deuda, rating, vivienda y confianza).
 *   Si no encaja en nada: 'baja'.
 * - Un comunicado de fuente de tipo 'oficial' (SEC EDGAR, CNMV…) sobre un
 *   activo seguido es 'activo' aunque el titular no traiga palabra clave:
 *   un 8-K, un Form 4 o un hecho relevante ya son una categoría en sí
 *   mismos. Es el único uso que `classifyNews` hace de `fuentes`.
 * - `isConfirmed`: solo si alguna fuente es 'oficial' o 'agencia'. Una
 *   noticia que solo viene de redes nunca se marca como confirmada
 *   ('prensa' tampoco confirma por sí sola).
 * - `isCritical` (aviso de noticia crítica): prioridad 'maxima' o 'activo'
 *   con al menos una fuente que no sea de redes. Regla del diseño: lo que
 *   solo viene de redes jamás emite nivel 'critica', se queda en 'info'.
 * - `impactOf`: nivel de impacto del calendario según la guía de diseño
 *   (alto: FOMC, bancos centrales, NFP, IPC, PCE, PIB y vencimientos;
 *   medio: PMI, EIA, OPEP y resultados; bajo: el resto).
 */
import type {
  CalendarEventKind,
  ImpactLevel,
  NewsPriority,
  Reliability,
  SourceKind,
} from '../../shared/ipc';

// ---------------------------------------------------------------------------
// Tipos de entrada (estructurales: valen RawNewsItem, NewsItem o la fila SQLite)
// ---------------------------------------------------------------------------

/** Mínimo de un titular para clasificar: título, resumen opcional y tickers. */
export interface NewsPriorityInput {
  title: string;
  summary?: string | null;
  /** Tickers asociados por la fuente o por el extractor de activos. */
  assets?: readonly string[];
}

/** Mínimo de una fuente que trajo el titular. `kind` solo matiza 'oficial'. */
export interface PrioritySourceRef {
  reliability: Reliability;
  kind?: SourceKind;
}

/** Lista de seguimiento: filas `WatchlistItem`, tickers o una mezcla. */
export type WatchlistEntry = string | { ticker: string };

// ---------------------------------------------------------------------------
// Impacto del calendario (guía de diseño §3.4 + sección 6)
// ---------------------------------------------------------------------------

const IMPACT_BY_KIND: Record<CalendarEventKind, ImpactLevel> = {
  fomc: 'alto',
  'banco-central': 'alto',
  nfp: 'alto',
  ipc: 'alto',
  pce: 'alto',
  pib: 'alto',
  vencimiento: 'alto',
  pmi: 'medio',
  eia: 'medio',
  opep: 'medio',
  resultados: 'medio',
  otro: 'bajo',
};

/**
 * Nivel de impacto de un tipo de evento del calendario. 'alto' es el que
 * dispara el aviso previo; 'resultados' queda en 'medio' porque su aviso al
 * usuario lo decide la regla de noticias por activo, no la alarma macro.
 */
export function impactOf(kind: CalendarEventKind): ImpactLevel {
  return IMPACT_BY_KIND[kind];
}

// ---------------------------------------------------------------------------
// Palabras clave (en minúsculas y sin tildes, como el texto normalizado)
//
// Una entrada terminada en '*' casa por raíz: 'tariff*' caza 'tariff' y
// 'tariffs'. Solo se marca en raíces seguras —'war' no lo está, porque
// 'war*' también cazaría 'warning' o 'warrant'.
// ---------------------------------------------------------------------------

/** 'maxima': decisiones y datos que mueven todo el mercado. */
const MAXIMA_KEYWORDS = [
  // Bancos centrales y política monetaria.
  'fomc',
  'fed',
  'federal reserve',
  'reserva federal',
  'bce',
  'ecb',
  'banco central europeo',
  'european central bank',
  'boe',
  'bank of england',
  'banco de inglaterra',
  'boj',
  'bank of japan',
  'banco de japon',
  'central bank',
  'banco central',
  'powell',
  'lagarde',
  'ueda',
  'tipos de interes',
  'interest rate',
  'rate hike*',
  'rate cut*',
  'rate decision',
  'monetary policy',
  'politica monetaria',
  // Empleo de EE. UU.
  'nfp',
  'nonfarm',
  'non-farm payroll*',
  'payroll*',
  'nominas no agricolas',
  'nomina',
  'nominas',
  'informe de empleo',
  'jobs report',
  'employment report',
  // Inflación.
  'ipc',
  'cpi',
  'pce',
  'ipp',
  'ppi',
  'inflacion*',
  'inflation',
  'consumer price',
  'producer price',
  'indice de precios',
  // Actividad.
  'pib',
  'gdp',
  'pmi',
  'ventas minoristas',
  'retail sales',
  // Shocks geopolíticos, guerras, sanciones, aranceles, elecciones.
  'guerra*',
  'war',
  'wars',
  'warfare',
  'sancion*',
  'sanction*',
  'arancel*',
  'tariff*',
  'eleccion',
  'elecciones',
  'elections',
  'presidential election',
  'general election',
  'election day',
  'election result',
  'comicios',
  'geopolitic*',
  'invad*',
  'invasion*',
  'atentado*',
  'terroris*',
  'golpe*',
  'coup',
  'coups',
  'missile*',
  'misil*',
  // Crisis financieras, quiebras y liquidez.
  'quiebr*',
  'bankrupt*',
  'insolven*',
  'crisis financiera',
  'financial crisis',
  'crisis de liquidez',
  'liquidity crisis',
  'crisis bancaria',
  'banking crisis',
  'recession*',
  'recesion*',
  'colapso bancario',
  'bank collapse*',
  'bank failure*',
  'bank run*',
  'corrida bancaria',
  'bank bailout*',
  'rescate bancario',
  'credit crunch',
  'contagion',
  'contagio',
  'default*',
  'impago*',
  'suspension de pagos',
  'debt ceiling',
  'techo de deuda',
] as const;

/** 'media': impacto sectorial sin ser noticia de un activo seguido. */
const MEDIA_KEYWORDS = [
  // Resultados de grandes empresas (sector entero). Con activo seguido, 'activo'.
  'resultados',
  'earnings',
  'quarterly results',
  'beneficios trimestrales',
  'revenue',
  'ingresos',
  // Inventarios de petróleo y gas.
  'eia',
  'inventarios',
  'inventario',
  'inventories',
  'inventory',
  'crude inventories',
  'oil inventories',
  'inventarios de petroleo',
  'inventarios de crudo',
  'inventarios de gas',
  'gas inventories',
  // OPEP ('opep' ya caza 'opep+' por el límite de palabra).
  'opep',
  'opec',
  // Subastas de deuda y calificación crediticia.
  'subasta*',
  'bond auction*',
  'treasury auction*',
  'debt auction*',
  'calificacion crediticia',
  'credit rating',
  'rating*',
  'downgrad*',
  'upgrad*',
  'moody*',
  'fitch*',
  's&p global',
  // Vivienda, confianza y producción industrial.
  'vivienda*',
  'housing',
  'home sales',
  'housing starts',
  'building permits',
  'permisos de construccion',
  'confianza del consumidor',
  'consumer confidence',
  'consumer sentiment',
  'sentimiento del consumidor',
  'produccion industrial',
  'industrial production',
] as const;

/** 'activo': categorías por activo; solo cuentan si el activo es seguido. */
const ACTIVO_KEYWORDS = [
  // Resultados y guías.
  'resultados',
  'earnings',
  'guia*',
  'guidance',
  'prevision*',
  'forecast*',
  'outlook',
  'profit warning',
  'eps',
  'bpa',
  'revenue',
  'ingresos',
  'beneficio*',
  // Fusiones y adquisiciones.
  'fusion*',
  'merger*',
  'adquisicion*',
  'acquisition*',
  'm&a',
  'opa',
  'opas',
  'takeover*',
  'buyout*',
  'escision*',
  'spin-off',
  'spin off',
  'spinoff',
  'divest*',
  // Cambios de directivos.
  'ceo',
  'cfo',
  'directivo*',
  'executive*',
  'consejero delegado',
  'chairman',
  'chairwoman',
  'chairperson',
  'dimision*',
  'resign*',
  'appoint*',
  'nombrad*',
  'consejo de administracion',
  'board of directors',
  'board member*',
  // Analistas.
  'analista*',
  'analyst*',
  'recomendacion*',
  'recommendation*',
  'price target*',
  'objetivo de precio',
  'downgrad*',
  'upgrad*',
  'overweight',
  'underweight',
  'sobreponderar',
  'infraponderar',
  // Ampliaciones y dividendos.
  'ampliacion de capital',
  'capital increase',
  'capital raise',
  'share offering*',
  'oferta de acciones',
  'emision de acciones',
  'rights issue',
  'recompra de acciones',
  'buyback*',
  'share repurchase*',
  'dividendo*',
  'dividend*',
  // Litigios y regulación.
  'litigio*',
  'demanda*',
  'lawsuit*',
  'sue',
  'sued',
  'sues',
  'settlement*',
  'acuerdo judicial',
  'multa*',
  'fined',
  'antitrust',
  'fraud*',
  'fraude*',
  'imputad*',
  'regulacion*',
  'regulation*',
  'regulador*',
  'regulator*',
  'investigacion*',
  'investigation*',
  'aprob*',
  'aprueb*',
  'approval*',
  'fda',
  'prohib*',
  'ban',
  'bans',
  'banned',
  'veto*',
  'sec filing*',
  '8-k',
  '6-k',
  '10-k',
  '10-q',
  'form 4',
  'hecho relevante',
  'insider*',
  'cnmv',
  // Recalls y ciberataques.
  'recall*',
  'retirada*',
  'withdrawal',
  'defect*',
  'ciberataque*',
  'cyberattack*',
  'cyber attack*',
  'hack*',
  'hackeo*',
  'data breach*',
  'brecha*',
  'breach*',
  'ransomware',
  // Índices.
  'indice*',
  'index*',
  'inclusion*',
  'exclusion*',
  'rebalanceo*',
  'rebalance*',
  's&p 500',
  'nasdaq 100',
  // Cripto: regulación, ETF y hackeos (solo sobre activo seguido).
  'etf',
  'mica',
  'halving',
  'token unlock*',
  'desbloqueo*',
] as const;

// ---------------------------------------------------------------------------
// Coincidencia de texto
// ---------------------------------------------------------------------------

/** Minúsculas y sin marcas diacríticas: 'inflación' ≡ 'inflation' léxica. */
const normalizeText = (text: string): string =>
  text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Palabra clave → patrón sobre el texto normalizado. Sin '*': palabra
 * completa ('fed' no caza 'FedEx'). Con '*': la raíz más cualquier
 * continuación de palabra ('tariff*' caza 'tariffs').
 */
const keywordPattern = (keyword: string): RegExp =>
  keyword.endsWith('*')
    ? new RegExp(`\\b${escapeRegExp(keyword.slice(0, -1))}\\w*\\b`)
    : new RegExp(`\\b${escapeRegExp(keyword)}\\b`);

const MAXIMA_PATTERNS = MAXIMA_KEYWORDS.map(keywordPattern);
const MEDIA_PATTERNS = MEDIA_KEYWORDS.map(keywordPattern);
const ACTIVO_PATTERNS = ACTIVO_KEYWORDS.map(keywordPattern);

const matchesAny = (text: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(text));

// ---------------------------------------------------------------------------
// Activos seguidos
// ---------------------------------------------------------------------------

/** Normaliza la lista de seguimiento a tickers en mayúsculas. */
function watchlistTickers(watchlist: readonly WatchlistEntry[]): string[] {
  const tickers = new Set<string>();
  for (const entry of watchlist) {
    const ticker = (typeof entry === 'string' ? entry : entry.ticker).trim().toUpperCase();
    if (ticker.length > 0) tickers.add(ticker);
  }
  return [...tickers];
}

/**
 * Tickers de la lista de seguimiento que toca el titular:
 * - los que ya vienen en `item.assets` (los etiqueta la fuente o el
 *   extractor), comparados sin distinguir mayúsculas;
 * - menciones en título o resumen: el ticker en mayúsculas como palabra
 *   completa ('AAPL sube') o como cashtag ('$aapl'). Los tickers de una
 *   letra solo cuentan como cashtag: 'T' suelto es demasiado ruido.
 */
export function findWatchedAssets(
  item: NewsPriorityInput,
  watchlist: readonly WatchlistEntry[],
): string[] {
  const tickers = watchlistTickers(watchlist);
  if (tickers.length === 0) return [];
  const watched = new Set(tickers);
  const found = new Set<string>();
  for (const asset of item.assets ?? []) {
    const ticker = asset.trim().toUpperCase();
    if (watched.has(ticker)) found.add(ticker);
  }
  const text = `${item.title} ${item.summary ?? ''}`;
  for (const ticker of tickers) {
    const escaped = escapeRegExp(ticker);
    const cashtag = new RegExp(`\\$${escaped}\\b`, 'i');
    const bare = ticker.length >= 2 ? new RegExp(`\\b${escaped}\\b`) : null;
    if (cashtag.test(text) || (bare !== null && bare.test(text))) found.add(ticker);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

/**
 * Prioridad del titular según la sección 6. Precedencia: 'maxima' manda
 * sobre todo; 'activo' exige activo seguido + categoría por activo y gana
 * a 'media' (lo que el usuario sigue le interesa más que el sector);
 * 'media' cubre el impacto sectorial; lo demás es 'baja'.
 */
export function classifyNews(
  item: NewsPriorityInput,
  fuentes: readonly PrioritySourceRef[],
  watchlist: readonly WatchlistEntry[],
): NewsPriority {
  const text = normalizeText(`${item.title} ${item.summary ?? ''}`);
  if (matchesAny(text, MAXIMA_PATTERNS)) return 'maxima';
  const watched = findWatchedAssets(item, watchlist);
  if (watched.length > 0) {
    if (matchesAny(text, ACTIVO_PATTERNS)) return 'activo';
    // Un comunicado oficial (8-K, Form 4, hecho relevante…) sobre un
    // activo seguido es noticia por activo aunque el titular sea escueto.
    if (fuentes.some((fuente) => fuente.kind === 'oficial')) return 'activo';
  }
  if (matchesAny(text, MEDIA_PATTERNS)) return 'media';
  return 'baja';
}

/**
 * true solo si alguna fuente es 'oficial' o 'agencia'. Una noticia que
 * solo viene de redes sociales —o solo de prensa— nunca se confirma.
 */
export function isConfirmed(fuentes: readonly PrioritySourceRef[]): boolean {
  return fuentes.some(
    (fuente) => fuente.reliability === 'oficial' || fuente.reliability === 'agencia',
  );
}

/**
 * Regla del aviso de noticia crítica: prioridad 'maxima', o 'activo'
 * (activo seguido), siempre que alguna fuente no sea de redes. Lo que solo
 * viene de redes jamás es crítico, aunque su titular parezca de máxima.
 */
export function isCritical(
  item: NewsPriorityInput,
  fuentes: readonly PrioritySourceRef[],
  watchlist: readonly WatchlistEntry[],
): boolean {
  const priority = classifyNews(item, fuentes, watchlist);
  if (priority !== 'maxima' && priority !== 'activo') return false;
  return fuentes.some((fuente) => fuente.reliability !== 'redes');
}
