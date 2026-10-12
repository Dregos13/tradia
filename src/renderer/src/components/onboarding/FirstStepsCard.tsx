import { useEffect, useState } from 'react';
import type { DataStatusEntry } from '../../../../shared/ipc';
import { useOnboarding } from './OnboardingProvider';
import { FIRST_STEPS_HIDDEN_KEY, navigateAndFocus, readStorage, writeStorage } from './storage';
import { TOUR_STEPS } from './tourSteps';

interface Configuration {
  tiingo: boolean;
  fred: boolean;
  keychainUnavailable: boolean;
  statuses: DataStatusEntry[];
  hasSources: boolean;
}
type RowState = 'done' | 'pending' | 'attention';
function Badge({ state }: { state: RowState }) {
  return (
    <span className={`first-steps-badge ${state}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {state === 'attention' ? (
          <>
            <path d="m12 3 10 18H2Z" />
            <path d="M12 9v5m0 3v1" />
          </>
        ) : (
          <>
            <circle
              cx="12"
              cy="12"
              r="9"
              strokeDasharray={state === 'pending' ? '3 3' : undefined}
            />
            {state === 'done' && <path d="m7 12 3 3 7-7" />}
          </>
        )}
      </svg>
      {{ done: 'Hecho', pending: 'Pendiente', attention: 'Revisar' }[state]}
    </span>
  );
}
export function FirstStepsCard() {
  const tour = useOnboarding();
  const [config, setConfig] = useState<Configuration | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [hidden, setHidden] = useState(() => readStorage(FIRST_STEPS_HIDDEN_KEY) === 'true');
  useEffect(() => {
    let active = true;
    let generation = 0;
    async function load() {
      const current = ++generation;
      setLoading(true);
      const results = await Promise.allSettled([
        window.tradia.secrets.hasKey('tiingo'),
        window.tradia.secrets.hasKey('fred'),
        window.tradia.dataStatus.get(),
        window.tradia.sources.list(),
      ] as const);
      if (!active || current !== generation) return;
      const [tiingo, fred, statuses, sources] = results;
      const keyErrors = [tiingo, fred].filter((result) => result.status === 'rejected');
      const unavailable =
        keyErrors.length > 0 &&
        keyErrors.every(
          (result) =>
            result.status === 'rejected' &&
            /safeStorage|cifrado|llavero|keychain/i.test(String(result.reason)),
        );
      if (
        statuses.status === 'rejected' ||
        sources.status === 'rejected' ||
        (keyErrors.length && !unavailable)
      ) {
        setError(true);
      } else {
        const keysDone =
          tiingo.status === 'fulfilled' &&
          tiingo.value &&
          fred.status === 'fulfilled' &&
          fred.value;
        // Invalida la preferencia antes de publicar la configuración que hace reaparecer la tarjeta.
        if (!keysDone) {
          writeStorage(FIRST_STEPS_HIDDEN_KEY, null);
          setHidden(false);
        }
        setConfig({
          tiingo: tiingo.status === 'fulfilled' && tiingo.value,
          fred: fred.status === 'fulfilled' && fred.value,
          keychainUnavailable: unavailable,
          statuses: statuses.value,
          hasSources: sources.value.some((source) => source.active),
        });
        setError(false);
      }
      setLoading(false);
    }
    void load();
    const off = window.tradia.dataStatus.onChanged(() => void load());
    const offNews = window.tradia.news.onUpdated(() => void load());
    window.addEventListener('focus', load);
    return () => {
      active = false;
      off();
      offNews();
      window.removeEventListener('focus', load);
    };
  }, [attempt]);
  const providers = ['tiingo', 'fred'] as const;
  const status = (provider: (typeof providers)[number]) =>
    config?.statuses.find((entry) => entry.key === `provider:${provider}`);
  const keysDone = Boolean(config?.tiingo && config.fred);
  const connectionDone = Boolean(
    keysDone && providers.every((provider) => status(provider)?.state === 'fiable'),
  );
  const connectionProblem = providers.find((provider) =>
    ['no-fiable', 'desactualizado'].includes(status(provider)?.state ?? ''),
  );
  const sourcesDone = Boolean(config?.hasSources);
  const allDone = keysDone && connectionDone && sourcesDone;
  if (hidden && allDone && !error) return null;
  const rows = [
    {
      title: 'Añade tus claves de Tiingo y FRED',
      description: config?.keychainUnavailable
        ? 'El llavero del sistema no está disponible, así que no se pueden guardar claves.'
        : 'Sin ellas no hay velas ni datos macro reales.',
      state: keysDone ? 'done' : config?.keychainUnavailable ? 'attention' : 'pending',
      action: config?.keychainUnavailable ? 'Ver ayuda en Ajustes' : 'Añadir claves',
      run: () => navigateAndFocus('ajustes', config?.tiingo ? '#fred-key' : '#tiingo-key'),
    },
    {
      title: 'Prueba la conexión',
      description: connectionProblem
        ? `${connectionProblem === 'tiingo' ? 'Tiingo' : 'FRED'}: ${status(connectionProblem)?.reason ?? 'Revisa la conexión en Ajustes.'}`
        : 'Comprueba que cada proveedor responde y hasta qué fecha tiene datos.',
      state: connectionDone ? 'done' : connectionProblem ? 'attention' : 'pending',
      action: 'Probar conexión',
      run: () =>
        navigateAndFocus(
          'ajustes',
          `#${status('tiingo')?.state === 'fiable' ? 'fred' : 'tiingo'}-test`,
        ),
    },
    {
      title: 'Añade tus fuentes de noticias',
      description: 'Elige al menos una fuente para recibir titulares.',
      state: sourcesDone ? 'done' : 'pending',
      action: 'Añadir fuente',
      run: () => {
        window.location.hash = 'fuentes';
      },
    },
  ] as const;
  return (
    <section
      className={`first-steps${allDone && !loading && !error ? ' first-steps-complete' : ''}`}
      aria-labelledby="first-steps-title"
      aria-busy={loading}
    >
      {allDone && !loading && !error ? (
        <>
          <strong id="first-steps-title">Todo listo: Tradia ya recibe datos y noticias.</strong>
          <button
            className="button"
            onClick={() => {
              writeStorage(FIRST_STEPS_HIDDEN_KEY, 'true');
              setHidden(true);
            }}
          >
            Ocultar
          </button>
        </>
      ) : (
        <div>
          <div className="first-steps-header">
            <h2 id="first-steps-title">Primeros pasos</h2>
            {!loading && !error && (
              <span>
                {[keysDone, connectionDone, sourcesDone].filter(Boolean).length} de 3 hechos
              </span>
            )}
          </div>
          {loading && <p role="status">Comprobando tu configuración…</p>}
          {error && !loading ? (
            <div role="alert">
              <p>No pudimos comprobar tu configuración.</p>
              <button className="button" onClick={() => setAttempt((value) => value + 1)}>
                Reintentar
              </button>
            </div>
          ) : (
            <ol>
              {rows.map((row) => (
                <li className="first-steps-row" key={row.title}>
                  <Badge state={loading ? 'pending' : row.state} />
                  <div>
                    <strong>{row.title}</strong>
                    <p>{row.description}</p>
                  </div>
                  {!loading && row.state !== 'done' && (
                    <button className="button" onClick={row.run}>
                      {row.action}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {tour && (
            <div className="first-steps-footer">
              <button className="tour-skip" onClick={tour.pausedStep ? tour.resume : tour.restart}>
                {tour.pausedStep
                  ? `Retomar el tour (paso ${tour.pausedStep} de ${TOUR_STEPS.length})`
                  : 'Ver el tour'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
