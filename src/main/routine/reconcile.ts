/**
 * Conciliación posterior al cierre (fase 4) — funciones puras.
 *
 * Cuadra tres fuentes que se escriben por caminos distintos: las señales
 * del día (`signals`), la cartera simulada (`risk_portfolio_positions` y
 * `risk_equity_history`) y el diario (`journal_entries` tipo 'operacion').
 * Cada descuadre sale como una discrepancia legible en español; el
 * servicio la anota como entrada 'error' del diario.
 *
 * Ámbito: el día de mercado reconciliado (`dia`, fecha de sesión de
 * Nueva York). Las señales y las operaciones se acotan a ese día; las
 * posiciones y la curva se leen completas porque sus enlaces (senal_id,
 * posicionId, instantes de cierre) pueden apuntar a días anteriores.
 */

import type { JournalEntry } from '../../shared/journal';
import type { Signal } from '../../shared/signals';
import { nySessionDate } from '../market/calendar';
import type { PaperPositionRecord } from '../risk/portfolio';
import type { EquityHistoryRow } from './repository';

/** Tolerancia al comparar importes (P&L, capital): un céntimo. */
export const RECONCILE_TOLERANCE = 0.01;

export interface ReconcileInput {
  /** Día de mercado reconciliado ('YYYY-MM-DD', America/New_York). */
  dia: string;
  /** Señales emitidas el `dia` (vela_fecha = dia). */
  signals: readonly Signal[];
  /** Todas las posiciones simuladas, abiertas y cerradas. */
  positions: readonly PaperPositionRecord[];
  /** Entradas 'operacion' del diario (las recientes bastan). */
  operations: readonly JournalEntry[];
  /** Curva de capital completa; se tolera cualquier orden. */
  equityHistory: readonly EquityHistoryRow[];
}

/** Qué se revisó, para el `datos` de la entrada de conciliación. */
export interface ReconcileChecked {
  /** Señales aprobadas/reducidas del día que debían abrir posición. */
  senalesAprobadas: number;
  /** Posiciones cuyo cierre cayó en el día reconciliado. */
  posicionesCerradasHoy: number;
  /** Entradas 'operacion' del diario creadas en el día. */
  operacionesHoy: number;
  /** Instantes de cierre distintos cotejados con la curva de capital. */
  cierresConCurva: number;
}

export interface ReconcileResult {
  /** Descuadres encontrados, en texto legible; vacío si cuadra todo. */
  discrepancies: string[];
  checked: ReconcileChecked;
}

/** P&L realizado de una posición cerrada; null si sigue abierta. */
const pnlOf = (p: PaperPositionRecord): number | null =>
  p.exit === null ? null : (p.exit - p.entry) * p.size * (p.direction === 'largo' ? 1 : -1);

/** `datos.posicionId` de una entrada 'operacion', validado; null si no consta. */
const positionIdOf = (entry: JournalEntry): number | null => {
  const value = entry.dataUsed?.['posicionId'];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
};

const money = (value: number): string => String(Math.round(value * 100) / 100);

export function reconcileDay(input: ReconcileInput): ReconcileResult {
  const discrepancies: string[] = [];
  const positionsById = new Map(input.positions.map((p) => [p.id, p]));
  const linkedSignalIds = new Set(
    input.positions.map((p) => p.signalId).filter((id): id is number => id !== null),
  );

  // 1 · Señal aprobada/reducida con tamaño ⇒ posición simulada enlazada.
  // (La apertura va por el broadcast de signals:new; si el proceso murió
  // entre el persist y el broadcast la posición nunca se abrió.)
  const approved = input.signals.filter(
    (s) => s.decision.status !== 'vetada' && s.decision.size > 0,
  );
  for (const signal of approved) {
    if (!linkedSignalIds.has(signal.id)) {
      discrepancies.push(
        `La señal #${signal.id} de ${signal.ticker} (${signal.decision.status}, ` +
          `${signal.decision.size} uds) no tiene posición simulada enlazada`,
      );
    }
  }

  // 2 · Posición cerrada hoy ⇒ entrada 'operacion' con su posicionId.
  const closedToday = input.positions.filter(
    (p) => p.closedAt !== null && nySessionDate(p.closedAt) === input.dia,
  );
  const opsToday = input.operations.filter((e) => nySessionDate(e.createdAt) === input.dia);
  const opsByPosition = new Map<number, JournalEntry>();
  for (const entry of opsToday) {
    const pid = positionIdOf(entry);
    if (pid !== null) opsByPosition.set(pid, entry);
  }
  for (const position of closedToday) {
    if (!opsByPosition.has(position.id)) {
      discrepancies.push(
        `La posición #${position.id} de ${position.ticker} cerrada el ` +
          `${position.closedAt} no tiene entrada «operacion» en el diario`,
      );
    }
  }

  // 3 · Cada 'operacion' de hoy referencia una posición real y su P&L cuadra.
  for (const entry of opsToday) {
    const pid = positionIdOf(entry);
    if (pid === null) {
      discrepancies.push(
        `La operación #${entry.id} del diario no referencia ninguna posición simulada`,
      );
      continue;
    }
    const position = positionsById.get(pid);
    if (position === undefined) {
      discrepancies.push(
        `La operación #${entry.id} del diario referencia la posición #${pid}, ` +
          `que no existe en la cartera simulada`,
      );
      continue;
    }
    const recorded = entry.dataUsed?.['pnl'];
    const expected = pnlOf(position);
    if (
      typeof recorded === 'number' &&
      expected !== null &&
      Math.abs(recorded - expected) > RECONCILE_TOLERANCE
    ) {
      discrepancies.push(
        `El P&L de la posición #${pid} (${money(expected)}) no coincide con la ` +
          `operación #${entry.id} del diario (${money(recorded)})`,
      );
    }
  }

  // 4 · Cada cierre de hoy dejó su punto en la curva de capital y el
  // incremento del punto cuadra con el P&L de los cierres de ese instante.
  const curve = [...input.equityHistory].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  const capitalAt = new Map(curve.map((point) => [point.fecha, point.capital]));
  const pnlByInstant = new Map<string, number>();
  for (const position of closedToday) {
    const at = position.closedAt;
    if (at === null) continue;
    pnlByInstant.set(at, (pnlByInstant.get(at) ?? 0) + (pnlOf(position) ?? 0));
    if (!capitalAt.has(at)) {
      discrepancies.push(
        `El cierre de la posición #${position.id} de ${position.ticker} (${at}) ` +
          `no tiene punto en la curva de capital`,
      );
    }
  }
  for (const [at, pnlSum] of pnlByInstant) {
    const index = curve.findIndex((point) => point.fecha === at);
    if (index <= 0) continue; // sin punto previo no hay base para el delta
    const delta = curve[index]!.capital - curve[index - 1]!.capital;
    if (Math.abs(delta - pnlSum) > RECONCILE_TOLERANCE) {
      discrepancies.push(
        `La curva de capital en ${at} varía ${money(delta)} pero el P&L de los ` +
          `cierres de ese instante suma ${money(pnlSum)}`,
      );
    }
  }

  return {
    discrepancies,
    checked: {
      senalesAprobadas: approved.length,
      posicionesCerradasHoy: closedToday.length,
      operacionesHoy: opsToday.length,
      cierresConCurva: pnlByInstant.size,
    },
  };
}
