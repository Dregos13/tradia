import type { PaperPosition } from '../../../../shared/signals';
import { direction, number } from './model';
export function PositionsBlock({
  positions,
  paperConnected = false,
}: {
  positions: PaperPosition[];
  paperConnected?: boolean;
}) {
  return (
    <>
      <span className="dashboard-badge dashboard-paper">
        {paperConnected ? 'Paper conectado' : '◇ Simulación'}
      </span>
      {!positions.length ? (
        <p>No hay posiciones simuladas abiertas. Aparecerán al aprobarse una señal.</p>
      ) : (
        <ul className="dashboard-list">
          {positions.map((position) => (
            <li key={position.id}>
              <div className="dashboard-row">
                <strong>{position.ticker}</strong>
                <span>{direction(position.direction)}</span>
              </div>
              <dl className="dashboard-position">
                <div>
                  <dt>Tamaño</dt>
                  <dd>{number(position.size)} u</dd>
                </div>
                <div>
                  <dt>Entrada</dt>
                  <dd>
                    {number(position.entry)} {position.currency}
                  </dd>
                </div>
                <div>
                  <dt>Último precio</dt>
                  <dd>
                    {position.markPrice === null
                      ? 'Sin cotización'
                      : `${number(position.markPrice)} ${position.currency}`}
                  </dd>
                </div>
                <div>
                  <dt>P&amp;L</dt>
                  <dd
                    className={
                      position.pnl === null
                        ? ''
                        : position.pnl >= 0
                          ? 'dashboard-positive'
                          : 'dashboard-negative'
                    }
                  >
                    {position.pnl === null
                      ? 'Sin cotización'
                      : `${position.pnl >= 0 ? '+' : ''}${number(position.pnl)} ${position.currency}`}{' '}
                    {position.pnlPct !== null &&
                      `(${position.pnlPct >= 0 ? '+' : ''}${number(position.pnlPct)} %)`}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <p>No son posiciones reales.</p>
    </>
  );
}
