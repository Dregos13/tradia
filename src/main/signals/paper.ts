/**
 * Seguimiento de posiciones simuladas desde señales aprobadas — Fase 4.
 *
 * `createPaperTracker` es testeable sin Electron: la escritura de la
 * cartera paper llega inyectada (`deps.gateway`, que en la app es
 * `services.risk` — `src/main/signals/` no puede importar los escritores
 * del motor de riesgo por `no-restricted-imports`), igual que las velas,
 * el diario, el aviso de límites y los observadores de la parada.
 *
 * Reglas de negocio (ver docs/senales.md):
 * - Cada señal persistida con decisión 'aprobada' o 'reducida' y tamaño
 *   > 0 abre una posición en `risk_portfolio_positions` al precio de la
 *   señal y con el tamaño que dio la pasarela (`decision.size`). Nunca se
 *   envía una orden real: la app avisa pero no ejecuta.
 * - Cada vela guardada estrictamente posterior a la de la apertura evalúa
 *   stop y objetivo intrabarra con la semántica del motor de backtest: el
 *   stop primero cuando la vela toca ambos, y un hueco más allá del nivel
 *   ejecuta a la apertura.
 * - Al cerrar, el repositorio anota el P&L realizado en la curva de
 *   capital (`risk_equity_history`) y el tracker registra la operación en
 *   el diario (tipo 'operacion', resultado 'ganancia'|'perdida'|'empate')
 *   con el cumplimiento de reglas.
 * - Tras cada vela se comparan las pérdidas realizadas (día, semana, mes)
 *   y el drawdown con los límites vigentes: cada límite que pasa a estar
 *   alcanzado deja una entrada 'limite' en el diario y un aviso
 *   'limite-alcanzado' por los canales de entrega, y las medidas se
 *   reportan a los observadores de la parada de emergencia (pérdida
 *   anómala y drawdown pueden activarla).
 */
import type { JournalRecordInput, JournalStrategyRef } from '../../shared/journal';
import type { MarketUpdatedEvent } from '../../shared/ipc';
import { VETO_REASON_MESSAGES, type RiskLimits, type VetoReasonCode } from '../../shared/risk';
import type { Signal, SignalNewEvent } from '../../shared/signals';
import { DELIVERY_DISCLAIMER } from '../delivery/format';
import type {
  NewPaperPosition,
  PaperCloseRequest,
  PaperCloseResult,
  PaperExitReason,
  PaperPositionRecord,
  PaperRiskState,
} from '../risk/portfolio';
import type { SignalSourceBar } from './engine';

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

/** La parte del motor de riesgo que escribe y lee la cartera simulada. */
export interface PaperPositionGateway {
  listPaperPositions(ticker?: string): PaperPositionRecord[];
  openPaperPosition(input: NewPaperPosition): PaperPositionRecord;
  closePaperPosition(request: PaperCloseRequest): PaperCloseResult | null;
  getPaperRiskState(): PaperRiskState;
  getLimits(): RiskLimits;
}

export interface PaperTrackerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PaperTrackerDeps {
  /**
   * Escritor de la cartera simulada (`services.risk` en la app). Sin él el
   * tracker queda inerte: mejor no abrir posiciones que no se puedan
   * seguir (degradación segura, mismo criterio que la pasarela).
   */
  gateway?: PaperPositionGateway;
  /** La vela guardada en `date` para el ticker (serie ajustada); null si no hay. */
  barAt(ticker: string, date: string, source: string | null): SignalSourceBar | null;
  /** La señal persistida (motivo y votos para el diario de la operación). */
  getSignal(id: number): Signal | null;
  /** Entrada del diario automático (`services.journal.record`). */
  recordJournal?(input: JournalRecordInput): void;
  /** Aviso 'limite-alcanzado' por los canales (`services.delivery.sendEvent`). */
  sendLimitAlert?(message: { title: string; body: string }): void;
  /** Observadores de la parada de emergencia (pérdida anómala/drawdown). */
  observeDailyLoss?(lossPct: number): void;
  observeDrawdown?(drawdownPct: number): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  logger?: Partial<PaperTrackerLogger>;
}

