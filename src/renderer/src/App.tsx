import { OnboardingProvider, useOnboarding } from './components/onboarding/OnboardingProvider';
import { FirstStepsCard } from './components/onboarding/FirstStepsCard';
import { AiPage } from './components/ai/AiPage';
import { LabPage } from './components/lab/LabPage';
import { MesaPage } from './components/mesa/MesaPage';
import { SummaryPage } from './components/summary/SummaryPage';
import { ModelHealthPage } from './components/model-health/ModelHealthPage';
import { ChecklistPage } from './components/live/ChecklistPage';
import { LiveBanner } from './components/live/LiveBanner';
import { SmokeTestPanel } from './components/live/SmokeTestPanel';
import { ScalingStatus } from './components/live/ScalingStatus';
import { useLiveState } from './components/live/useLiveState';
import { HomePhaseNotices } from './components/HomePhaseNotices';
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
import { TradiaBrand } from './components/TradiaBrand';
import { RISK_DISCLAIMER_VERSION } from '../../shared/riskDisclaimer';
import { SettingsPage } from './components/SettingsPage';
import { MarketDataPage } from './components/MarketDataPage';
import { NewsPage, CalendarPage, SourcesPage } from './components/NewsPhasePages';
import { HomePage } from './components/HomePage';
import { ProviderBanner } from './components/ProviderBanner';
import { OfflineBanner } from './components/OfflineBanner';
import { StatusBar } from './components/SystemStatus';
import { useSystemState } from './hooks/useSystemState';
import { useScrollHint } from './hooks/useScrollHint';

type Page =
  | 'resumen'
  | 'mesa'
  | 'laboratorio'
  | 'ia'
  | 'salud-modelos'
  | 'dinero-real'
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
  const hash = window.location.hash.slice(1).split('?')[0] ?? '';
  if (hash === 'estrategias' || hash.startsWith('estrategias/')) return 'estrategias';
  if (hash === 'laboratorio' || hash.startsWith('laboratorio/')) return 'laboratorio';
  return hash === 'mesa' ||
    hash === 'inicio' ||
    hash === 'ia' ||
    hash === 'salud-modelos' ||
    hash === 'dinero-real' ||
    hash === 'ordenes' ||
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
    : 'resumen';
};

/** Lo que usa quien opera; el resto vive plegado en «Herramientas avanzadas». */
const MAIN_LINKS: { page: Page; label: string }[] = [
  { page: 'resumen', label: 'Resumen' },
  { page: 'mesa', label: 'Mercado' },
  { page: 'laboratorio', label: 'Crear' },
  { page: 'dinero-real', label: 'Dinero real' },
  { page: 'ajustes', label: 'Ajustes' },
];
const ADVANCED_LINKS: { page: Page; label: string }[] = [
  { page: 'mercado', label: 'Lista de activos' },
  { page: 'noticias', label: 'Noticias' },
  { page: 'inicio', label: 'Estado del sistema' },
  { page: 'estrategias', label: 'Estrategias' },
  { page: 'ia', label: 'IA' },
  { page: 'salud-modelos', label: 'Salud de modelos' },
  { page: 'macro', label: 'Macro' },
  { page: 'calendario', label: 'Calendario' },
  { page: 'fuentes', label: 'Fuentes' },
  { page: 'riesgo', label: 'Riesgo' },
  { page: 'diario', label: 'Diario' },
  { page: 'ordenes', label: 'Órdenes' },
  { page: 'real-vs-backtest', label: 'Real vs backtest' },
];
const ADVANCED_KEY = 'tradia.nav.advanced';
const readAdvanced = (): boolean => {
  try {
    return window.localStorage.getItem(ADVANCED_KEY) === 'open';
  } catch {
    return false;
  }
};

export default function App() {
  return (
    <RiskGate>
      <OnboardingProvider>
        <AppShell />
      </OnboardingProvider>
    </RiskGate>
  );
}

