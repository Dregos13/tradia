/**
 * Patrones de velas diarias para la Mesa.
 *
 * Funciones puras sobre velas ordenadas por fecha. Se evalúa la última
 * vela (la sesión más reciente) y algunos eventos recientes (cruces de
 * medias en las últimas sesiones). Cada patrón trae una explicación en
 * lenguaje llano y una idea lista para el Laboratorio, que la convierte
 * en reglas exactas y la prueba con el histórico: un patrón es una
 * hipótesis, nunca una predicción.
 */
import { atr, rsi, sma } from './indicators';

export interface PatternCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export const PATTERN_IDS = [
  'ruptura-alcista',
  'ruptura-bajista',
  'envolvente-alcista',
  'envolvente-bajista',
  'vela-interior',
  'hueco-alcista',
  'hueco-bajista',
  'cruce-dorado',
  'cruce-muerte',
  'rsi-sobreventa',
  'rsi-sobrecompra',
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export type PatternTone = 'alcista' | 'bajista' | 'neutral';

export interface DetectedPattern {
  id: PatternId;
  /** Nombre corto («Rompe máximos de 20 días»). */
  label: string;
  tone: PatternTone;
  /** Fecha de la vela en la que aparece. */
  date: string;
  /** Qué ha pasado, en una frase y con cifras. */
  explanation: string;
  /** Idea para el Laboratorio, escrita como la escribiría el usuario. */
  idea: string;
}

/** Contexto de tendencia del activo al último cierre. */
export interface TrendContext {
  /** Cambio del último cierre frente al anterior, en fracción. */
  change: number | null;
  /** Cambio en 20 sesiones, en fracción. */
  change20: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  rsi14: number | null;
  /** ATR(14) como fracción del precio: volatilidad diaria típica. */
  atrPct: number | null;
  /** Resumen en palabras: «Tendencia alcista», «Lateral»… */
  label: string;
  tone: PatternTone;
}

export interface MarketReading {
  trend: TrendContext;
  patterns: DetectedPattern[];
}

/** Sesiones hacia atrás en las que un cruce de medias sigue siendo «reciente». */
export const RECENT_CROSS_SESSIONS = 5;
export const BREAKOUT_LOOKBACK = 20;

const pct = (value: number) => {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value * 100)
    .toFixed(1)
    .replace('.', ',')} %`;
};

const num = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
  useGrouping: 'always' as unknown as boolean,
});
const fmt = (value: number) => num.format(value);

const isGreen = (c: PatternCandle) => c.close > c.open;
const isRed = (c: PatternCandle) => c.close < c.open;

function trendOf(candles: readonly PatternCandle[]): TrendContext {
  const n = candles.length;
  const last = candles[n - 1];
  const prev = candles[n - 2];
  const s50 = sma(candles, 50)[n - 1] ?? null;
  const s200 = sma(candles, 200)[n - 1] ?? null;
  const r = rsi(candles, 14)[n - 1] ?? null;
  const a = atr(candles, 14)[n - 1] ?? null;
  const back20 = candles[n - 21];
  const aboveSma50 = last && s50 !== null ? last.close > s50 : null;
  const aboveSma200 = last && s200 !== null ? last.close > s200 : null;
  let label = 'Sin datos suficientes';
  let tone: PatternTone = 'neutral';
  if (aboveSma50 !== null && aboveSma200 !== null) {
    if (aboveSma50 && aboveSma200) {
      label = 'Tendencia alcista';
      tone = 'alcista';
    } else if (!aboveSma50 && !aboveSma200) {
      label = 'Tendencia bajista';
      tone = 'bajista';
    } else {
      label = aboveSma200 ? 'Corrigiendo en tendencia alcista' : 'Rebotando en tendencia bajista';
    }
  } else if (aboveSma50 !== null) {
    label = aboveSma50 ? 'Sobre su media de 50' : 'Bajo su media de 50';
    tone = aboveSma50 ? 'alcista' : 'bajista';
  }
  return {
    change: last && prev ? last.close / prev.close - 1 : null,
    change20: last && back20 ? last.close / back20.close - 1 : null,
    aboveSma50,
    aboveSma200,
    rsi14: r,
    atrPct: last && a !== null ? a / last.close : null,
    label,
    tone,
  };
}

/**
 * Lee el último cierre de `candles` (ascendentes por fecha): tendencia y
 * patrones presentes. `name` es el nombre legible para las ideas.
 */
export function readMarket(
  candles: readonly PatternCandle[],
  asset: { ticker: string; name: string },
): MarketReading {
  const trend = trendOf(candles);
  const n = candles.length;
  const patterns: DetectedPattern[] = [];
  if (n < 2) return { trend, patterns };
  const last = candles[n - 1]!;
  const prev = candles[n - 2]!;
  const who = `${asset.name} (${asset.ticker})`;

  // Rupturas del canal de 20 sesiones anteriores (sin contar la actual).
  if (n > BREAKOUT_LOOKBACK) {
    const window = candles.slice(n - 1 - BREAKOUT_LOOKBACK, n - 1);
    const high = Math.max(...window.map((c) => c.high));
    const low = Math.min(...window.map((c) => c.low));
    if (last.close > high) {
      patterns.push({
        id: 'ruptura-alcista',
        label: 'Rompe máximos de 20 días',
        tone: 'alcista',
        date: last.date,
        explanation: `Cerró en ${fmt(last.close)}, por encima del máximo de las 20 sesiones anteriores (${fmt(high)}).`,
        idea: `Comprar ${who} cuando cierre por encima del máximo de las 20 sesiones anteriores y salir si cierra por debajo del mínimo de 10 sesiones, con stop por volatilidad`,
      });
    } else if (last.close < low) {
      patterns.push({
        id: 'ruptura-bajista',
        label: 'Rompe mínimos de 20 días',
        tone: 'bajista',
        date: last.date,
        explanation: `Cerró en ${fmt(last.close)}, por debajo del mínimo de las 20 sesiones anteriores (${fmt(low)}).`,
        idea: `Vender en corto ${who} cuando cierre por debajo del mínimo de las 20 sesiones anteriores y cubrir si cierra por encima del máximo de 10 sesiones, con stop por volatilidad`,
      });
    }
  }

  // Velas envolventes: el cuerpo de hoy cubre el de ayer en sentido contrario.
  const bodyTop = (c: PatternCandle) => Math.max(c.open, c.close);
  const bodyBottom = (c: PatternCandle) => Math.min(c.open, c.close);
  if (
    isRed(prev) &&
    isGreen(last) &&
    bodyTop(last) >= bodyTop(prev) &&
    bodyBottom(last) <= bodyBottom(prev)
  ) {
    patterns.push({
      id: 'envolvente-alcista',
      label: 'Envolvente alcista',
      tone: 'alcista',
      date: last.date,
      explanation:
        'Una vela verde cuyo cuerpo cubre entero el de la vela roja anterior: los compradores recuperaron todo lo perdido.',
      idea: `Comprar ${who} tras una vela envolvente alcista (cierre de hoy por encima de la apertura de ayer y apertura por debajo del cierre de ayer) si está por encima de su media de 200; vender a los 5 días o con stop por volatilidad`,
    });
  } else if (
    isGreen(prev) &&
    isRed(last) &&
    bodyTop(last) >= bodyTop(prev) &&
    bodyBottom(last) <= bodyBottom(prev)
  ) {
    patterns.push({
      id: 'envolvente-bajista',
      label: 'Envolvente bajista',
      tone: 'bajista',
      date: last.date,
      explanation:
        'Una vela roja cuyo cuerpo cubre entero el de la vela verde anterior: los vendedores borraron la subida.',
      idea: `Salir o ponerse corto en ${who} tras una vela envolvente bajista si está por debajo de su media de 50, con stop por encima del máximo reciente`,
    });
  }

  // Vela interior: rango dentro del de ayer, el mercado se comprime.
  if (last.high < prev.high && last.low > prev.low) {
    patterns.push({
      id: 'vela-interior',
      label: 'Vela interior',
      tone: 'neutral',
      date: last.date,
      explanation: `Todo el rango de hoy cabe dentro del de ayer (${fmt(prev.low)}–${fmt(prev.high)}): compresión que suele preceder a un movimiento.`,
      idea: `Comprar ${who} si tras una vela interior el precio cierra por encima del máximo de la vela madre, y vender en corto si cierra por debajo de su mínimo, con stop en el extremo contrario`,
    });
  }

  // Huecos de apertura.
  if (last.open > prev.high) {
    patterns.push({
      id: 'hueco-alcista',
      label: 'Hueco al alza',
      tone: 'alcista',
      date: last.date,
      explanation: `Abrió en ${fmt(last.open)}, por encima del máximo de ayer (${fmt(prev.high)}).`,
      idea: `Comprar ${who} cuando abra con hueco al alza sobre el máximo del día anterior y el cierre confirme por encima de ese máximo; salir si el hueco se cierra`,
    });
  } else if (last.open < prev.low) {
    patterns.push({
      id: 'hueco-bajista',
      label: 'Hueco a la baja',
      tone: 'bajista',
      date: last.date,
      explanation: `Abrió en ${fmt(last.open)}, por debajo del mínimo de ayer (${fmt(prev.low)}).`,
      idea: `Vender en corto ${who} cuando abra con hueco a la baja bajo el mínimo del día anterior y cierre por debajo; cubrir si el hueco se cierra`,
    });
  }

  // Cruces de las medias de 50 y 200 en las últimas sesiones.
  const s50 = sma(candles, 50);
  const s200 = sma(candles, 200);
  for (let i = n - 1; i >= Math.max(1, n - RECENT_CROSS_SESSIONS); i--) {
    const a0 = s50[i - 1];
    const b0 = s200[i - 1];
    const a1 = s50[i];
    const b1 = s200[i];
    if (a0 == null || b0 == null || a1 == null || b1 == null) break;
    if (a0 <= b0 && a1 > b1) {
      patterns.push({
        id: 'cruce-dorado',
        label: 'Cruce dorado',
        tone: 'alcista',
        date: candles[i]!.date,
        explanation:
          'La media de 50 sesiones acaba de cruzar por encima de la de 200: cambio de tendencia a largo plazo.',
        idea: `Comprar ${who} cuando la media de 50 cruce por encima de la de 200 y vender cuando cruce por debajo, con stop por volatilidad`,
      });
      break;
    }
    if (a0 >= b0 && a1 < b1) {
      patterns.push({
        id: 'cruce-muerte',
        label: 'Cruce de la muerte',
        tone: 'bajista',
        date: candles[i]!.date,
        explanation:
          'La media de 50 sesiones acaba de cruzar por debajo de la de 200: la tendencia de fondo se debilita.',
        idea: `Vender en corto ${who} cuando la media de 50 cruce por debajo de la de 200 y cubrir cuando vuelva a cruzar por encima`,
      });
      break;
    }
  }

  // RSI extremo.
  if (trend.rsi14 !== null && trend.rsi14 < 30) {
    patterns.push({
      id: 'rsi-sobreventa',
      label: 'Sobreventa (RSI < 30)',
      tone: 'alcista',
      date: last.date,
      explanation: `El RSI de 14 sesiones está en ${trend.rsi14.toFixed(0)}: ha caído mucho y rápido.`,
      idea: `Comprar ${who} cuando el RSI de 14 baje de 30 si sigue por encima de su media de 200, y vender cuando el RSI supere 55`,
    });
  } else if (trend.rsi14 !== null && trend.rsi14 > 70) {
    patterns.push({
      id: 'rsi-sobrecompra',
      label: 'Sobrecompra (RSI > 70)',
      tone: 'bajista',
      date: last.date,
      explanation: `El RSI de 14 sesiones está en ${trend.rsi14.toFixed(0)}: ha subido mucho y rápido.`,
      idea: `Seguir la fuerza de ${who}: comprar cuando el RSI de 14 supere 70 con el precio sobre la media de 50 y vender cuando el RSI baje de 50`,
    });
  }

  return { trend, patterns };
}

/** Texto corto del cambio para etiquetas («+1,2 %»). */
export const formatChange = (value: number | null): string => (value === null ? '—' : pct(value));
