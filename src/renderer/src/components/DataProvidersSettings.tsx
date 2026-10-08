import { useEffect, useState } from 'react';

function ProviderKey({ provider, name }: { provider: 'tiingo' | 'fred'; name: string }) {
  const [stored, setStored] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
          aria-describedby={`${provider}-state`}
        />
        <button className="button primary" type="submit" disabled={busy}>
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
          className="button"
          type="button"
          disabled
          aria-describedby={`${provider}-test-help`}
        >
          Probar conexión
        </button>
        <p id={`${provider}-test-help`}>
          La prueba de conexión estará disponible cuando se incorpore la comprobación del proveedor.
        </p>
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
  return (
    <section className="settings-section" aria-label="Proveedores de datos">
      <div>
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
