import type { SignalStrategyState } from '../../../../shared/signals';
const statuses = {
  activa: '● Activa',
  paper: '◇ Paper',
  degradada: '△ Degradada',
  investigacion: '◌ Investigación',
  retirada: 'Ⅱ En pausa · Retirada',
};
const outcomes = { senal: 'Señal', 'sin-senal': 'Sin señal', vetada: 'Vetada', error: 'Error' };
export function StrategiesBlock({
  strategies,
  stopped,
}: {
  strategies: SignalStrategyState[];
  stopped: boolean;
}) {
  return (
    <>
      {!strategies.length && (
        <p>
          No hay estrategias. <a href="#estrategias">Crear una estrategia</a>
        </p>
      )}
      <ul className="dashboard-list">
        {strategies.map((strategy) => (
          <li key={strategy.strategyId}>
            <div className="dashboard-row">
              <a href={`#estrategias/${strategy.strategyId}`}>{strategy.name}</a>
              <span className={`dashboard-badge dashboard-strategy-${strategy.status}`}>
                {statuses[strategy.status]}
              </span>
            </div>
            <p>
              v{strategy.version} · cierre {strategy.lastBarDate ?? 'Sin evaluar'}
            </p>
            <p>
              {stopped
                ? 'Bloqueada por parada'
                : strategy.lastOutcome
                  ? outcomes[strategy.lastOutcome]
                  : 'Pendiente del primer cierre'}
            </p>
            {strategy.lastSignalId !== null && (
              <a href={`#diario?signalId=${strategy.lastSignalId}`}>Ver evaluación en Diario</a>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
