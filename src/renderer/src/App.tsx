import { useEffect, useRef, useState } from 'react';
import { HomePage } from './components/HomePage';
import { StatusBar } from './components/SystemStatus';
import { useSystemState } from './hooks/useSystemState';

type Page = 'inicio' | 'ajustes';
const currentPage = (): Page => (window.location.hash === '#ajustes' ? 'ajustes' : 'inicio');

export default function App() {
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
  return (
    <div className="app">
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
      <main id="contenido" className="main" tabIndex={-1}>
        {page === 'inicio' ? (
          <HomePage state={state} />
        ) : (
          <>
            <div className="headline">
              <h2>Tu aplicación, bajo tus reglas.</h2>
              <p>Preferencias de la aplicación de escritorio.</p>
            </div>
            <section className="empty" aria-label="Preferencias">
              <h3>Ajustes pendientes de integración</h3>
              <p>
                El inicio automático, las notificaciones, las claves de API y el aviso legal se
                incorporarán aquí.
              </p>
            </section>
          </>
        )}
      </main>
      <StatusBar state={state} />
    </div>
  );
}
