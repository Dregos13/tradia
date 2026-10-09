/**
 * Reglas por operación del motor de riesgo (fase 3) — módulo puro.
 *
 * Sin Electron, sin Node, sin estado: la pasarela única
 * (`risk:submit-signal`) llama a `evaluateTradeRules` con la señal, el
 * capital de la cuenta y una instantánea congelada de los límites. La
 * forma de la señal ya se validó en el borde IPC (`isSignalIntent`);
 * la confianza fuera de 0–1 y la parada de emergencia las resuelve la
 * pasarela, no este módulo.
 *
 * Reglas (todas vetan; nunca se relajan):
 * - `STOP_MISSING`: el stop de protección es obligatorio.
 * - `STOP_WRONG_SIDE`: en largo el stop va por debajo de la entrada y en
 *   corto por encima; un stop a nivel de la entrada tampoco protege.
 * - `RR_TOO_LOW`: el ratio beneficio/riesgo (con signo, orientado a la
 *   dirección) tiene que alcanzar el mínimo configurado y nunca baja de
 *   2 — el suelo de `RISK_BOUNDS.minRewardRiskRatio` es un margen duro
 *   que ni la IA ni las estrategias pueden tocar.
 * - `SIZE_ZERO`: tamaño = capital × riesgo% / |entrada − stop|,
 *   redondeado hacia abajo a unidades enteras; si sale 0 no hay
 *   operación que respete el riesgo.
 *
 * Los márgenes duros también se aplican en lectura: aunque llegara un
 * `riskPerTradePct` fuera de 0,5–2 (configuración corrupta), el tamaño
 * se calcula con el valor recortado al margen, nunca con más riesgo.
 * `limits` se trata como solo lectura: el módulo no lo muta.
 */

import {
  RISK_BOUNDS,
  VETO_REASON_MESSAGES,
  type RiskDecisionReason,
  type RiskLimits,
  type SignalIntent,
  type VetoReasonCode,
} from '../../shared/risk';

/** Resultado de las reglas por operación sobre una señal. */
export interface TradeRuleResult {
  /** Reglas incumplidas; vacío cuando la señal pasa las reglas. */
  reasons: RiskDecisionReason[];
  /** Tamaño en unidades enteras (0 cuando hay veto o no es calculable). */
  size: number;
  /** Capital arriesgado si salta el stop: size × |entrada − stop|. */
  riskAmount: number;
  /** Exposición nominal de la posición: size × entrada. */
  notional: number;
}

const reason = (
  code: VetoReasonCode,
  details: Record<string, number | string> = {},
): RiskDecisionReason => ({ code, message: VETO_REASON_MESSAGES[code], details });

/** Recorta `value` al margen duro [min, max] del contrato. */
const clampToBound = (value: number, bound: { min: number; max: number }): number =>
  Math.min(bound.max, Math.max(bound.min, value));

/**
 * % de capital arriesgado por operación, recortado al margen duro
 * 0,5–2 %. La escritura de límites ya lo impone (`risk:set-limits`), pero
 * el motor no confía en el origen: un objeto de límites corrupto nunca
 * arriesga más del 2 % ni menos del 0,5 % por operación.
 */
export function effectiveRiskPct(limits: Readonly<RiskLimits>): number {
  return clampToBound(limits.riskPerTradePct, RISK_BOUNDS.riskPerTradePct);
}

/**
 * Ratio beneficio/riesgo mínimo exigible: el configurado, con el suelo
 * duro de 2 que el contrato no permite bajar.
 */
export function effectiveMinRewardRiskRatio(limits: Readonly<RiskLimits>): number {
  return Math.max(limits.minRewardRiskRatio, RISK_BOUNDS.minRewardRiskRatio.min);
}

/**
 * Distancia al stop orientada a la dirección: positiva cuando el stop
 * está del lado que protege (largo: stop < entrada; corto: stop >
 * entrada), cero o negativa cuando está del lado contrario.
 */
