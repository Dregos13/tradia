import type { RegimeOverview } from '../../../../shared/ai';
import { date, number, percent, RegimeBadge, regimeLabel, TableWrap } from './presentation';
export function RegimePanel({ overview }: { overview: RegimeOverview | null }) {
  const market = overview?.market;
  return (
    <section className="ai-section" aria-labelledby="ai-regime-title">
      <h3 id="ai-regime-title">Régimen del mercado</h3>
      {market ? (
        <>
          <p>
            Referencia {market.ticker} · cierre{' '}
            <time dateTime={market.sessionDate}>{date(market.sessionDate)}</time>
          </p>
          <div className="ai-regime-summary">
            <RegimeBadge label={market.direction} />
            <RegimeBadge label={market.volatility} />
          </div>
          <p>
            Dirección: ADX(14){' '}
            {market.metrics.adx === null ? 'No calculado' : number(market.metrics.adx)} · pendiente
            SMA50{' '}
            {market.metrics.smaSlope === null ? 'No calculada' : number(market.metrics.smaSlope, 4)}
          </p>
          <p>
            Volatilidad realizada 20 sesiones:{' '}
            {market.metrics.realizedVolatility === null
              ? 'No calculada'
              : percent(market.metrics.realizedVolatility)}{' '}
            · mediana de 252:{' '}
            {market.metrics.volatilityMedian === null
              ? 'No calculada'
              : percent(market.metrics.volatilityMedian)}
          </p>
        </>
      ) : (
        <>
          <p>Todavía no hay cierres suficientes para clasificar el régimen</p>
          <p>Se necesitan velas diarias válidas antes de calcular el mercado y los activos.</p>
        </>
      )}
      <p className="ai-hint">El régimen se recalcula al cierre; no predice por sí solo.</p>
      <h4>Régimen por activo</h4>
      {overview?.assets.length ? (
        <TableWrap label="Régimen por activo">
          <table>
            <caption>Régimen por activo</caption>
            <thead>
              <tr>
                {[
                  'Activo',
                  'Dirección',
                  'Volatilidad',
                  'Calculado con datos hasta',
                  'Cambio anterior',
                ].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.assets.map((asset) => (
                <tr key={asset.ticker}>
                  <th scope="row">{asset.ticker}</th>
                  <td>
                    <RegimeBadge label={asset.direction} />
                  </td>
                  <td>
                    <RegimeBadge label={asset.volatility} />
                  </td>
                  <td>
                    <time dateTime={asset.sessionDate}>{date(asset.sessionDate)}</time>
                  </td>
                  <td>
                    {asset.previousChange
                      ? `${regimeLabel(asset.previousChange.direction)} → ${regimeLabel(asset.direction)} · ${date(asset.previousChange.sessionDate)}`
                      : 'Sin cambio anterior registrado'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <p>Aún no hay regímenes calculados para los activos.</p>
      )}
    </section>
  );
}
