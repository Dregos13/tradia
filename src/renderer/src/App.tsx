import { OrdersPage } from './components/orders/OrdersPage';
import { ReconcileBannerContent } from './components/orders/ReconcileBanner';
import { DeviationPage } from './components/deviation/DeviationPage';
import { useReconciliation } from './hooks/useOrders';
import { KillSwitchControl } from './components/risk/KillSwitchControl';
import { JournalPage } from './components/journal/JournalPage';
import { RiskPage } from './components/risk/RiskPage';
import { useRisk } from './hooks/useRisk';
import { useEffect, useRef, useState } from 'react';
import { StrategiesPage } from './components/strategies/StrategiesPage';
import { RiskGate } from './components/RiskGate';
import { RiskDisclaimer } from './components/RiskDisclaimer';
import { RISK_DISCLAIMER_VERSION } from '../../shared/riskDisclaimer';
import { SettingsPage } from './components/SettingsPage';
import { MarketDataPage } from './components/MarketDataPage';
import { NewsPage, CalendarPage, SourcesPage } from './components/NewsPhasePages';
import { HomePage } from './components/HomePage';
import { ProviderBanner } from './components/ProviderBanner';
import { OfflineBanner } from './components/OfflineBanner';
import { StatusBar } from './components/SystemStatus';
import { useSystemState } from './hooks/useSystemState';

type Page =
  | 'ordenes'
  | 'real-vs-backtest'
  | 'diario'
  | 'riesgo'
  | 'inicio'
  | 'mercado'
  | 'macro'
  | 'noticias'
  | 'calendario'
  | 'fuentes'
  | 'ajustes'
  | 'estrategias';
const currentPage = (): Page => {
  const hash = window.location.hash.slice(1);
  if (hash === 'estrategias' || hash.startsWith('estrategias/')) return 'estrategias';
  return hash === 'ordenes' ||
    hash === 'real-vs-backtest' ||
    hash === 'diario' ||
    hash === 'riesgo' ||
    hash === 'mercado' ||
    hash === 'macro' ||
    hash === 'noticias' ||
    hash === 'calendario' ||
    hash === 'fuentes' ||
    hash === 'ajustes'
    ? hash
    : 'inicio';
};

export default function App() {
  return (
    <RiskGate>
      <AppShell />
    </RiskGate>
  );
}

