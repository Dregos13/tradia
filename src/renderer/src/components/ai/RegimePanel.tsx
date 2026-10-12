import type { DataFreshnessSummary } from '../../../../shared/ipc';
import { freshnessTitle, sessionDateLabel } from '../DataFreshness';
import type { RegimeOverview } from '../../../../shared/ai';
import { Badge, date, number, percent, RegimeBadge, regimeLabel, TableWrap } from './presentation';
export function RegimePanel({
  overview,
  summary,
  pauseReason,
}: {
  overview: RegimeOverview | null;
  summary: DataFreshnessSummary | null;
  pauseReason?: string;
}) {
  const market = overview?.market;
  if (pauseReason)
    return (
      <section className="ai-section" data-tour="ia-regimen" aria-labelledby="ai-regime-title">
        <h3 id="ai-regime-title">Régimen del mercado</h3>
        <p role="status">
          {freshnessTitle({
            state:
              summary && summary.state !== 'current' && summary.state !== 'no-data'
                ? summary.state
                : 'stale',
            sinceDate: summary?.sinceDate ?? null,
          })}
        </p>
        {market && (
          <p>
            Calculado con el cierre del{' '}
            <time dateTime={market.sessionDate}>{sessionDateLabel(market.sessionDate)}</time>
          </p>
        )}
        <p>En pausa: {pauseReason}. No se calcula el régimen hasta ponerse al día.</p>
      </section>
    );
  return (
    <section className="ai-section" data-tour="ia-regimen" aria-labelledby="ai-regime-title">
      <h3 id="ai-regime-title">Régimen del mercado</h3>
      {market ? (
        <>
          <p>
            Referencia {market.ticker} · Calculado con el cierre del{' '}
            <time dateTime={market.sessionDate}>{date(market.sessionDate)}</time>
          </p>
          {overview?.stale && (
            <div className="ai-warning" role="status">
              <p>
                {freshnessTitle({ state: 'stale', sinceDate: summary?.sinceDate ?? null })}
                {overview.expectedSessionDate
                  ? ` · se esperaba la sesión del ${date(overview.expectedSessionDate)}`
                  : ''}
                . El régimen y las estrategias se recalculan al ponerse al día; hasta entonces no
                habilitan ni desactivan nada.
              </p>
            </div>
          )}
          <div className="ai-regime-summary">
            <RegimeBadge label={market.direction} />
            <RegimeBadge label={market.volatility} />
            {overview?.stale && <Badge kind="regime-unknown">Desactualizado</Badge>}
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
                    {overview?.expectedSessionDate &&
                      asset.sessionDate < overview.expectedSessionDate && (
                        <small> · desactualizado</small>
                      )}
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
