/**
 * Decodificación de entidades HTML en titulares y resúmenes (UXP-05).
 *
 * Algunos feeds (la CNMV, entre otros) escapan dos veces: el parser XML ya
 * deshace la primera capa y el texto llega con «A&amp;P». Aquí se deshace
 * la segunda en una sola pasada, de modo que «&amp;amp;» queda «&amp;» y no
 * «&» (nunca se decodifica dos veces). El resultado es texto plano: el
 * renderer lo pinta como texto, nunca como HTML.
 */

/** Entidades con nombre habituales en titulares de prensa. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  percnt: '%',
  iexcl: '¡',
  iquest: '¿',
  ordf: 'ª',
  ordm: 'º',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  ccedil: 'ç',
  Ccedil: 'Ç',
  agrave: 'à',
  egrave: 'è',
  ograve: 'ò',
  auml: 'ä',
  ouml: 'ö',
  Auml: 'Ä',
  Ouml: 'Ö',
  szlig: 'ß',
};

const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/** Punto de código válido y visible; los de control y los sustitutos no. */
function fromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
  return String.fromCodePoint(code);
}

/**
 * Decodifica entidades con nombre comunes y numéricas (decimales y
 * hexadecimales) en una sola pasada. Lo que no reconoce lo deja tal cual.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_PATTERN, (match, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10)) ?? match;
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? match;
    const named = name !== undefined ? NAMED_ENTITIES[name] : undefined;
    return named ?? match;
  });
}
