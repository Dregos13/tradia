/**
 * Límites de pérdida y de exposición de la cartera — Fase 3 (motor de
 * riesgo).
 *
 * Funciones puras: con la señal, el tamaño propuesto (ya calculado por
 * las reglas por operación a partir de la distancia al stop) y una
 * `PortfolioSnapshot`, `checkPortfolioLimits` devuelve los motivos de
 * veto, uno por regla incumplida. Lista vacía = todos los límites en
 * regla.
 *
 * Los códigos devueltos son estables (`VetoReasonCode` del contrato) y
 * cada motivo lleva los valores que lo explican (límite y valor real) en
 * `details`, tal como se guardan en `risk_vetoes.detalles`.
 *
 * Decisiones de regla:
 * - Las pérdidas por periodo y el drawdown vetan al ALCANZAR el límite
 *   (≥); las exposiciones, la correlación, el apalancamiento y la
 *   liquidez vetan al SUPERARLO (>).
 * - MAX_POSITIONS cuenta las abiertas actuales: con el máximo ya
 *   alcanzado no cabe una posición más.
 * - La correlación se evalúa «alineada» por dirección (ver
 *   `alignedCorrelation`); sin rendimientos suficientes no hay veto, la
 *   regla no decide sin evidencia.
 * - La liquidez es la excepción que cierra en falso: sin volumen medio
 *   de 20 días no se puede verificar el límite y la señal queda vetada
 *   (primero proteger el capital, docs/alcance.md §5).
 * - El orden de los motivos es fijo (el de `VETO_REASON_CODES` de los
 *   límites de cartera) para que el registro sea estable.
 */

import {
  LIQUIDITY_AVG_VOLUME_DAYS,
  VETO_REASON_MESSAGES,
  type RiskDecisionReason,
  type RiskLimits,
  type SignalIntent,
  type VetoReasonCode,
} from '../../shared/risk';
import {
  UNKNOWN_SECTOR,
  UNIVERSE_CURRENCY,
  alignedCorrelation,
  drawdownPct,
  grossNotional,
  lossPctSince,
  pctOfEquity,
  periodStartUtc,
  positionCurrency,
  positionSector,
  resolveInstrument,
  type LossPeriod,
  type PortfolioPosition,
  type PortfolioSnapshot,
} from './portfolio';

/** Redondea a 4 decimales los valores que viajan en `details`. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function veto(code: VetoReasonCode, details: Record<string, number | string>): RiskDecisionReason {
  return { code, message: VETO_REASON_MESSAGES[code], details };
}

/** Nominal bruto que ocuparía la posición candidata. */
function candidateNotional(signal: SignalIntent, proposedSize: number): number {
  const notional = proposedSize * signal.entry;
  return Number.isFinite(notional) ? Math.abs(notional) : 0;
}

// ---------------------------------------------------------------------------
// Límites de pérdida por periodo y drawdown
// ---------------------------------------------------------------------------

const LOSS_LIMITS: { period: LossPeriod; code: VetoReasonCode; limitKey: keyof RiskLimits }[] = [
  { period: 'day', code: 'DAILY_LOSS', limitKey: 'maxDailyLossPct' },
  { period: 'week', code: 'WEEKLY_LOSS', limitKey: 'maxWeeklyLossPct' },
  { period: 'month', code: 'MONTHLY_LOSS', limitKey: 'maxMonthlyLossPct' },
];

function checkLossLimits(snapshot: PortfolioSnapshot, limits: RiskLimits): RiskDecisionReason[] {
  const vetoes: RiskDecisionReason[] = [];
  for (const { period, code, limitKey } of LOSS_LIMITS) {
    const start = periodStartUtc(snapshot.now, period);
    if (start === null) continue;
    const lossPct = lossPctSince(snapshot.equityHistory, snapshot.equity, start.toISOString());
    const limit = limits[limitKey] as number;
    if (lossPct >= limit) {
      vetoes.push(
        veto(code, {
          limite: limit,
          perdida: round4(lossPct),
          desde: start.toISOString(),
        }),
      );
    }
  }
  const dd = drawdownPct(snapshot.equityHistory, snapshot.equity);
  if (dd >= limits.maxDrawdownPct) {
    vetoes.push(veto('MAX_DRAWDOWN', { limite: limits.maxDrawdownPct, drawdown: round4(dd) }));
  }
  return vetoes;
}

// ---------------------------------------------------------------------------
// Límites de exposición
// ---------------------------------------------------------------------------

function checkMaxPositions(snapshot: PortfolioSnapshot, limits: RiskLimits): RiskDecisionReason[] {
  if (snapshot.positions.length < limits.maxOpenPositions) return [];
  return [
    veto('MAX_POSITIONS', {
      limite: limits.maxOpenPositions,
      abiertas: snapshot.positions.length,
    }),
  ];
}