export interface PaperTracker {
  /** Entrada del evento `signals:new` del motor (payload SignalNewEvent). */
  handleSignalEvent(payload: unknown): void;
  /** Entrada del evento interno «vela guardada» de market/ingestion. */
  handleBarStored(event: MarketUpdatedEvent): void;
  /**
   * Compara pérdidas y drawdown con los límites y emite lo que pase a
   * estar alcanzado (diario 'limite' + aviso por canales + observadores
   * de la parada). Se llama tras cada vela procesada.
   */
  checkLimits(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Semántica de cierre (la del motor de backtest, ver probe.ts)
// ---------------------------------------------------------------------------

/** Lo que decide una vela sobre una posición abierta. */
export interface PaperExitDecision {
  /** Precio de ejecución del cierre simulado. */
  exit: number;
  reason: PaperExitReason;
  /** Nivel de la posición que se tocó. */
  level: number;
}

/**
 * Evalúa una vela contra stop y objetivo de la posición. Si la vela toca
 * ambos, cuenta el stop; un hueco más allá del nivel ejecuta a la apertura
 * (`Math.min/max` igual que en `probe.ts`). Devuelve null si no toca nada.
 */
export function evaluatePaperExit(
  position: Pick<PaperPositionRecord, 'direction' | 'stop' | 'target'>,
  bar: Pick<SignalSourceBar, 'open' | 'high' | 'low'>,
): PaperExitDecision | null {
  const { stop, target } = position;
  if (position.direction === 'largo') {
    if (stop !== null && bar.low <= stop) {
      return { exit: Math.min(bar.open, stop), reason: 'stop', level: stop };
    }
    if (target !== null && bar.high >= target) {
      return { exit: Math.max(bar.open, target), reason: 'objetivo', level: target };
    }
    return null;
  }
  if (stop !== null && bar.high >= stop) {
    return { exit: Math.max(bar.open, stop), reason: 'stop', level: stop };
  }
  if (target !== null && bar.low <= target) {
    return { exit: Math.min(bar.open, target), reason: 'objetivo', level: target };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Límites vigilados
// ---------------------------------------------------------------------------

interface PaperLimitRule {
  code: VetoReasonCode;
  label: string;
  /** Valor observado (%) y límite vigente (%) para el estado dado. */
  read(state: PaperRiskState, limits: RiskLimits): { observed: number; limit: number };
}

/** Pérdidas por periodo y drawdown, frente a sus límites configurables. */
const PAPER_LIMIT_RULES: readonly PaperLimitRule[] = [
  {
    code: 'DAILY_LOSS',
    label: VETO_REASON_MESSAGES.DAILY_LOSS,
    read: (s, l) => ({ observed: s.dailyLossPct, limit: l.maxDailyLossPct }),
  },
  {
    code: 'WEEKLY_LOSS',
    label: VETO_REASON_MESSAGES.WEEKLY_LOSS,
    read: (s, l) => ({ observed: s.weeklyLossPct, limit: l.maxWeeklyLossPct }),
  },
  {
    code: 'MONTHLY_LOSS',
    label: VETO_REASON_MESSAGES.MONTHLY_LOSS,
    read: (s, l) => ({ observed: s.monthlyLossPct, limit: l.maxMonthlyLossPct }),
  },
  {
    code: 'MAX_DRAWDOWN',
    label: VETO_REASON_MESSAGES.MAX_DRAWDOWN,
    read: (s, l) => ({ observed: s.drawdownPct, limit: l.maxDrawdownPct }),
  },
];

const formatPct = (value: number): string => `${(Math.round(value * 100) / 100).toFixed(2)} %`;

const formatPrice = (value: number): string => String(Math.round(value * 10_000) / 10_000);

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export function createPaperTracker(deps: PaperTrackerDeps): PaperTracker {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();

  let stopped = false;
  /** Límites que ya se avisaron como alcanzados (transición, no estado). */
  const breached = new Set<VetoReasonCode>();

  const recordJournal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal?.(input);
    } catch (error: unknown) {
      logger.warn?.(`[paper] no se pudo escribir en el diario: ${String(error)}`);
    }
  };

  const openFromSignal = (signal: Signal): void => {
    const gateway = deps.gateway;
    const { decision } = signal;
    if (decision.status === 'vetada' || !(decision.size > 0)) return;
    if (gateway === undefined) {
      logger.warn?.(
        `[paper] señal ${signal.id} aprobada sin cartera simulada disponible; no se abre posición`,
      );
      return;
    }
    try {
      gateway.openPaperPosition({
        ticker: signal.ticker,
        direction: signal.direction,
        entry: signal.entry,
        stop: signal.stop,
        target: signal.target,
        size: decision.size,
        sector: null,
        currency: 'USD',
        signalId: signal.id,
        openedOnBar: signal.dataUsed.barDate,
        openedAt: isoNow(),
      });
      logger.info?.(
        `[paper] señal ${signal.id}: abierta posición simulada ${signal.direction} ` +
          `${decision.size} uds de ${signal.ticker} @ ${formatPrice(signal.entry)}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(`[paper] no se pudo abrir la posición de la señal ${signal.id}: ${message}`);
      recordJournal({
        type: 'error',
        ticker: signal.ticker,
        reason: `No se pudo abrir la posición simulada de la señal ${signal.id}`,
        dataUsed: { signalId: signal.id },
        result: 'error',
        errors: [message],
        signalId: signal.id,
      });
    }
  };

  const closePosition = (
    position: PaperPositionRecord,
    bar: SignalSourceBar,
    decision: PaperExitDecision,
  ): void => {
    const gateway = deps.gateway;
    if (gateway === undefined) return;
    const closedAt = isoNow();
    let result: PaperCloseResult | null;
    try {
      result = gateway.closePaperPosition({
        positionId: position.id,
        exit: decision.exit,
        exitReason: decision.reason,
        closedAt,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(
        `[paper] no se pudo cerrar la posición ${position.id} de ${position.ticker}: ${message}`,
      );
      recordJournal({
        type: 'error',
        ticker: position.ticker,
        reason: `No se pudo cerrar la posición simulada ${position.id} de ${position.ticker}`,
        dataUsed: { positionId: position.id, barDate: bar.date },
        result: 'error',
        errors: [message],
      });
      return;
    }
    if (result === null) return; // ya cerrada: la vela no cuenta dos veces

    const pnl = Math.round(result.pnl * 100) / 100;
    const sign = position.direction === 'largo' ? 1 : -1;
    const pnlPct =
      position.entry > 0
        ? Math.round(((decision.exit - position.entry) / position.entry) * 100 * sign * 100) / 100
        : 0;
    const outcome = pnl > 0 ? 'ganancia' : pnl < 0 ? 'perdida' : 'empate';
    const motivoCierre = decision.reason === 'stop' ? 'stop de protección' : 'objetivo';

    let strategies: JournalStrategyRef[] = [];
    let signalReason: string | null = null;
    if (position.signalId !== null) {
      const signal = deps.getSignal(position.signalId);
      if (signal !== null) {
        strategies = signal.strategies.map((vote) => ({
          strategyId: vote.strategyId,
          name: vote.name,
          version: vote.version,
        }));
        signalReason = signal.reason;
      }
    }

    recordJournal({
      type: 'operacion',
      ticker: position.ticker,
      strategies,
      reason:
        `Cierre simulado por ${motivoCierre} de ${position.ticker}: ` +
        `${position.size} uds ${position.direction} ` +
        `entrada ${formatPrice(position.entry)} → salida ${formatPrice(decision.exit)} ` +
        `(P&L ${pnl > 0 ? '+' : ''}${pnl})`,
      dataUsed: {
        posicionId: position.id,
        direccion: position.direction,
        entrada: position.entry,
        salida: decision.exit,
        motivoSalida: decision.reason,
        nivel: decision.level,
        stop: position.stop,
        objetivo: position.target,
        tamano: position.size,
        pnl,
        pnlPct,
        velaApertura: position.openedOnBar,
        velaCierre: bar.date,
        abiertaEn: position.openedAt,
        cerradaEn: closedAt,
        equity: result.equity,
        motivoSenal: signalReason,
      },
      result: outcome,
      ruleChecks: [
        {
          code: decision.reason === 'stop' ? 'STOP_PROTECCION' : 'OBJETIVO_BENEFICIO',
          label:
            decision.reason === 'stop'
              ? 'Stop de protección ejecutado'
              : 'Objetivo de beneficio ejecutado',
          cumplida: true,
          observed: `salida ${formatPrice(decision.exit)}`,
          limit: `nivel ${formatPrice(decision.level)}`,
        },
        {
          code: 'TAMANO_ASIGNADO',
          label: 'Tamaño asignado por la pasarela de riesgo respetado',
          cumplida: true,
          observed: `${position.size} uds`,
          limit: null,
        },
      ],
      signalId: position.signalId,
    });
    logger.info?.(
      `[paper] ${position.ticker}: cierre por ${motivoCierre} en ${bar.date} ` +
        `a ${formatPrice(decision.exit)} (P&L ${pnl > 0 ? '+' : ''}${pnl})`,
    );
  };

  const tracker: PaperTracker = {
    handleSignalEvent: (payload) => {
      if (stopped) return;
      const signal =
        typeof payload === 'object' && payload !== null
          ? (payload as Partial<SignalNewEvent>).signal
          : undefined;
      if (signal === undefined || signal === null) return;
      openFromSignal(signal);
    },

    handleBarStored: (event) => {
      if (stopped || event.lastDate === null) return;
      const gateway = deps.gateway;
      if (gateway === undefined) return;
      const bar = deps.barAt(event.ticker, event.lastDate, event.source);
      if (bar === null) return;

      try {
        for (const position of gateway.listPaperPositions(event.ticker)) {
          // Solo velas estrictamente posteriores a la de la apertura: la
          // vela que emitió la señal ya cotizó antes de que existiera la
          // posición.
          if (position.openedOnBar !== null && bar.date <= position.openedOnBar) continue;
          const decision = evaluatePaperExit(position, bar);
          if (decision !== null) closePosition(position, bar, decision);
        }
      } catch (error: unknown) {
        logger.error?.(
          `[paper] el seguimiento de ${event.ticker} en ${bar.date} falló: ${String(error)}`,
        );
      }
      tracker.checkLimits();
    },

    checkLimits: () => {
      const gateway = deps.gateway;
      if (stopped || gateway === undefined) return;
      let state: PaperRiskState;
      let limits: RiskLimits;
      try {
        state = gateway.getPaperRiskState();
        limits = gateway.getLimits();
      } catch (error: unknown) {
        logger.warn?.(`[paper] no se pudo medir el estado de la cartera: ${String(error)}`);
        return;
      }

      // La parada ve las medidas reales aunque ninguna señal esté en
      // curso: la pérdida anómala (1,5 × diario) y el drawdown la activan.
      deps.observeDailyLoss?.(state.dailyLossPct);
      deps.observeDrawdown?.(state.drawdownPct);

      const newBreaches: { rule: PaperLimitRule; observed: number; limit: number }[] = [];
      for (const rule of PAPER_LIMIT_RULES) {
        const { observed, limit } = rule.read(state, limits);
        if (observed >= limit && limit > 0) {
          if (!breached.has(rule.code)) {
            breached.add(rule.code);
            newBreaches.push({ rule, observed, limit });
          }
        } else {
          breached.delete(rule.code);
        }
      }
      if (newBreaches.length === 0) return;

      for (const { rule, observed, limit } of newBreaches) {
        logger.warn?.(`[paper] ${rule.label}: ${formatPct(observed)} ≥ ${formatPct(limit)}`);
        recordJournal({
          type: 'limite',
          reason: `${rule.label}: ${formatPct(observed)} frente al límite ${formatPct(limit)}`,
          dataUsed: {
            codigo: rule.code,
            observado: observed,
            limite: limit,
            equity: state.equity,
            perdidaDiariaPct: state.dailyLossPct,
            perdidaSemanalPct: state.weeklyLossPct,
            perdidaMensualPct: state.monthlyLossPct,
            drawdownPct: state.drawdownPct,
          },
          result: 'alcanzado',
          ruleChecks: [
            {
              code: rule.code,
              label: rule.label,
              cumplida: false,
              observed: formatPct(observed),
              limit: formatPct(limit),
            },
          ],
        });
      }

      // Un aviso por pasada, como la agrupación de vetos de delivery.
      const lines = newBreaches.map(
        ({ rule, observed, limit }) =>
          `${rule.label}: ${formatPct(observed)} frente al límite ${formatPct(limit)}.`,
      );
      const single = newBreaches.length === 1;
      try {
        deps.sendLimitAlert?.({
          title: single
            ? `Límite alcanzado · ${newBreaches[0]!.rule.label}`
            : `Límites alcanzados · ${newBreaches.length} reglas`,
          body: `${lines.join(' ')} Se han bloqueado nuevas señales. ${DELIVERY_DISCLAIMER}`,
        });
      } catch (error: unknown) {
        logger.warn?.(`[paper] no se pudo enviar el aviso de límite: ${String(error)}`);
      }
    },

    stop: () => {
      stopped = true;
    },
  };

  return tracker;
}
