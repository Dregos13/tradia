/**
 * Lista de comprobación del dinero real (sección 18 del plan,
 * §4.4 de docs/alcance.md) — evaluadores puros.
 *
 * Aquí vive la regla de cada requisito automático y el cálculo de la
 * evidencia de paper trading (días, operaciones cerradas y desviación
 * relativa frente al backtest). Todo es función pura: el servicio
 * (`service.ts`) les pasa los datos ya recogidos de la base, los
 * servicios vecinos y la evidencia sembrada, y persiste el veredicto en
 * `live_checklist`. Nada de esta lógica puede invocarse desde el
 * renderer: los requisitos automáticos se calculan en el proceso
 * principal.
 */
import type {
  LiveRequirement,
  LiveRequirementState,
} from '../../shared/live';
import type { BrokerOrder } from '../../shared/ipc';
import {
  closedTradesFromOrders,
  nyDateOf,
  type StrategyExpectation,
} from '../broker/deviation';

// ---------------------------------------------------------------------------
// Umbrales fijos (sección 18 y §4.4)
// ---------------------------------------------------------------------------

/** Meses de paper continuo exigidos, en días («79 de 91 días» del diseño). */
export const LIVE_PAPER_MIN_DAYS = 91;
/** Operaciones paper cerradas exigidas (muestra mínima de §4.3). */
export const LIVE_PAPER_MIN_TRADES = 30;
/** Desviación relativa real vs backtest admitida: ±30 % (§4.2 y §4.4). */
export const LIVE_DEVIATION_MAX_PCT = 30;
/** Vigencia de la prueba de parada: los últimos 30 días. */
export const LIVE_KILL_SWITCH_TEST_MAX_DAYS = 30;

/** Estados de ficha que convierten a una estrategia en candidata a real. */
export const LIVE_CANDIDATE_STATUSES = ['paper', 'activa'] as const;

/** Clave de settings donde delivery anota la última prueba externa correcta. */
export const DELIVERY_TEST_EVIDENCE_KEY = 'delivery.lastTestSuccess';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Veredicto de un requisito automático. */
export interface RequirementVerdict {
  state: LiveRequirementState;
  /** Evidencia legible («79 de 91 días · 24 de 30 operaciones · −12 %»). */
  evidence: string | null;
  /** Motivos legibles del incumplimiento (para la lista de live:activate). */
  reasons: string[];
}

const ok = (evidence: string): RequirementVerdict => ({
  state: 'cumplido',
  evidence,
  reasons: [],
});

const pending = (evidence: string | null, reasons: string[]): RequirementVerdict => ({
  state: 'pendiente',
  evidence,
  reasons,
});

const review = (evidence: string, reasons: string[]): RequirementVerdict => ({
  state: 'revisar',
  evidence,
  reasons,
});

/** 'YYYY-MM-DD' → fecha legible '10 oct 2026' (sin depender del locale). */
const MESES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

export const formatLiveDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const fmtSignedPct = (value: number): string =>
  `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1).replace('.', ',')} %`;

const daysBetween = (fromMs: number, toMs: number): number =>
  Math.floor((toMs - fromMs) / 86_400_000);

// ---------------------------------------------------------------------------
// 'validacion-fuera-muestra': prueba final intacta de cada candidata
// ---------------------------------------------------------------------------

/** Cobertura de la prueba final sobre las estrategias candidatas. */
export interface FinalTestCoverage {
  /** Estrategias candidatas (estado 'paper' o 'activa') con su versión. */
  total: number;
  /** De ellas, cuántas tienen un run 'prueba-final' en la versión vigente. */
  done: number;
  /** Nombres de las candidatas sin prueba final (para la evidencia). */
  missing: string[];
}

