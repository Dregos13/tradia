/**
 * Pasarela única del motor de riesgo (fase 3) — `risk:submit-signal`.
 *
 * Ninguna señal ni orden sale sin pasar por aquí. `createRiskEngine`
 * compone los cuatro bloques ya probados por separado y aplica el orden
 * fijado por el contrato:
 *
 *   parada de emergencia → reglas por operación → límites de cartera →
 *   cautela → decisión
 *
 * - La parada se comprueba dos veces: antes de evaluar y después de
 *   alimentar a sus observadores con la instantánea real de la cartera
 *   (una pérdida anómala o un salto de precio pueden dispararla en medio
 *   de la evaluación; la señal en curso también queda vetada).
 * - Las reglas por operación (`evaluateTradeRules`) calculan el tamaño a
 *   partir de la distancia al stop; los límites de cartera
 *   (`checkPortfolioLimits`) se evalúan sobre ese tamaño —si el tamaño
 *   mayor ya pasa, el reducido por cautela también—.
 * - La cautela puede bloquear la entrada (`vetada` con `CAUTION_MODE`) o
 *   reducir el tamaño (`reducida`, registrada igual en `risk_vetoes`).
 *
 * Cada motivo se persiste en `risk_vetoes` a través de `recordVeto` (una
 * fila por regla incumplida, con el código, el mensaje, los valores y la
 * señal) y se emite `risk:vetoed` por `emitVetoed`. Las aprobadas no se
 * registran.
 *
 * Todo lo externo llega inyectado por `service.ts`: el módulo no toca
 * Electron, SQLite ni el reloj por su cuenta.
 */

import {
  VETO_REASON_MESSAGES,
  type CautionState,
  type KillSwitchState,
  type RiskDecision,
  type RiskDecisionReason,
  type RiskLimits,
  type RiskVeto,
  type SignalIntent,
  type VetoReasonCode,
} from '../../shared/ipc';
import { drawdownPct, lossPctSince, periodStartUtc, type PortfolioSnapshot } from './portfolio';
import { checkPortfolioLimits } from './portfolioLimits';
import type { RiskVetoRecord } from './repository';
import { evaluateTradeRules } from './tradeRules';

// ---------------------------------------------------------------------------
// Dependencias inyectadas
// ---------------------------------------------------------------------------

export interface RiskEngineDeps {
  /** Límites vigentes (instantánea congelada del repositorio). */
  getLimits(): Readonly<RiskLimits>;
  /** Estado actual de la parada de emergencia. */
  getKillSwitchState(): KillSwitchState;
  /**
   * Cada señal que entra alimenta la detección de modelo errático de la
   * parada (ráfaga, inválidas seguidas, confianza fuera de rango).
   */
  observeSignal?(signal: SignalIntent): void;
  /** Pérdida diaria realizada (%), para la parada por pérdida anómala. */
  observeDailyLoss?(lossPct: number): void;
  /** Drawdown actual (%), para la parada por pérdida anómala. */
  observeDrawdown?(drawdownPct: number): void;
  /** Última variación diaria por ticker (%), para la parada por dato anómalo. */
  observePriceJump?(ticker: string, changePct: number): void;
  /**
   * Instantánea de la cartera simulada; `extraTickers` pide metadatos y
   * rendimientos también para el activo de la señal.
   */
  getSnapshot(extraTickers: readonly string[]): PortfolioSnapshot;
  /** Cautela vigente para el activo evaluado (reunida por el servicio). */
  evaluateCaution(ticker: string): CautionState;
  /** Persiste un motivo en `risk_vetoes` y devuelve la fila. */
  recordVeto(record: RiskVetoRecord): RiskVeto;
  /** Emite `risk:vetoed` al renderer con la fila persistida. */
  emitVetoed(veto: RiskVeto): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
}