function checkAssetExposure(
  signal: SignalIntent,
  notional: number,
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
): RiskDecisionReason[] {
  const sameAsset = snapshot.positions.filter((p) => p.ticker === signal.ticker);
  const exposurePct = pctOfEquity(grossNotional(sameAsset) + notional, snapshot.equity);
  if (exposurePct <= limits.maxAssetExposurePct) return [];
  return [
    veto('ASSET_EXPOSURE', {
      limite: limits.maxAssetExposurePct,
      exposicion: round4(exposurePct),
      ticker: signal.ticker,
    }),
  ];
}

function checkSectorExposure(
  signal: SignalIntent,
  notional: number,
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
): RiskDecisionReason[] {
  const sector = resolveInstrument(snapshot, signal.ticker).sector ?? UNKNOWN_SECTOR;
  const sameSector = snapshot.positions.filter((p) => positionSector(snapshot, p) === sector);
  const exposurePct = pctOfEquity(grossNotional(sameSector) + notional, snapshot.equity);
  if (exposurePct <= limits.maxSectorExposurePct) return [];
  return [
    veto('SECTOR_EXPOSURE', {
      limite: limits.maxSectorExposurePct,
      exposicion: round4(exposurePct),
      sector,
    }),
  ];
}

function checkCurrencyExposure(
  signal: SignalIntent,
  notional: number,
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
): RiskDecisionReason[] {
  const currency = resolveInstrument(snapshot, signal.ticker).currency;
  const isForeign = (position: PortfolioPosition) =>
    positionCurrency(snapshot, position) !== UNIVERSE_CURRENCY;
  const current = grossNotional(snapshot.positions.filter(isForeign));
  const candidate = currency === UNIVERSE_CURRENCY ? 0 : notional;
  const exposurePct = pctOfEquity(current + candidate, snapshot.equity);
  if (exposurePct <= limits.maxCurrencyExposurePct) return [];
  return [
    veto('CURRENCY_EXPOSURE', {
      limite: limits.maxCurrencyExposurePct,
      exposicion: round4(exposurePct),
      divisa: currency,
    }),
  ];
}

function checkCorrelation(
  signal: SignalIntent,
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
): RiskDecisionReason[] {
  let worst: { ticker: string; correlation: number } | null = null;
  for (const position of snapshot.positions) {
    const r = alignedCorrelation(snapshot, signal.ticker, signal.direction, position);
    if (r !== null && r > limits.maxCorrelation && (worst === null || r > worst.correlation)) {
      worst = { ticker: position.ticker, correlation: r };
    }
  }
  if (worst === null) return [];
  return [
    veto('CORRELATION', {
      limite: limits.maxCorrelation,
      correlacion: round4(worst.correlation),
      ticker: worst.ticker,
    }),
  ];
}

function checkLeverage(
  notional: number,
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
): RiskDecisionReason[] {
  const gross = grossNotional(snapshot.positions) + notional;
  const leverage = snapshot.equity > 0 ? gross / snapshot.equity : gross > 0 ? Infinity : 0;
  if (leverage <= limits.maxLeverage) return [];
  return [veto('LEVERAGE', { limite: limits.maxLeverage, apalancamiento: round4(leverage) })];
}

function checkLiquidity(
  signal: SignalIntent,
  proposedSize: number,
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
): RiskDecisionReason[] {
  const avgVolume = resolveInstrument(snapshot, signal.ticker).avgDailyVolume20d;
  if (avgVolume === null || !Number.isFinite(avgVolume) || avgVolume <= 0) {
    return [
      veto('LIQUIDITY', {
        ticker: signal.ticker,
        motivo: `volumen medio de ${LIQUIDITY_AVG_VOLUME_DAYS} días desconocido`,
      }),
    ];
  }
  const volumePct = (Math.abs(proposedSize) / avgVolume) * 100;
  if (volumePct <= limits.maxLiquidityPct) return [];
  return [
    veto('LIQUIDITY', {
      limite: limits.maxLiquidityPct,
      porcentaje: round4(volumePct),
      volumenMedio20d: avgVolume,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Evaluación completa
// ---------------------------------------------------------------------------

/**
 * Evalúa los 11 límites de cartera sobre la señal con el tamaño propuesto
 * y devuelve los vetos en orden estable. No decide sobre reglas por
 * operación (stop, ratio, tamaño cero) ni sobre parada o cautela: esas
 * las aplican otros módulos de la pasarela.
 */
export function checkPortfolioLimits(
  signal: SignalIntent,
  proposedSize: number,
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
): RiskDecisionReason[] {
  const notional = candidateNotional(signal, proposedSize);
  return [
    ...checkLossLimits(snapshot, limits),
    ...checkMaxPositions(snapshot, limits),
    ...checkAssetExposure(signal, notional, snapshot, limits),
    ...checkSectorExposure(signal, notional, snapshot, limits),
    ...checkCurrencyExposure(signal, notional, snapshot, limits),
    ...checkCorrelation(signal, snapshot, limits),
    ...checkLeverage(notional, snapshot, limits),
    ...checkLiquidity(signal, proposedSize, snapshot, limits),
  ];
}
