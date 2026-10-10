import type { StrategyRegimeStatus } from '../../../../shared/ai';
import { Badge, regimeLabel, TableWrap } from './presentation';
export function StrategyRegimeTable({
  strategies,
  onOpenStrategy,
}: {
  strategies: StrategyRegimeStatus[];
  onOpenStrategy?: (id: number) => void;
}) {
  return (
    <section className="ai-section" aria-labelledby="ai-strategies-title">
      <h3 id="ai-strategies-title">Estrategias según el régimen</h3>
      {!strategies.length ? (
        <p>Aún no hay estrategias evaluadas por régimen.</p>
      ) : (
        <TableWrap label="Estrategias según el régimen">
          <table>
            <caption>Decisión por régimen de cada estrategia</caption>
            <thead>
              <tr>
                {['Estrategia', 'Estado por régimen', 'Funciona en', 'Falla en', 'Motivo'].map(
                  (label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => (
                <tr key={strategy.strategyId}>
                  <th scope="row">
                    {strategy.name}
                    <small>
                      v{strategy.version} · {strategy.status}
                    </small>
                    {onOpenStrategy && (
                      <button
                        className="button"
                        onClick={() => onOpenStrategy(strategy.strategyId)}
                        aria-label={`Ver ficha de ${strategy.name}`}
                      >
                        Ver ficha
                      </button>
                    )}
                  </th>
                  <td>
                    <Badge
                      kind={`eligibility-${strategy.regimeState === 'habilitada' ? 'enabled' : strategy.regimeState === 'degradada' ? 'degraded' : 'disabled'}`}
                    >
                      {strategy.regimeState === 'habilitada'
                        ? 'Activa por régimen'
                        : strategy.regimeState === 'degradada'
                          ? 'Degradada'
                          : 'Desactivada por régimen'}
                    </Badge>
                  </td>
                  <td>
                    {strategy.worksIn.map(regimeLabel).join(', ') || 'Sin restricción declarada'}
                  </td>
                  <td>{strategy.failsIn.map(regimeLabel).join(', ') || 'Ninguno declarado'}</td>
                  <td>{strategy.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}
