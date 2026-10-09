import { useEffect, useRef, useState } from 'react';
import { useStrategies, useStrategy } from '../../hooks/useStrategies';
import { StrategyLibrary } from './StrategyLibrary';
import { StrategyForm } from './StrategyForm';
import { StrategyDetail } from './StrategyDetail';
import { strategyTokenStylesheet } from './strategyTokens';
import './strategies.css';
export function StrategiesPage() {
  const [route, setRoute] = useState(window.location.hash);
  const heading = useRef<HTMLDivElement>(null);
  const currentRoute = useRef(route);
  const library = useStrategies();
  useEffect(() => {
    const navigate = () => {
      if (currentRoute.current === window.location.hash) return;
      currentRoute.current = window.location.hash;
      setRoute(window.location.hash);
      if (window.location.hash === '#estrategias') void library.reload();
      heading.current?.focus();
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, [library.reload]);
  const match = /^#estrategias\/(\d+)(?:\/(v[1-9]\d*|editar))?$/.exec(route);
  return (
    <div className="strategies-page" ref={heading} tabIndex={-1}>
      <style>{strategyTokenStylesheet()}</style>
      {route === '#estrategias/nueva' ? (
        <StrategyForm
          save={async (draft) => {
            const result = await library.create(draft);
            window.location.hash = `estrategias/${result.id}`;
          }}
        />
      ) : match ? (
        <StrategyRoute
          key={route}
          id={Number(match[1])}
          version={match[2]?.startsWith('v') ? Number(match[2].slice(1)) : undefined}
          edit={match[2] === 'editar'}
        />
      ) : route !== '#estrategias' ? (
        <p role="alert">
          Ruta de estrategia no válida. <a href="#estrategias">Volver a la biblioteca</a>
        </p>
      ) : library.loading ? (
        <p role="status" aria-busy="true">
          Cargando estrategias…
        </p>
      ) : library.error ? (
        <p role="alert">
          {library.error} <button onClick={() => void library.reload()}>Reintentar</button>
        </p>
      ) : (
        <StrategyLibrary strategies={library.strategies} />
      )}
    </div>
  );
}
function StrategyRoute({ id, version, edit }: { id: number; version?: number; edit: boolean }) {
  const detail = useStrategy(id, version);
  const actions = useStrategies();
  if (detail.loading)
    return (
      <p role="status" aria-busy="true">
        Cargando ficha…
      </p>
    );
  if (detail.error)
    return (
      <p role="alert">
        {detail.error} <button onClick={() => void detail.reload()}>Reintentar</button>
      </p>
    );
  if (!detail.strategy || !detail.latest)
    return (
      <p role="alert">
        Esta estrategia o versión no existe. <a href="#estrategias">Volver a la biblioteca</a>
      </p>
    );
  if (edit)
    return (
      <StrategyForm
        strategy={detail.latest}
        save={async (draft, note) => {
          const result = await actions.update({ ...draft, id, note });
          window.location.hash = `estrategias/${id}/v${result.version}`;
        }}
      />
    );
  return (
    <StrategyDetail
      strategy={detail.strategy}
      latest={detail.latest}
      history={detail.history ?? []}
      changeStatus={async (status) => {
        await actions.setStatus({ id, status });
        await detail.reload();
      }}
    />
  );
}
