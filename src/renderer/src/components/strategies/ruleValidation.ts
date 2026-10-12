import type { Strategy } from '../../../../shared/strategy';
import { parseStrategyRules, type StrategyRulesError } from '../../../../shared/strategyRules';

export const ruleLabels = {
  entry: 'Entrada',
  exit: 'Salida',
  stop: 'Stop',
  target: 'Objetivo',
  entryShort: 'Entrada en corto',
  exitShort: 'Salida del corto',
};
export const rulePosition = (error: StrategyRulesError) =>
  `caracteres ${error.start + 1}–${Math.max(error.start + 1, error.end)}`;
export const ruleErrorText = (error: StrategyRulesError) =>
  `${error.message} · ${rulePosition(error)}.`;

export function strategyExecution(strategy: Strategy) {
  const parsed = parseStrategyRules(strategy.rules, strategy.parameters);
  // Las clásicas tienen una implementación registrada y reglas descriptivas.
  // Las propias se comprueban con el mismo analizador que usa el servicio.
  return {
    executable: strategy.executable || parsed.ok,
    parsed,
    reason: parsed.ok
      ? ''
      : `${parsed.errors[0]!.message} en ${ruleLabels[parsed.errors[0]!.field]}, ${rulePosition(parsed.errors[0]!)}.`,
  };
}

export function isInvalidRulesError(cause: unknown): boolean {
  return (
    (typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 'reglas-invalidas') ||
    (cause instanceof Error && cause.message.includes('reglas-invalidas'))
  );
}
export function executionError(cause: unknown, fallback: string): string {
  if (isInvalidRulesError(cause)) {
    const message = cause instanceof Error ? cause.message : '';
    const marker = message.indexOf('reglas-invalidas');
    const reason =
      marker >= 0
        ? message.slice(marker + 'reglas-invalidas'.length).replace(/^[\]\s:]+/, '')
        : message;
    return `Estas reglas no se pueden ejecutar: ${reason || 'revisa la sintaxis de esta versión.'} Revisa los parámetros o pulsa Editar reglas.`;
  }
  return `${fallback} ${cause instanceof Error ? cause.message : 'Inténtalo de nuevo.'}`;
}
