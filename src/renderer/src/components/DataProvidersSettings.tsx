import { useEffect, useRef, useState } from 'react';
import type { ProviderTestResult, WatchlistCoverageEntry } from '../../../shared/ipc';
import { dataStateTokenStylesheet } from './dataStateTokens';
import './dataFreshness.css';
import { focusProviderKey, ProviderConnectionResult } from './ProviderConnectionResult';
import { refreshResultMessage } from './DataFreshness';
import { subscribeWatchlistChanged } from '../hooks/watchlistEvents';
import { DataStateIcon } from './DataStateIcon';
import { assetSymbol, fxLabel } from './assetPresentation';
import { isFxSymbol } from '../../../shared/fxTrading';
import './settings/settings.css';

function TiingoCoverage() {
  const heading = useRef<HTMLHeadingElement>(null);
  const [entries, setEntries] = useState<WatchlistCoverageEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const value = await window.tradia.watchlist.coverage();
        if (active && current === generation) {
          setEntries(value);
          setError(false);
        }
      } catch {
        if (active && current === generation) setError(true);
      }
    };
    void load();
    const offStatus = window.tradia.dataStatus.onChanged(() => void load());
    const offList = subscribeWatchlistChanged(() => void load());
    return () => {
      active = false;
      offStatus();
      offList();
    };
  }, [retry]);
  const uncovered = entries?.filter((entry) => entry.coverage === 'sin-cobertura') ?? [];
  const pending = entries?.filter((entry) => entry.coverage === 'pendiente-verificar') ?? [];
  const pairs = entries?.filter((entry) => isFxSymbol(entry.ticker)) ?? [];
  const pairState = {
    cubierto: 'cubierta por Tiingo FX',
    'pendiente-verificar': 'pendiente de verificar en Tiingo FX',
    'sin-cobertura': 'sin cobertura en Tiingo FX',
  } as const;
  return (
    <section
      className={`connector-coverage ${uncovered.length ? 'connector-coverage--uncovered' : ''}`}
      aria-label="Cobertura de la lista en Tiingo"
    >
      <h4 ref={heading} tabIndex={-1}>
        Activos de tu lista sin cobertura
      </h4>
      {error ? (
        <>
          <p role="alert">No pudimos comprobar la cobertura de tu lista.</p>
          <button
            type="button"
            className="button"
            onClick={() => {
              heading.current?.focus();
              setError(false);
              setRetry((value) => value + 1);
            }}
          >
            Comprobar cobertura
          </button>
        </>
      ) : entries === null ? (
        <p role="status">Consultando la cobertura de tu lista…</p>
      ) : (
        <>
          {uncovered.length ? (
            <ul>
              {uncovered.map((entry) => (
                <li key={entry.ticker}>
                  <DataStateIcon kind="warning" />
                  <strong>{assetSymbol(entry.ticker)} no está disponible en Tiingo</strong>
                  {entry.suggestion && <p>Alternativa disponible: {entry.suggestion}.</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {entries.length
                ? 'No hay activos marcados sin cobertura.'
                : 'Tu lista de seguimiento está vacía.'}
            </p>
          )}
          {pairs.length > 0 && (
            <div className="connector-fx-coverage">
              <h5>Divisas de tu lista</h5>
              <ul>
                {pairs.map((entry) => (
                  <li key={entry.ticker}>
                    <DataStateIcon
                      kind={
                        entry.coverage === 'cubierto'
                          ? 'ok'
                          : entry.coverage === 'sin-cobertura'
                            ? 'uncovered'
                            : 'pending'
                      }
                    />
                    <strong>{assetSymbol(entry.ticker)}</strong> · {pairState[entry.coverage]} ·{' '}
                    {fxLabel(entry.ticker)}
                  </li>
                ))}
              </ul>
              <p>
                Velas diarias de lunes a viernes: sin datos en fin de semana y con datos en los
                festivos de EE. UU.
              </p>
            </div>
          )}
          {pending.length > 0 && (
            <p>
              Pendientes de verificar:{' '}
              {pending.map((entry) => assetSymbol(entry.ticker)).join(', ')}. Actualiza los datos
              cuando Tiingo esté conectado.
            </p>
          )}
          <a href="#mercado">
            {uncovered.length
              ? 'Ir a la lista para quitar o cambiar estos activos'
              : 'Ver lista de seguimiento'}
          </a>
        </>
      )}
    </section>
  );
}
function ProviderKey({ provider, name }: { provider: 'tiingo' | 'fred'; name: string }) {
  const [stored, setStored] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [refreshMessage, setRefreshMessage] = useState('');
  useEffect(() => {
    if (!testing && result?.status === 'clave-rechazada') focusProviderKey(provider);
  }, [testing, result, provider]);
  async function testConnection() {
    setTesting(true);
    setRefreshMessage('');
    try {
      setResult(await window.tradia.providers.testConnection({ provider }));
    } catch {
      setResult({
        provider,
        status: 'error',
        message: 'No se pudo comprobar el proveedor.',
        latestDataDate: null,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
      });
    } finally {
      setTesting(false);
    }
  }
  async function refresh() {
    setRefreshMessage('Actualizando…');
    try {
      setRefreshMessage(
        refreshResultMessage(
          await (provider === 'fred'
            ? window.tradia.macro.refreshNow()
            : window.tradia.market.refreshNow()),
        ),
      );
    } catch {
      setRefreshMessage('No pudimos iniciar la actualización. Inténtalo de nuevo.');
    }
  }
  useEffect(() => {
    let active = true;
    void window.tradia.secrets
      .hasKey(provider)
      .then((value) => {
        if (active) setStored(value);
      })
      .catch(() => {
        if (active) setError('No pudimos comprobar la clave. Vuelve a abrir Ajustes.');
      });
    return () => {
      active = false;
    };
  }, [provider]);
  async function save() {
    if (!key.trim()) {
      setError('Introduce una clave nueva.');
      return;
    }
    setBusy(true);
    setError('');
    const submitted = key.trim();
    setKey('');
    try {
      await window.tradia.secrets.setKey(provider, submitted);
      setResult(null);
      setRefreshMessage('');
      setStored(await window.tradia.secrets.hasKey(provider));
    } catch {
      setError(
        'No pudimos guardar o comprobar la clave. Revisa el llavero seguro del sistema e inténtalo de nuevo.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="settings-form provider-form"
      aria-label={`Proveedor ${name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="connector-heading">
        <h3>{name}</h3>
        <p>
          {provider === 'tiingo'
            ? 'Precios diarios de acciones y ETF de EE. UU.'
            : 'Tipos, IPC, curva de tipos y VIX.'}
        </p>
      </header>
      <ProviderConnectionResult
        provider={provider}
        name={name}
        testing={testing}
        result={result}
        busy={busy}
        onRetry={() => void testConnection()}
        onRefresh={() => void refresh()}
      />
      {refreshMessage && <p role="status">{refreshMessage}</p>}
      {provider === 'tiingo' && <TiingoCoverage />}
      <details id={`${provider}-key-details`} className="connector-key">
        <summary>Cambiar clave de {name}</summary>
        <label htmlFor={`${provider}-key`}>Clave de API de {name}</label>
        <div className="settings-controls">
          <input
            id={`${provider}-key`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={key}
            disabled={busy || testing}
            onChange={(event) => setKey(event.target.value)}
            aria-invalid={result?.status === 'clave-rechazada' || !!error}
            aria-describedby={`${provider}-state ${provider}-key-help${error ? ` ${provider}-key-error` : ''}`}
          />
          <button className="button" type="submit" disabled={busy || testing}>
            {busy ? 'Guardando…' : `Guardar clave de ${name}`}
          </button>
        </div>
        <p id={`${provider}-key-help`}>
          La clave guardada no se muestra. Escribe otra solo para sustituirla.
        </p>
        <p id={`${provider}-state`} role="status">
          {stored === null
            ? 'Comprobando clave…'
            : stored
              ? 'Guardada y cifrada'
              : 'Sin clave guardada'}
        </p>
      </details>
      {error && (
        <p id={`${provider}-key-error`} className="settings-message error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
export function DataProvidersSettings() {
  useEffect(() => {
    const focusTarget = () => {
      const params = new URLSearchParams(window.location.hash.split('?')[1]);
      const provider = params.get('provider');
      if (provider !== 'tiingo' && provider !== 'fred') return;
      const target = document.getElementById(
        `${provider}-${params.get('focus') === 'test' ? 'test' : 'key'}`,
      );
      target?.scrollIntoView?.({ block: 'center' });
      if (params.get('focus') !== 'test') focusProviderKey(provider);
      else target?.focus();
    };
    const timer = window.setTimeout(focusTarget, 0);
    window.addEventListener('hashchange', focusTarget);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('hashchange', focusTarget);
    };
  }, []);
  return (
    <section
      className="settings-section connector-section"
      data-tour="ajustes-proveedores"
      aria-label="Conectores de datos"
    >
      <style>{dataStateTokenStylesheet()}</style>
      <div>
        <h2>Conectores de datos</h2>
        <p>
          Comprueba cada conexión por separado. Las claves se cifran en el sistema y nunca vuelven a
          mostrarse.
        </p>
      </div>
      <div className="connector-cards">
        <ProviderKey provider="tiingo" name="Tiingo" />
        <ProviderKey provider="fred" name="FRED" />
      </div>
    </section>
  );
}