export function evaluateFinalTest(
  coverage: FinalTestCoverage,
  seededDone: boolean,
): RequirementVerdict {
  if (seededDone) {
    return ok('Prueba final registrada (evidencia sembrada).');
  }
  if (coverage.total === 0) {
    return pending(null, ['No hay estrategias candidatas (en paper o activas) para validar.']);
  }
  if (coverage.done < coverage.total) {
    const missing =
      coverage.missing.length > 0 ? ` Falta: ${coverage.missing.join(', ')}.` : '';
    return pending(
      `${coverage.done} de ${coverage.total} estrategias candidatas con prueba final.`,
      [
        `Solo ${coverage.done} de ${coverage.total} estrategias candidatas tienen ` +
          `la prueba final ejecutada.${missing}`,
      ],
    );
  }
  return ok(`${coverage.done} de ${coverage.total} estrategias candidatas · prueba final intacta.`);
}

// ---------------------------------------------------------------------------
// 'paper-continuo': ≥ 91 días, ≥ 30 operaciones, desviación dentro de ±30 %
// ---------------------------------------------------------------------------

/** Medidas del paper trading real, calculadas en el proceso principal. */
export interface PaperProgressStats {
  /** Días entre la primera y la última orden paper ejecutada. */
  daysActive: number;
  /** Operaciones cerradas (par entrada/salida ejecutado). */
  closedTrades: number;
  /**
   * Desviación relativa % del resultado real frente a la expectativa del
   * backtest (media por operación ponderada por estrategia); null si no
   * hay backtest de referencia con expectativa utilizable.
   */
  deviationPct: number | null;
}

const paperEvidence = (stats: PaperProgressStats): string => {
  const deviation =
    stats.deviationPct === null ? 'sin referencia' : `desviación ${fmtSignedPct(stats.deviationPct)}`;
  return (
    `${stats.daysActive} de ${LIVE_PAPER_MIN_DAYS} días · ` +
    `${stats.closedTrades} de ${LIVE_PAPER_MIN_TRADES} operaciones · ${deviation}`
  );
};

export function evaluatePaperProgress(stats: PaperProgressStats): RequirementVerdict {
  const reasons: string[] = [];
  if (stats.daysActive < LIVE_PAPER_MIN_DAYS) {
    reasons.push(
      `Faltan ${LIVE_PAPER_MIN_DAYS - stats.daysActive} días para completar ` +
        '3 meses de paper continuo.',
    );
  }
  if (stats.closedTrades < LIVE_PAPER_MIN_TRADES) {
    reasons.push(
      `Solo hay ${stats.closedTrades} de ${LIVE_PAPER_MIN_TRADES} operaciones requeridas.`,
    );
  }
  if (stats.deviationPct === null) {
    // Tiempo y operaciones pueden cumplir pero sin backtest no se puede
    // medir el ±30 %: la evidencia pide atención.
    if (stats.closedTrades > 0) {
      return review(
        paperEvidence(stats),
        [...reasons, 'Sin backtest de referencia para medir la desviación del ±30 %.'],
      );
    }
    reasons.push('Sin backtest de referencia para medir la desviación del ±30 %.');
  } else if (Math.abs(stats.deviationPct) > LIVE_DEVIATION_MAX_PCT) {
    reasons.push(
      `La desviación real frente al backtest (${fmtSignedPct(stats.deviationPct)}) ` +
        'supera el ±30 %.',
    );
  }
  if (reasons.length > 0) return pending(paperEvidence(stats), reasons);
  return ok(paperEvidence(stats));
}

/**
 * Medidas de paper trading a partir de las órdenes ejecutadas del broker
 * (`broker_orders`): días de actividad entre la primera y la última
 * ejecución, operaciones cerradas y desviación relativa media por
 * operación frente a la expectativa del último backtest de cada
 * estrategia (`expectationFor`, la misma fuente que el informe de
 * desviación).
 */
