/**
 * Limpieza de un lote de velas OHLCV — funciones puras.
 *
 * `cleanBars` recibe las velas crudas del proveedor, las acciones
 * corporativas del rango y el calendario de sesiones, y devuelve las velas
 * ajustadas más un `QualityReport` y la `BatchVersion` del lote. No lee
 * reloj, disco ni red: toda la entrada llega por parámetros.
 *
 * Pipeline:
 * 1. Deduplicado por fecha — se conserva la última fila recibida.
 * 2. Validación estructural — fecha inválida, número no finito,
 *    `high < low`, precio ≤ 0 o volumen < 0 descartan la vela ('dropped').
 * 3. Huecos y velas fuera de sesión frente a `calendar.expectedSessionsBetween`.
 * 4. Saltos de rentabilidad > `outlierSigma` desviaciones (def. 8) sin
 *    acción corporativa ese día — la vela se conserva marcada ('flagged'),
 *    porque un salto así también puede ser real.
 * 5. Ajuste hacia atrás por splits y dividendos: el precio más reciente
 *    queda igual y cada acción con fecha ex posterior multiplica los
 *    precios anteriores — split por 1/factor (volumen por el factor) y
 *    dividendo por (1 - D / cierre crudo de la sesión previa), la
 *    convención que también aplica el adaptador simulado. Los precios
 *    crudos se conservan intactos.
 * 6. Versión del lote: hash SHA-256 del contenido normalizado; se conserva
 *    si el lote reprocesado es idéntico al guardado.
 */
import {
  ISO_DATE_PATTERN,
  type Bar,
  type CorporateAction,
  type SessionDate,
} from '../providers/types';
import type {
  AdjustedBar,
  Anomaly,
  AnomalyKind,
  BatchVersion,
  CleanBarsInput,
  CleanBarsOptions,
  CleanBarsResult,
  QualityReport,
} from './types';
import { nextBatchVersion } from './version';

/** Umbral por defecto del salto de rentabilidad, en desviaciones típicas. */
export const DEFAULT_OUTLIER_SIGMA = 8;
/** Mínimo de rentabilidades diarias para que el contraste σ tenga sentido. */
export const DEFAULT_MIN_OUTLIER_RETURNS = 10;
/**
 * Si el resto de la serie es plana (σ = 0) cualquier desviación superaría el
 * umbral; se exige al menos un salto absoluto del 50 % para marcarla.
 */
const FLAT_SERIES_JUMP = 0.5;
/** Decimales de los precios ajustados (más que el crudo, que suele venir a 2). */
const ADJUSTED_DECIMALS = 6;

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

/** Problemas estructurales de una vela; cualquiera la descarta del lote. */
function structuralProblems(bar: Bar): Array<{ kind: AnomalyKind; detail: string }> {
  const problems: Array<{ kind: AnomalyKind; detail: string }> = [];
  // Date.parse rechaza fechas imposibles como '2020-02-30' (Invalid Date);
  // la comprobación de ida y vuelta las descarta sin lanzar.
  const parsed = new Date(`${bar.date}T00:00:00.000Z`);
  const isRealDate =
    ISO_DATE_PATTERN.test(bar.date) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === bar.date;
  if (!isRealDate) {
    problems.push({ kind: 'bad-date', detail: `fecha inválida: ${JSON.stringify(bar.date)}` });
    return problems; // Sin fecha válida el resto de comprobaciones no aportan.
  }
  const numericFields = {
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    adjClose: bar.adjClose,
    splitFactor: bar.splitFactor,
    dividend: bar.dividend,
  };
  for (const [field, value] of Object.entries(numericFields)) {
    if (!Number.isFinite(value)) {
      problems.push({ kind: 'non-numeric', detail: `${field} no es finito: ${String(value)}` });
    }
  }
  if (Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high < bar.low) {
    problems.push({
      kind: 'high-below-low',
      detail: `high (${bar.high}) menor que low (${bar.low})`,
    });
  }
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    if (Number.isFinite(bar[field]) && bar[field] <= 0) {
      problems.push({
        kind: 'non-positive-price',
        detail: `${field} es ${bar[field]} (se esperaba > 0)`,
      });
      break; // Un solo aviso por vela basta para explicar el descarte.
    }
  }
  if (Number.isFinite(bar.volume) && bar.volume < 0) {
    problems.push({ kind: 'negative-volume', detail: `volume es ${bar.volume}` });
  }
  return problems;
}