export interface RiskEngine {
  /** Evalúa la señal y devuelve la decisión; persiste cada motivo. */
  submitSignal(signal: SignalIntent): RiskDecision;
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

const reason = (
  code: VetoReasonCode,
  details: Record<string, number | string> = {},
): RiskDecisionReason => ({ code, message: VETO_REASON_MESSAGES[code], details });

export function createRiskEngine(deps: RiskEngineDeps): RiskEngine {
  const now = deps.now ?? (() => Date.now());

  /** Registra los motivos y devuelve la decisión ya persistida. */
  const conclude = (
    signal: SignalIntent,
    status: RiskDecision['status'],
    reasons: RiskDecisionReason[],
    size: number,
    sizeFactor: number,
    riskAmount: number,
    notional: number,
  ): RiskDecision => {
    if (status !== 'aprobada') {
      for (const r of reasons) {
        const veto = deps.recordVeto({ signal, decision: status, reason: r, size });
        deps.emitVetoed(veto);
      }
    }
    return {
      status,
      size,
      sizeFactor,
      riskAmount,
      notional,
      reasons,
      decidedAt: new Date(now()).toISOString(),
    };
  };

  const killSwitchReason = (state: KillSwitchState): RiskDecisionReason =>
    reason('KILL_SWITCH_ACTIVE', { causa: state.cause ?? 'manual' });

  const cautionReason = (caution: CautionState): RiskDecisionReason =>
    reason('CAUTION_MODE', {
      evento: caution.eventTitle ?? caution.cause ?? '',
      ...(caution.cause !== null ? { causa: caution.cause } : {}),
      ...(caution.sizeFactor !== 1 ? { factor: caution.sizeFactor } : {}),
    });

  const submitSignal = (signal: SignalIntent): RiskDecision => {
    // Primero la parada: la ráfaga y la confianza anómala alimentan el
    // detector de modelo errático y pueden activarla justo ahora.
    deps.observeSignal?.(signal);

    const earlyReasons: RiskDecisionReason[] = [];
    const stopNow = deps.getKillSwitchState();
    if (stopNow.active) earlyReasons.push(killSwitchReason(stopNow));
    // Defensa en profundidad: la confianza fuera de 0–1 llega al motor aun
    // pasando la guarda del borde (anomalía del modelo, contrato SignalIntent).
    if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
      earlyReasons.push(reason('SIGNAL_INVALID', { confianza: signal.confidence }));
    }
    if (earlyReasons.length > 0) {
      return conclude(signal, 'vetada', earlyReasons, 0, 1, 0, 0);
    }

    const snapshot = deps.getSnapshot([signal.ticker]);

    // Los observadores de la parada ven el estado real de la cartera: una
    // pérdida anómala o un salto de precio la activan en este punto.
    const dayStart = periodStartUtc(snapshot.now, 'day');
    if (dayStart !== null) {
      deps.observeDailyLoss?.(
        lossPctSince(snapshot.equityHistory, snapshot.equity, dayStart.toISOString()),
      );
    }
    deps.observeDrawdown?.(drawdownPct(snapshot.equityHistory, snapshot.equity));
    for (const [ticker, returns] of Object.entries(snapshot.dailyReturns)) {
      const last = returns.at(-1);
      if (last !== undefined) deps.observePriceJump?.(ticker, last * 100);
    }
    const triggered = deps.getKillSwitchState();
    if (triggered.active) {
      return conclude(signal, 'vetada', [killSwitchReason(triggered)], 0, 1, 0, 0);
    }

    const limits = deps.getLimits();

    const trade = evaluateTradeRules(signal, snapshot.equity, limits);
    if (trade.reasons.length > 0) {
      return conclude(signal, 'vetada', trade.reasons, trade.size, 1, 0, 0);
    }

    const portfolioReasons = checkPortfolioLimits(signal, trade.size, snapshot, {
      ...limits,
    });
    if (portfolioReasons.length > 0) {
      return conclude(signal, 'vetada', portfolioReasons, trade.size, 1, 0, 0);
    }

    const caution = deps.evaluateCaution(signal.ticker);
    if (caution.effect === 'bloquear') {
      return conclude(signal, 'vetada', [cautionReason(caution)], trade.size, 0, 0, 0);
    }
    if (caution.effect === 'reducir') {
      const reducedSize = Math.floor(trade.size * caution.sizeFactor);
      return conclude(
        signal,
        'reducida',
        [cautionReason(caution)],
        reducedSize,
        caution.sizeFactor,
        reducedSize * (trade.size > 0 ? trade.riskAmount / trade.size : 0),
        reducedSize * signal.entry,
      );
    }

    return conclude(signal, 'aprobada', [], trade.size, 1, trade.riskAmount, trade.notional);
  };

  return { submitSignal };
}