function AppShell() {
  const tour = useOnboarding();
  const [legalOpen, setLegalOpen] = useState(false);
  const legalButton = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<Page>(currentPage);
  const [advancedOpen, setAdvancedOpen] = useState(readAdvanced);
  const heading = useRef<HTMLHeadingElement>(null);
  const state = useSystemState();
  const risk = useRisk();
  const reconciliation = useReconciliation();
  const live = useLiveState();
  const real = live.state?.mode === 'activo' || live.state?.mode === 'suspendido';
  const stopped = Boolean(risk.killSwitch?.active);
  const offline = state.connectivity?.status === 'offline';
  const discrepancy = reconciliation.openDiscrepancies[0];
  const hasBanner = real || stopped || offline || Boolean(discrepancy);
  const summary = discrepancy ? (
    <p>
      Descuadre con el broker: {discrepancy.ticker ?? 'Activo no disponible'}.{' '}
      <a href="#ordenes">Ver en Órdenes</a>
    </p>
  ) : undefined;
  useEffect(() => {
    const navigate = () => {
      setPage(currentPage());
      setLegalOpen(false);
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const nav = useRef<HTMLElement>(null);
  const navMoreBelow = useScrollHint(nav);
  const previousPage = useRef(page);
  useEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    if (!tour?.open) heading.current?.focus();
  }, [page, tour?.open]);
  return (
    <div className={`app${hasBanner ? ' has-banner' : ''}`}>
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <aside className="side" data-more-below={navMoreBelow || undefined}>
        <TradiaBrand />
        <nav ref={nav} className="nav" aria-label="Principal">
          {MAIN_LINKS.map((link) => (
            <a
              key={link.page}
              href={`#${link.page}`}
              aria-current={page === link.page ? 'page' : undefined}
            >
              {link.label}
            </a>
          ))}
          <details
            className="nav-advanced"
            open={advancedOpen || ADVANCED_LINKS.some((link) => link.page === page)}
            onToggle={(event) => {
              const open = (event.currentTarget as HTMLDetailsElement).open;
              setAdvancedOpen(open);
              try {
                window.localStorage.setItem(ADVANCED_KEY, open ? 'open' : 'closed');
              } catch {
                // Sin almacenamiento solo se pierde la preferencia.
              }
            }}
          >
            <summary>Herramientas avanzadas</summary>
            {ADVANCED_LINKS.map((link) => (
              <a
                key={link.page}
                href={`#${link.page}`}
                aria-current={page === link.page ? 'page' : undefined}
              >
                {link.label}
              </a>
            ))}
          </details>
        </nav>
      </aside>
      <header className="top">
        <h1 ref={heading} tabIndex={-1}>
          {
            {
              resumen: 'Resumen',
              mesa: 'Mercado',
              laboratorio: 'Crear',
              ia: 'IA',
              'salud-modelos': 'Salud de modelos',
              'dinero-real': 'Dinero real',
              ordenes: 'Órdenes',
              'real-vs-backtest': 'Real vs backtest',
              diario: 'Diario',
              riesgo: 'Riesgo',
              inicio: 'Estado del sistema',
              mercado: 'Lista de activos',
              macro: 'Contexto macro',
              noticias: 'Noticias',
              calendario: 'Calendario',
              fuentes: 'Fuentes',
              ajustes: 'Ajustes',
              estrategias: 'Estrategias',
            }[page]
          }
        </h1>
        <span className="mode">
          {live.error
            ? 'Modo no disponible · verifica Dinero real'
            : !live.state
              ? 'Comprobando modo…'
              : real
                ? live.state.mode === 'suspendido'
                  ? 'Dinero real suspendido'
                  : 'Dinero real activo'
                : 'Señales + paper trading'}
        </span>
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
      <div className="app-banner-stack">
        <LiveBanner live={live} />
        <div className="app-global-banners" hidden={!(stopped || offline || discrepancy)}>
          <div id="risk-global-banner" />
          <OfflineBanner state={state} summary={!stopped ? summary : undefined} />
          {discrepancy && !(stopped && offline) && (
            <ReconcileBannerContent state={reconciliation} />
          )}
        </div>
        {!discrepancy && <ReconcileBannerContent state={reconciliation} />}
      </div>
      <main
        id="contenido"
        className="main"
        tabIndex={-1}
        data-layout-page={legalOpen ? 'legal' : page}
      >
        <ProviderBanner offline={state.connectivity?.status === 'offline'} />
        <div className="app-page" data-layout-block="pantalla">
          {legalOpen ? (
            <RiskDisclaimer
              onClose={() => {
                setLegalOpen(false);
                requestAnimationFrame(() => legalButton.current?.focus());
              }}
            />
          ) : page === 'resumen' ? (
            <>
              <FirstStepsCard />
              <SummaryPage />
            </>
          ) : page === 'mesa' ? (
            <MesaPage />
          ) : page === 'laboratorio' ? (
            <LabPage />
          ) : page === 'ia' ? (
            <AiPage
              onOpenStrategy={(id) => {
                window.location.hash = `estrategias/${id}`;
              }}
              onOpenMarketSources={() => {
                window.location.hash = 'mercado';
              }}
            />
          ) : page === 'salud-modelos' ? (
            <ModelHealthPage />
          ) : page === 'dinero-real' ? (
            <>
              <ChecklistPage
                onOpenValidation={() => {
                  window.location.hash = 'estrategias';
                }}
                onOpenPaper={() => {
                  window.location.hash = 'real-vs-backtest';
                }}
                onOpenAlerts={() => {
                  window.location.hash = 'ajustes';
                }}
                onOpenStrategies={() => {
                  window.location.hash = 'estrategias';
                }}
              />
              <SmokeTestPanel />
              <ScalingStatus
                onOpenEvidence={() => {
                  window.location.hash = 'real-vs-backtest';
                }}
              />
            </>
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
            <>
              <FirstStepsCard />
              <HomePhaseNotices live={live} />
              <HomePage state={state} />
            </>
          ) : page === 'mercado' || page === 'macro' ? (
            <MarketDataPage kind={page} offline={state.connectivity?.status === 'offline'} />
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
                  <button
                    ref={legalButton}
                    className="legal-link"
                    onClick={() => setLegalOpen(true)}
                  >
                    Ver aviso de riesgo, versión {RISK_DISCLAIMER_VERSION}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
      <StatusBar state={state} killSwitch={risk.killSwitch} />
    </div>
  );
}
