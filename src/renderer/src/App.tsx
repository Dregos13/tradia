import { useEffect, useRef, useState } from 'react';
import { RiskGate } from './components/RiskGate';
import { RiskDisclaimer } from './components/RiskDisclaimer';
import { RISK_DISCLAIMER_VERSION } from '../../shared/riskDisclaimer';
import { SettingsPage } from './components/SettingsPage';
import { HomePage } from './components/HomePage';
import { OfflineBanner } from './components/OfflineBanner';
import { StatusBar } from './components/SystemStatus';
import { useSystemState } from './hooks/useSystemState';

type Page = 'inicio' | 'ajustes';
const currentPage = (): Page => (window.location.hash === '#ajustes' ? 'ajustes' : 'inicio');

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
  if (legalOpen)
    return (
      <RiskDisclaimer
        onClose={() => {
          setLegalOpen(false);
          requestAnimationFrame(() => legalButton.current?.focus());
        }}
      />
    );
  return (
    <div className={`app${state.connectivity?.status === 'offline' ? ' has-banner' : ''}`}>
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <aside className="side">
        <div className="logo">Tradia</div>
        <nav className="nav" aria-label="Principal">
          <a href="#inicio" aria-current={page === 'inicio' ? 'page' : undefined}>
            Inicio
          </a>
          <a href="#ajustes" aria-current={page === 'ajustes' ? 'page' : undefined}>
            Ajustes
          </a>
        </nav>
      </aside>
      <header className="top">
        <h1 ref={heading} tabIndex={-1}>
          {page === 'inicio' ? 'Estado del sistema' : 'Ajustes'}
        </h1>
        <span className="mode">Señales + paper trading</span>
      </header>
      <OfflineBanner state={state} />
      <main id="contenido" className="main" tabIndex={-1}>
        {page === 'inicio' ? (
          <HomePage state={state} />
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
