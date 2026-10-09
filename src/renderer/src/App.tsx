import { KillSwitchControl } from './components/risk/KillSwitchControl';
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
  return hash === 'riesgo' ||
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
    <div
      className={`app${state.connectivity?.status === 'offline' || risk.killSwitch?.active ? ' has-banner' : ''}`}
    >
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
          <a href="#ajustes" aria-current={page === 'ajustes' ? 'page' : undefined}>
            Ajustes
          </a>
        </nav>
      </aside>
      <header className="top">
        <h1 ref={heading} tabIndex={-1}>
          {
            {
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
        <KillSwitchControl state={risk.killSwitch} onChange={risk.updateKillSwitch} />
      </header>
      <div
        className="app-global-banners"
        hidden={!risk.killSwitch?.active && state.connectivity?.status !== 'offline'}
      >
        <div id="risk-global-banner" />
        <OfflineBanner state={state} />
      </div>
      <main id="contenido" className="main" tabIndex={-1}>
        <ProviderBanner />
        {legalOpen ? (
          <RiskDisclaimer
            onClose={() => {
              setLegalOpen(false);
              requestAnimationFrame(() => legalButton.current?.focus());
            }}
          />
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
