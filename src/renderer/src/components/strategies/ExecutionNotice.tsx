export const RULES_BLOCKED_HELP = 'Desactivado hasta que las reglas se puedan ejecutar.';
export function ExecutionNotice({
  executable = false,
  reason,
  strategyId,
  readOnly = false,
}: {
  executable?: boolean;
  reason?: string;
  strategyId?: number;
  readOnly?: boolean;
}) {
  return (
    <section
      className={`strategy-execution ${executable ? 'strategy-execution-valid' : 'strategy-execution-invalid'}`}
      aria-label={executable ? 'Reglas ejecutables' : 'Reglas no ejecutables'}
      role="status"
    >
      <h3>{executable ? 'Reglas listas para ejecutar' : 'Reglas no ejecutables'}</h3>
      <p>
        {executable
          ? 'Entrada, salida, stop y objetivo son válidos para esta versión. Puedes lanzar un backtest o las pruebas de estrés.'
          : `Estas reglas no se pueden ejecutar: ${reason || 'revisa la sintaxis y los parámetros de esta versión.'}`}
      </p>
      {!executable && strategyId !== undefined && !readOnly && (
        <a href={`#estrategias/${strategyId}/editar`}>Editar reglas</a>
      )}
    </section>
  );
}