/** Acciones con valores utilizables; las inválidas se anotan en `warnings`. */
function usableActions(
  actions: readonly CorporateAction[],
  report: QualityReport,
): CorporateAction[] {
  const out: CorporateAction[] = [];
  for (const action of actions) {
    const ok =
      ISO_DATE_PATTERN.test(action.date) &&
      Number.isFinite(action.value) &&
      (action.kind === 'split' ? action.value > 0 : action.value >= 0) &&
      (action.kind === 'split' || action.kind === 'dividend');
    if (ok) out.push(action);
    else {
      report.warnings.push(
        `acción corporativa ignorada (${action.kind} ${action.date}, valor ${String(action.value)})`,
      );
    }
  }
  return out;
}

/**
 * Deriva las acciones corporativas de `splitFactor`/`dividend` de cada vela
 * —la forma en que las entregan Tiingo y el adaptador simulado— cuando el
 * llamador no las pasa aparte.
 */
export function deriveCorporateActions(ticker: string, bars: readonly Bar[]): CorporateAction[] {
  const actions: CorporateAction[] = [];
  for (const bar of bars) {
    if (bar.splitFactor !== 1) {
      actions.push({ ticker, date: bar.date, kind: 'split', value: bar.splitFactor });
    }
    if (bar.dividend !== 0) {
      actions.push({ ticker, date: bar.date, kind: 'dividend', value: bar.dividend });
    }
  }
  return actions.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/**
 * Saltos de rentabilidad anómalos sobre cierres crudos, con media y σ
 * calculadas dejando fuera el propio punto (leave-one-out), así un único
 * salto no infla la σ que lo mediría. Las velas con acción corporativa en
 * su fecha están exentas: el split explica el salto.
 */
function findReturnOutliers(
  bars: readonly Bar[],
  actionDates: ReadonlySet<SessionDate>,
  sigma: number,
  minReturns: number,
): Anomaly[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push(bars[i]!.close / bars[i - 1]!.close - 1);
  }
  const n = returns.length;
  if (n < Math.max(3, minReturns)) return [];

  const sum = returns.reduce((a, r) => a + r, 0);
  const sum2 = returns.reduce((a, r) => a + r * r, 0);
  const anomalies: Anomaly[] = [];
  for (let i = 0; i < n; i++) {
    const r = returns[i]!;
    const others = n - 1;
    const mean = (sum - r) / others;
    const variance = (sum2 - r * r) / others - mean * mean;
    const std = Math.sqrt(Math.max(0, variance));
    const deviation = Math.abs(r - mean);
    const isOutlier = std > 0 ? deviation > sigma * std : deviation > FLAT_SERIES_JUMP;
    const date = bars[i + 1]!.date;
    if (isOutlier && !actionDates.has(date)) {
      anomalies.push({
        date,
        kind: 'return-outlier',
        detail: `rentabilidad diaria ${pct(r)} a ${(deviation / Math.max(std, 1e-12)).toFixed(1)}σ sin acción corporativa`,
        action: 'flagged',
      });
    }
  }
  return anomalies;
}

/** Ajuste hacia atrás por splits y dividendos; los precios crudos se conservan. */
function applyAdjustments(
  bars: readonly Bar[],
  actions: readonly CorporateAction[],
  report: QualityReport,
): AdjustedBar[] {
  const sorted = [...actions].sort((a, b) => a.date.localeCompare(b.date));

  // Factor de precio de cada acción, calculado una vez. Para el dividendo
  // hace falta el cierre crudo de la última vela anterior a su fecha ex.
  const priceFactorOfAction = sorted.map((action) => {
    if (action.kind === 'split') return 1 / action.value;
    let prevClose: number | null = null;
    for (const bar of bars) {
      if (bar.date >= action.date) break;
      prevClose = bar.close;
    }
    if (prevClose === null || prevClose <= 0) {
      report.warnings.push(
        `dividendo del ${action.date} (${action.value}) sin cierre previo; no se aplica`,
      );
      return 1;
    }
    const factor = 1 - action.value / prevClose;
    if (factor < 0) {
      report.warnings.push(
        `dividendo del ${action.date} (${action.value}) mayor que el cierre previo (${prevClose}); factor fijado a 0`,
      );
    }
    return Math.max(0, factor);
  });

  return bars.map((bar) => {
    let priceFactor = 1;
    let volumeFactor = 1;
    for (let i = 0; i < sorted.length; i++) {
      const action = sorted[i]!;
      if (action.date <= bar.date) continue;
      priceFactor *= priceFactorOfAction[i]!;
      if (action.kind === 'split') volumeFactor *= action.value;
    }
    return {
      ...bar,
      adjOpen: round(bar.open * priceFactor, ADJUSTED_DECIMALS),
      adjHigh: round(bar.high * priceFactor, ADJUSTED_DECIMALS),
      adjLow: round(bar.low * priceFactor, ADJUSTED_DECIMALS),
      adjClose: round(bar.close * priceFactor, ADJUSTED_DECIMALS),
      adjVolume: Math.round(bar.volume * volumeFactor),
    };
  });
}

