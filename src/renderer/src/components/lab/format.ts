/** Formatos del laboratorio: una sola convención de cifras en toda la pantalla. */

// La lib de TS de este proyecto aún tipa useGrouping como booleano; el
// motor (Chromium/Node) admite 'always' desde Intl.NumberFormat v3.
const ALWAYS = 'always' as unknown as boolean;

const pctFmt = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const moneyFmt = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
  // es-ES no agrupa los números de cuatro cifras: «9947» junto a «10.000»
  // rompería la columna. Siempre con separador.
  useGrouping: ALWAYS,
});
const priceFmt = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: ALWAYS,
});
const dateFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const longDateFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Fracción → «+4,2 %» (con signo explícito). */
export function signedPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const pct = value * 100;
  const sign = pct > 0.05 ? '+' : pct < -0.05 ? '−' : '';
  return `${sign}${pctFmt.format(Math.abs(pct))} %`;
}

/** Fracción → «4,2 %» sin signo. */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${pctFmt.format(value * 100)} %`;
}

export function money(value: number): string {
  return moneyFmt.format(value);
}

export function signedMoney(value: number): string {
  const sign = value > 0.5 ? '+' : value < -0.5 ? '−' : '';
  return `${sign}${moneyFmt.format(Math.abs(value))}`;
}

export function price(value: number): string {
  return priceFmt.format(value);
}

const parse = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);

export function shortDate(iso: string): string {
  return dateFmt.format(parse(iso)).replace('.', '');
}

const whenFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Madrid',
});

/** Fecha con hora de Madrid si el ISO la trae («24 nov, 14:00»); si no, solo el día. */
export function when(iso: string): string {
  return iso.includes('T') ? whenFmt.format(new Date(iso)).replace('.', '') : shortDate(iso);
}

/** ¿Es una prueba de 1 hora? (su inicio lleva hora). */
export const isHourlyStart = (startDate: string): boolean => startDate.includes('T');

export function longDate(iso: string): string {
  return longDateFmt.format(parse(iso)).replace('.', '');
}

/** Tono semántico de una cifra: sube, baja o neutra. */
export function tone(value: number | null | undefined): 'up' | 'down' | 'flat' {
  if (value === null || value === undefined || Math.abs(value) < 0.0005) return 'flat';
  return value > 0 ? 'up' : 'down';
}

export const ORDER_LABEL = {
  buy: 'Comprar',
  sell: 'Vender',
  short: 'Abrir corto',
  cover: 'Cerrar corto',
} as const;

export const EXIT_LABEL: Record<string, string> = {
  signal: 'Señal de salida',
  stop: 'Stop',
  target: 'Objetivo',
  delisted: 'Dejó de cotizar',
  'end-of-data': 'Fin de datos',
};
