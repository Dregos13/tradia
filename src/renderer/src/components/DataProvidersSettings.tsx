import { useEffect, useState } from 'react';
import type { ProviderTestResult } from '../../../shared/ipc';
import { dataStateTokenStylesheet } from './dataStateTokens';
import './dataFreshness.css';
import { ProviderConnectionResult } from './ProviderConnectionResult';
import { refreshResultMessage } from './DataFreshness';

function ProviderKey({ provider, name }: { provider: 'tiingo' | 'fred'; name: string }) {
  const [stored, setStored] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [refreshMessage, setRefreshMessage] = useState('');
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
      <h3>{name}</h3>
      <p>
        {provider === 'tiingo'
          ? 'Precios diarios ajustados de acciones de EE. UU.'
          : 'Tipos, IPC, curva de tipos y VIX.'}
      </p>
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
          aria-describedby={`${provider}-state`}
        />
        <button className="button primary" type="submit" disabled={busy || testing}>
          {busy ? 'Guardando…' : `Guardar clave de ${name}`}
        </button>
      </div>
      <p id={`${provider}-state`} role="status">
        {stored === null
          ? 'Comprobando clave…'
          : stored
            ? 'Guardada y cifrada'
            : 'Sin clave guardada'}
      </p>
      <div>
        <button
          id={`${provider}-test`}
          className="button"
          type="button"
          disabled={testing || busy}
          aria-disabled={testing || busy}
          onClick={() => void testConnection()}
          aria-describedby={`${provider}-test-help`}
        >
          {testing ? 'Probando…' : 'Probar conexión'}
        </button>
        <ProviderConnectionResult
          provider={provider}
          name={name}
          testing={testing}
          result={result}
          onRetry={() => void testConnection()}
          onRefresh={() => void refresh()}
        />
        {refreshMessage && <p role="status">{refreshMessage}</p>}
      </div>
      {error && (
        <p className="settings-message error" role="alert">
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
      target?.focus();
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
      className="settings-section"
      aria-label="Proveedores de datos"
    >
      <style>{dataStateTokenStylesheet()}</style>
      <div data-tour="ajustes-proveedores">
        <h2>Proveedores de datos</h2>
        <p>Las claves se cifran en el sistema y nunca vuelven a mostrarse.</p>
      </div>
      <div className="settings-panel">
        <ProviderKey provider="tiingo" name="Tiingo" />
        <ProviderKey provider="fred" name="FRED" />
      </div>
    </section>
  );
}