const sortAnomalies = (a: Anomaly, b: Anomaly): number =>
  a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind);

/**
 * Limpia un lote de velas crudas de un activo. Ver la cabecera del módulo
 * para el detalle de cada paso.
 */
export function cleanBars(input: CleanBarsInput, options: CleanBarsOptions = {}): CleanBarsResult {
  const ticker = input.ticker.trim().toUpperCase();
  const report: QualityReport = {
    ticker,
    received: input.bars.length,
    kept: 0,
    duplicates: [],
    gaps: [],
    anomalies: [],
    warnings: [],
    reliable: false,
  };

  // 1. Deduplicado por fecha: se conserva la última fila recibida.
  const byDate = new Map<SessionDate, Bar>();
  const duplicated = new Set<SessionDate>();
  for (const bar of input.bars) {
    if (byDate.has(bar.date)) duplicated.add(bar.date);
    byDate.set(bar.date, bar);
  }
  report.duplicates = [...duplicated].sort();
  const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 2. Validación estructural: las velas insalvables se descartan.
  const valid: Bar[] = [];
  for (const bar of sorted) {
    const problems = structuralProblems(bar);
    if (problems.length === 0) {
      valid.push(bar);
      continue;
    }
    for (const problem of problems) {
      report.anomalies.push({
        date: bar.date,
        kind: problem.kind,
        detail: problem.detail,
        action: 'dropped',
      });
    }
  }

  // 3. Acciones corporativas efectivas (declaradas o derivadas de las velas).
  const actions = usableActions(
    input.corporateActions ?? deriveCorporateActions(ticker, valid),
    report,
  );
  const actionDates = new Set(actions.map((a) => a.date));

  // 4. Huecos y velas fuera de sesión frente al calendario. El rango lo
  // marcan las velas válidas: una fecha malformada (ya descartada) rompería
  // el parseo de `expectedSessionsBetween` del calendario real.
  if (input.calendar && valid.length > 0) {
    const sessions = input.calendar.expectedSessionsBetween(
      valid[0]!.date,
      valid[valid.length - 1]!.date,
    );
    const expected = new Set(sessions.map((s) => s.date));
    const have = new Set(valid.map((b) => b.date));
    report.gaps = [...expected].filter((date) => !have.has(date)).sort();
    for (const bar of valid) {
      if (!expected.has(bar.date)) {
        report.anomalies.push({
          date: bar.date,
          kind: 'non-session',
          detail: 'vela en un día que el calendario no considera sesión',
          action: 'flagged',
        });
      }
    }
  }

  // 5. Saltos de rentabilidad anómalos sin acción corporativa.
  report.anomalies.push(
    ...findReturnOutliers(
      valid,
      actionDates,
      options.outlierSigma ?? DEFAULT_OUTLIER_SIGMA,
      options.minOutlierReturns ?? DEFAULT_MIN_OUTLIER_RETURNS,
    ),
  );

  // 6. Ajuste hacia atrás y versión del lote.
  const bars = applyAdjustments(valid, actions, report);
  const batch: BatchVersion = nextBatchVersion(bars, options.previousBatch ?? null);

  report.anomalies.sort(sortAnomalies);
  report.kept = bars.length;
  report.reliable =
    report.gaps.length === 0 && report.anomalies.length === 0 && report.warnings.length === 0;
  return { bars, report, batch };
}