export function stopDistance(signal: SignalIntent): number | null {
  if (signal.stop === null) return null;
  return signal.direction === 'largo' ? signal.entry - signal.stop : signal.stop - signal.entry;
}

/**
 * Ratio beneficio/riesgo con signo de la señal, o null si no se puede
 * calcular (sin objetivo, sin stop o stop del lado contrario). Un
 * objetivo del lado que pierde da un ratio negativo, que siempre veta.
 */
export function rewardRiskRatio(signal: SignalIntent): number | null {
  if (signal.target === null) return null;
  const distance = stopDistance(signal);
  if (distance === null || distance <= 0) return null;
  const reward =
    signal.direction === 'largo' ? signal.target - signal.entry : signal.entry - signal.target;
  return reward / distance;
}

/**
 * Tamaño de la posición en unidades enteras: capital × riesgo% /
 * |entrada − stop|, redondeado hacia abajo. Devuelve 0 cuando el
 * resultado no es un entero positivo (capital inválido, distancia cero…).
 */
export function positionSize(capital: number, riskPct: number, distance: number): number {
  const raw = (capital * (riskPct / 100)) / distance;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/** Redondeo a 4 decimales para los valores que se muestran en el veto. */
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Evalúa las reglas por operación: stop obligatorio y del lado correcto,
 * ratio beneficio/riesgo mínimo y tamaño por distancia al stop.
 *
 * `capital` es el capital de la cuenta en su divisa. `limits` es la
 * instantánea congelada de límites: se lee, no se modifica.
 *
 * Devuelve las reglas incumplidas en `reasons` (vacío = señal limpia) y
 * el tamaño calculado; si hay veto, `size`/`riskAmount`/`notional` son 0.
 * La cautela, la parada y los límites de cartera no entran aquí: los
 * aplica la pasarela sobre este resultado.
 */
export function evaluateTradeRules(
  signal: SignalIntent,
  capital: number,
  limits: Readonly<RiskLimits>,
): TradeRuleResult {
  const vetoed = (reasons: RiskDecisionReason[]): TradeRuleResult => ({
    reasons,
    size: 0,
    riskAmount: 0,
    notional: 0,
  });

  const prices = [signal.entry, signal.stop, signal.target].filter((p): p is number => p !== null);
  if (!Number.isFinite(capital) || capital <= 0 || prices.some((p) => !Number.isFinite(p))) {
    return vetoed([reason('SIGNAL_INVALID', { entrada: signal.entry })]);
  }

  const reasons: RiskDecisionReason[] = [];
  const stop = signal.stop;
  let distance: number | null = null;

  if (stop === null) {
    reasons.push(reason('STOP_MISSING'));
  } else {
    distance = signal.direction === 'largo' ? signal.entry - stop : stop - signal.entry;
    if (distance <= 0) {
      reasons.push(reason('STOP_WRONG_SIDE', { entrada: signal.entry, stop }));
    }
  }

  const minRatio = effectiveMinRewardRiskRatio(limits);
  const ratio = rewardRiskRatio(signal);
  if (signal.target === null) {
    reasons.push(reason('RR_TOO_LOW', { ratio: 'sin objetivo', minimo: minRatio }));
  } else if (ratio !== null && ratio < minRatio) {
    reasons.push(reason('RR_TOO_LOW', { ratio: round4(ratio), minimo: minRatio }));
  }

  // Aquí `distance` es > 0: null vetó STOP_MISSING y <= 0 vetó
  // STOP_WRONG_SIDE, así que el retorno anterior ya se llevó ambos casos.
  if (reasons.length > 0) return vetoed(reasons);

  const riskPct = effectiveRiskPct(limits);
  const size = positionSize(capital, riskPct, distance as number);
  if (size === 0) {
    return vetoed([
      reason('SIZE_ZERO', { capital, riesgoPct: riskPct, distancia: distance as number }),
    ]);
  }

  return {
    reasons: [],
    size,
    riskAmount: size * (distance as number),
    notional: size * signal.entry,
  };
}
