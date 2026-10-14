import { assetSymbol, fxLabel, fxPrice } from '../assetPresentation';
import { isFxSymbol, PAPER_ACCOUNT_CURRENCY } from '../../../../shared/fxTrading';
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
                <strong>{assetSymbol(position.ticker)}</strong>
                <span>{direction(position.direction)}</span>
              </div>
              {isFxSymbol(position.ticker) && <p>{fxLabel(position.ticker)}</p>}
              <dl className="dashboard-position">
                <div>
                  <dt>Tamaño</dt>
                  <dd>
                    {number(position.size)} {isFxSymbol(position.ticker) ? position.currency : 'u'}
                  </dd>
                </div>
                <div>
                  <dt>Entrada</dt>
                  <dd>
                    {isFxSymbol(position.ticker) ? fxPrice(position.entry) : number(position.entry)}{' '}
                    {isFxSymbol(position.ticker) ? PAPER_ACCOUNT_CURRENCY : position.currency}
                  </dd>
                </div>
                <div>
                  <dt>Último precio</dt>
                  <dd>
                    {position.markPrice === null
                      ? 'Sin cotización'
                      : `${isFxSymbol(position.ticker) ? fxPrice(position.markPrice) : number(position.markPrice)} ${isFxSymbol(position.ticker) ? PAPER_ACCOUNT_CURRENCY : position.currency}`}
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
                      : `${position.pnl >= 0 ? '+' : ''}${number(position.pnl)} ${isFxSymbol(position.ticker) ? PAPER_ACCOUNT_CURRENCY : position.currency}`}{' '}
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
