import { useBacktestReport } from '../../hooks/useBacktest';
import type { BacktestReport } from '../../../../shared/backtest';
import { RiskDisclaimer } from '../RiskDisclaimer';
import { number } from '../strategies/model';
import { EquityChart } from './EquityChart';
import { Robustness, pct } from './Robustness';
import { TradesTable } from './TradesTable';
import { BacktestHistory } from './BacktestHistory';
import './backtest.css';
const noticeTitles: Record<string, string> = {
  'sesgo-supervivencia': 'Sesgo de supervivencia residual',
  'pocas-operaciones': 'Pocas operaciones',
  'mercados-sin-datos': 'Mercados sin datos',
  'rendimientos-pasados': 'Rendimientos pasados',
  'datos-simulados': 'Datos simulados · entorno de pruebas',
  'datos-reales': 'Procedencia de datos reales',
  'oos-sharpe-decay': 'Posible sobreajuste',
  'sensitivity-collapse': 'Posible sobreajuste',
  'monte-carlo-tail': 'Posible sobreajuste',
};
export function BacktestReportPage({ strategyId, runId }: { strategyId: number; runId: number }) {
  const state = useBacktestReport(runId);
  if (state.loading)
    return (
      <p role="status" aria-busy="true">
        Cargando informe…
      </p>
    );
  if (state.error)
    return (
      <p role="alert">
        {state.error} <button onClick={() => void state.reload()}>Reintentar informe</button>
      </p>
    );
  if (!state.report || state.report.strategyId !== strategyId)
    return (
      <p role="alert">
        Este informe no existe para esta estrategia.{' '}
        <a href={`#estrategias/${strategyId}`}>Volver a la ficha</a>
      </p>
    );
  return <Report report={state.report} />;
}
export function Report({ report: r }: { report: BacktestReport }) {
  const m = r.metrics;
  const metrics = [
    ['Rentabilidad', pct(m.totalReturn)],
    ['Drawdown máximo', pct(m.maxDrawdown?.pct)],
    [
      'Sharpe',
      m.sharpeInfinite ? `${m.sharpeInfinite === 'negative' ? '−' : ''}∞` : number(m.sharpe),
    ],
    ['Factor de beneficio', m.profitFactorInfinite ? '∞' : number(m.profitFactor)],
    ['Tasa de acierto', pct(m.winRate)],
    ['Expectativa', number(m.expectancy, ' USD')],
    ['Racha perdedora máxima', number(m.maxLosingStreak)],
    ['Número de operaciones', number(m.tradeCount)],
  ];
  return (
    <>
      <a href={`#estrategias/${r.strategyId}/v${r.version}`}>Volver a la ficha · v{r.version}</a>
      <header className="strategy-heading">
        <div>
          <h2>Informe de backtest</h2>
          <p>
            Informe #{r.id} · v{r.version} ·{' '}
            {r.kind === 'prueba-final' ? 'Prueba final' : 'Entrenamiento y validación'}
          </p>
          <strong>{r.dataSource === 'real' ? 'Datos reales' : 'Datos simulados'}</strong>
          <p>
            Proveedor: {r.providerId} · {r.createdAt}
          </p>
        </div>
      </header>
      {r.warnings.map((w, i) => (
        <aside className={`backtest-notice notice-${w.severity}`} key={`${w.rule}-${i}`}>
          <strong>{noticeTitles[w.rule] ?? w.rule}</strong>
          <p>{w.message}</p>
        </aside>
      ))}
      <dl className="strategy-metrics" aria-label="Ocho métricas del backtest">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <section className="strategy-section">
        <h3>Configuración y división de datos</h3>
        <p>
          Periodo pedido: {r.config.desde} → {r.config.hasta} · Ejecutado hasta:{' '}
          {r.config.ejecutadoHasta ?? 'Sin datos'}
        </p>
        <p>
          Mercados: {r.config.markets.join(', ')} · Parámetros:{' '}
          {Object.entries(r.config.parameters)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')}
        </p>
        <p>
          Comisión {number(r.costs.commissionPct, ' %')} · mínimo{' '}
          {number(r.costs.commissionMin, ' USD')} · slippage {number(r.costs.slippageBps, ' pb')} ·
          spread {number(r.costs.spreadBps, ' pb')}
        </p>
        {r.split && (
          <dl>
            {(['train', 'validation', 'test'] as const).map((k) => (
              <div key={k}>
                <dt>
                  {
                    {
                      train: 'Entrenamiento',
                      validation: 'Validación',
                      test: 'Prueba final reservada',
                    }[k]
                  }
                </dt>
                <dd>
                  {r.split![k].startDate} → {r.split![k].endDate} · {r.split!.counts[k]} sesiones
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p>
          Prueba final ·{' '}
          {r.finalTest.status === 'ejecutada'
            ? 'ejecutada y bloqueada'
            : 'disponible, sin ejecutar'}
        </p>
        {r.finalTest.runId && (
          <a href={`#estrategias/${r.strategyId}/backtest/${r.finalTest.runId}`}>
            Ver informe de prueba final
          </a>
        )}
      </section>
      <EquityChart report={r} />
      <Robustness report={r} />
      <TradesTable key={r.id} trades={r.trades} />
      <RiskDisclaimer inline />
      <BacktestHistory strategyId={r.strategyId} version={r.version} />
    </>
  );
}
