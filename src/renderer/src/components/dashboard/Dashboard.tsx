import type { SystemState } from '../../hooks/useSystemState';
import { DashboardBlock } from './DashboardBlock';
import { ConnectionBlock } from './ConnectionBlock';
import { MacroBlock } from './MacroBlock';
import { SignalsBlock } from './SignalsBlock';
import { PositionsBlock } from './PositionsBlock';
import { DrawdownBlock, ExposureBlock } from './PortfolioBlocks';
import { StrategiesBlock } from './StrategiesBlock';
import { useDashboard } from './useDashboard';
import { time } from './model';
import { dashboardTokenStylesheet } from './dashboardTokens';
import './dashboard.css';
export function Dashboard({
  system,
  paperConnected = false,
}: {
  system: SystemState;
  paperConnected?: boolean;
}) {
  const offline = system.connectivity?.status === 'offline';
  const { state, updatedAt, reload } = useDashboard(offline);
  const stopped = state.stop.data?.active ?? false;
  const connection = {
    loading: state.sources.loading || state.statuses.loading,
    error: state.sources.error || state.statuses.error,
  };
  return (
    <div className={`dashboard${offline ? ' dashboard-offline' : ''}`}>
      <style>{dashboardTokenStylesheet()}</style>
      <div className="headline">
        <h2>Situación del mercado</h2>
        <p>Seguridad, señales y cartera simulada de un vistazo.</p>
        <p role="status">
          {offline ? 'Datos congelados · ' : ''}
          {updatedAt ? `Actualizado ${time(updatedAt)}` : 'Esperando datos'}
        </p>
      </div>
      <div className="dashboard-grid">
        <DashboardBlock
          id="connection"
          title="Conexión y fuentes"
          snapshot={connection}
          reload={reload}
          action={<a href="#fuentes">Ver fuentes</a>}
        >
          <ConnectionBlock system={system} state={state} />
        </DashboardBlock>
        <DashboardBlock
          id="macro"
          title="Contexto macro"
          wide
          snapshot={state.macro}
          reload={reload}
          action={<a href="#macro">Ver macro</a>}
        >
          <MacroBlock
            series={state.macro.data ?? []}
            simulated={
              state.statuses.data?.some((row) => row.key === 'provider:macro-simulated') ?? false
            }
          />
        </DashboardBlock>
        <DashboardBlock
          id="signals"
          title="Señales vivas"
          wide
          snapshot={{
            loading: state.signals.loading || state.contradictions.loading,
            error: state.signals.error || state.contradictions.error || state.stop.error,
          }}
          reload={reload}
          action={<a href="#diario">Ver en Diario</a>}
        >
          <SignalsBlock
            signals={state.signals.data ?? []}
            contradictions={state.contradictions.data ?? []}
            stopped={stopped}
          />
        </DashboardBlock>
        <DashboardBlock
          id="positions"
          title="Posiciones simuladas"
          snapshot={state.portfolio}
          reload={reload}
        >
          <PositionsBlock
            positions={state.portfolio.data?.positions ?? []}
            paperConnected={paperConnected}
          />
        </DashboardBlock>
        <DashboardBlock id="drawdown" title="Drawdown" snapshot={state.portfolio} reload={reload}>
          <DrawdownBlock portfolio={state.portfolio.data} />
        </DashboardBlock>
        <DashboardBlock id="exposure" title="Exposición" snapshot={state.portfolio} reload={reload}>
          <ExposureBlock portfolio={state.portfolio.data} />
        </DashboardBlock>
        <DashboardBlock
          id="strategies"
          title="Estado por estrategia"
          snapshot={state.strategies}
          reload={reload}
          action={<a href="#estrategias">Ver biblioteca</a>}
        >
          <StrategiesBlock strategies={state.strategies.data ?? []} stopped={stopped} />
        </DashboardBlock>
      </div>
      <p className="dashboard-disclaimer">Tradia informa y simula; no ejecuta órdenes reales.</p>
    </div>
  );
}
