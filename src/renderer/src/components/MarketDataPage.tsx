import { useEffect, useState } from 'react';
import { useMarketData } from '../hooks/useMarketData';

/** Shell for the watchlist/chart and macro panel implemented in the next tasks. */
export function MarketDataPage({ kind }: { kind: 'mercado' | 'macro' }) {
  const data = useMarketData();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [keyError, setKeyError] = useState(false);
  useEffect(() => {
    let active = true;
    setConfigured(null);
    setKeyError(false);
    void window.tradia.secrets
      .hasKey(kind === 'mercado' ? 'tiingo' : 'fred')
      .then((value) => {
        if (active) setConfigured(value);
      })
      .catch(() => {
        if (active) setKeyError(true);
      });
    return () => {
      active = false;
    };
  }, [kind]);
  return (
    <section aria-label={kind === 'mercado' ? 'Datos de mercado' : 'Datos macro'}>
      <div className="headline">
        <h2>
          {kind === 'mercado' ? 'Tu mercado, con perspectiva.' : 'El contexto detrás del precio.'}
        </h2>
        <p>
          {kind === 'mercado'
            ? 'Precios diarios ajustados por splits y dividendos.'
            : 'Tipos, IPC, curva de tipos y volatilidad. Fuente: FRED.'}
        </p>
      </div>
      {keyError || (configured && data.error) ? (
        <div className="data-empty" role="alert">
          <p>
            {keyError
              ? 'No pudimos comprobar la configuración de tus fuentes. Vuelve a abrir esta sección.'
              : data.error}
          </p>
          {!keyError && (
            <button className="button" onClick={() => void data.reload()}>
              Reintentar
            </button>
          )}
        </div>
      ) : configured === null || (configured && data.loading) ? (
        <p role="status">Consultando fuentes de datos…</p>
      ) : !configured ? (
        <div className="data-empty">
          <h3>Conecta tus fuentes de datos.</h3>
          <p>
            Añade las claves de Tiingo y FRED para recibir precios y contexto macro actualizados.
          </p>
          <a className="button primary" href="#ajustes">
            Configurar claves
          </a>
        </div>
      ) : (
        <div className="data-empty">
          <h3>
            {kind === 'mercado'
              ? data.watchlist.length
                ? 'Lista de seguimiento disponible'
                : 'Tu lista está vacía.'
              : 'Contexto macro'}
          </h3>
          <p>
            {kind === 'mercado'
              ? data.watchlist.length
                ? `${data.watchlist.length} activos en seguimiento.`
                : 'Añade un ticker concreto o incorpora los 25 activos del universo inicial.'
              : data.series.some((series) => series.observations.length)
                ? 'Series disponibles. El panel de indicadores se incorporará en la siguiente entrega.'
                : 'Todavía no hay observaciones. Las series aparecerán cuando termine la primera actualización.'}
          </p>
        </div>
      )}
    </section>
  );
}