export function paperStatsFromOrders(
  orders: readonly BrokerOrder[],
  expectationFor: (strategyId: number) => Pick<StrategyExpectation, 'perTradeReturnPct'>,
): PaperProgressStats {
  const executedAts = orders
    .map((order) => order.execution.executedAt)
    .filter((at): at is string => at !== null)
    .map((at) => Date.parse(at))
    .filter((ms) => Number.isFinite(ms));
  const daysActive =
    executedAts.length < 2 ? 0 : daysBetween(Math.min(...executedAts), Math.max(...executedAts));

  const trades = closedTradesFromOrders(orders);
  const byStrategy = new Map<number, number[]>();
  for (const trade of trades) {
    const list = byStrategy.get(trade.strategyId) ?? [];
    list.push(trade.returnPct);
    byStrategy.set(trade.strategyId, list);
  }

  let realWeighted = 0;
  let expectedWeighted = 0;
  let weighted = 0;
  for (const [strategyId, returns] of byStrategy) {
    const expected = expectationFor(strategyId).perTradeReturnPct;
    if (expected === null || !Number.isFinite(expected)) continue;
    const realMean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
    realWeighted += realMean * returns.length;
    expectedWeighted += expected * returns.length;
    weighted += returns.length;
  }

  let deviationPct: number | null = null;
  if (weighted > 0) {
    const realAvg = realWeighted / weighted;
    const expectedAvg = expectedWeighted / weighted;
    deviationPct =
      expectedAvg === 0 ? (realAvg === 0 ? 0 : null) : ((realAvg - expectedAvg) / Math.abs(expectedAvg)) * 100;
  }

  return { daysActive, closedTrades: trades.length, deviationPct };
}

// ---------------------------------------------------------------------------
// 'parada-probada': prueba correcta en los últimos 30 días
// ---------------------------------------------------------------------------

export function evaluateKillSwitchTest(
  lastTestAt: string | null,
  nowMs: number,
): RequirementVerdict {
  if (lastTestAt === null) {
    return pending(null, ['La parada de emergencia no se ha probado.']);
  }
  const testedMs = Date.parse(lastTestAt);
  if (!Number.isFinite(testedMs)) {
    return pending(null, ['La fecha de la última prueba de parada no es legible.']);
  }
  const days = daysBetween(testedMs, nowMs);
  const evidence =
    days <= 0
      ? `Última prueba hoy (${formatLiveDate(lastTestAt)}).`
      : `Última prueba hace ${days} día${days === 1 ? '' : 's'} (${formatLiveDate(lastTestAt)}).`;
  if (days > LIVE_KILL_SWITCH_TEST_MAX_DAYS) {
    return pending(evidence, [
      `La prueba de parada tiene ${days} días (se exige una en los últimos ` +
        `${LIVE_KILL_SWITCH_TEST_MAX_DAYS}).`,
    ]);
  }
  return ok(evidence);
}

// ---------------------------------------------------------------------------
// 'alertas-activas': canal externo activo con envío de prueba correcto
// ---------------------------------------------------------------------------

/** Envío de prueba correcto registrado por un canal externo. */
export interface AlertTestEvidence {
  /** 'telegram' | 'correo' | 'simulado' (semilla E2E). */
  channel: string;
  /** ISO 8601 del envío correcto. */
  at: string;
}

export const alertChannelLabel = (channel: string): string =>
  channel === 'telegram'
    ? 'Telegram'
    : channel === 'correo'
      ? 'Correo'
      : channel === 'simulado'
        ? 'Canal externo (simulado)'
        : channel;

export function evaluateAlertChannel(
  test: AlertTestEvidence | null,
  isChannelActive: (channel: string) => boolean,
): RequirementVerdict {
  if (test === null) {
    return pending(null, [
      'No hay un envío de prueba correcto por un canal externo (Telegram o correo).',
    ]);
  }
  const evidence = `${alertChannelLabel(test.channel)} · prueba correcta el ${formatLiveDate(test.at)}.`;
  if (!isChannelActive(test.channel)) {
    return pending(evidence, [
      `El canal con la última prueba correcta (${alertChannelLabel(test.channel)}) ` +
        'ya no está activo ni configurado.',
    ]);
  }
  return ok(evidence);
}

// ---------------------------------------------------------------------------
// Declaraciones y motivos agregados
// ---------------------------------------------------------------------------

/** Motivo de pendiente para una declaración no suscrita. */
export const declarationPendingReason = (title: string): string =>
  `Falta la declaración «${title}».`;

/** Requisitos pendientes a partir de los veredictos (orden del contrato). */
export function pendingRequirementsOf(
  order: readonly LiveRequirement[],
  states: ReadonlyMap<LiveRequirement, LiveRequirementState>,
): LiveRequirement[] {
  return order.filter((requirement) => states.get(requirement) !== 'cumplido');
}