function AppShell() {
  const [legalOpen, setLegalOpen] = useState(false);
  const legalButton = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<Page>(currentPage);
  const heading = useRef<HTMLHeadingElement>(null);
  const state = useSystemState();
  const risk = useRisk();
  const reconciliation = useReconciliation();
  const stopped = Boolean(risk.killSwitch?.active);
  const offline = state.connectivity?.status === 'offline';
  const discrepancy = reconciliation.openDiscrepancies[0];
  const hasBanner = stopped || offline || Boolean(discrepancy);
  const summary = discrepancy ? (
    <p>
      Descuadre con el broker: {discrepancy.ticker ?? 'Activo no disponible'}.{' '}
      <a href="#ordenes">Ver en Órdenes</a>
    </p>
  ) : undefined;
  useEffect(() => {
    const navigate = () => {
      setPage(currentPage());
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const previousPage = useRef(page);
  useEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    heading.current?.focus();
  }, [page]);
  return (
    <div className={`app${hasBanner ? ' has-banner' : ''}`}>
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <aside className="side">
        <div className="logo">Tradia</div>
        <nav className="nav" aria-label="Principal">
          <a href="#inicio" aria-current={page === 'inicio' ? 'page' : undefined}>
            Inicio
          </a>
          <a href="#mercado" aria-current={page === 'mercado' ? 'page' : undefined}>
            Mercado
          </a>
          <a href="#macro" aria-current={page === 'macro' ? 'page' : undefined}>
            Macro
          </a>
          {(['noticias', 'calendario', 'fuentes'] as const).map((route) => (
            <a key={route} href={`#${route}`} aria-current={page === route ? 'page' : undefined}>
              {{ noticias: 'Noticias', calendario: 'Calendario', fuentes: 'Fuentes' }[route]}
            </a>
          ))}
          <a href="#estrategias" aria-current={page === 'estrategias' ? 'page' : undefined}>
            Estrategias
          </a>
          <a href="#riesgo" aria-current={page === 'riesgo' ? 'page' : undefined}>
            Riesgo
          </a>
          <a href="#diario" aria-current={page === 'diario' ? 'page' : undefined}>
            Diario
          </a>
          <a href="#ordenes" aria-current={page === 'ordenes' ? 'page' : undefined}>
            Órdenes
          </a>
          <a
            href="#real-vs-backtest"
            aria-current={page === 'real-vs-backtest' ? 'page' : undefined}
          >
            Real vs backtest
          </a>
          <a href="#ajustes" aria-current={page === 'ajustes' ? 'page' : undefined}>
            Ajustes
          </a>
        </nav>
      </aside>
      <header className="top">
        <h1 ref={heading} tabIndex={-1}>
          {
            {
              ordenes: 'Órdenes',
              'real-vs-backtest': 'Real vs backtest',
              diario: 'Diario',
              riesgo: 'Riesgo',
              inicio: 'Estado del sistema',
              mercado: 'Mercado',
              macro: 'Contexto macro',
              noticias: 'Noticias',
              calendario: 'Calendario',
              fuentes: 'Fuentes',
              ajustes: 'Ajustes',
              estrategias: 'Estrategias',
            }[page]
          }
        </h1>
        <span className="mode">Señales + paper trading</span>
        <KillSwitchControl
          state={risk.killSwitch}
          onChange={risk.updateKillSwitch}
          summary={
            stopped ? (
              <>
                {offline && (
                  <p>
                    Sin conexión. <a href="#inicio">Ver estado</a>
                  </p>
                )}
                {summary}
              </>
            ) : undefined
          }
        />
      </header>
      <div className="app-global-banners" hidden={!hasBanner}>
        <div id="risk-global-banner" />
        <OfflineBanner state={state} summary={!stopped ? summary : undefined} />
        {discrepancy && !(stopped && offline) && <ReconcileBannerContent state={reconciliation} />}
      </div>
      {!discrepancy && <ReconcileBannerContent state={reconciliation} />}
      <main id="contenido" className="main" tabIndex={-1}>
        <ProviderBanner />
        {legalOpen ? (
          <RiskDisclaimer
            onClose={() => {
              setLegalOpen(false);
              requestAnimationFrame(() => legalButton.current?.focus());
            }}
          />
        ) : page === 'ordenes' ? (
          <OrdersPage />
        ) : page === 'real-vs-backtest' ? (
          <DeviationPage />
        ) : page === 'diario' ? (
          <JournalPage />
        ) : page === 'riesgo' ? (
          <RiskPage risk={risk} />
        ) : page === 'estrategias' ? (
          <StrategiesPage />
        ) : page === 'inicio' ? (
          <HomePage state={state} />
        ) : page === 'mercado' || page === 'macro' ? (
          <MarketDataPage kind={page} />
        ) : page === 'noticias' ? (
          <NewsPage />
        ) : page === 'calendario' ? (
          <CalendarPage />
        ) : page === 'fuentes' ? (
          <SourcesPage />
        ) : (
          <>
            <SettingsPage state={state} />
            <section className="settings-section" aria-labelledby="legal-heading">
              <div>
                <h2 id="legal-heading">Legal</h2>
                <p>Información siempre accesible.</p>
              </div>
              <div className="legal-panel">
                <p>
                  Tradia no es asesoramiento financiero. El modo predeterminado usa señales
                  informativas y paper trading.
                </p>
                <button ref={legalButton} className="legal-link" onClick={() => setLegalOpen(true)}>
                  Ver aviso de riesgo, versión {RISK_DISCLAIMER_VERSION}
                </button>
              </div>
            </section>
          </>
        )}
      </main>
      <StatusBar state={state} />
    </div>
  );
}
