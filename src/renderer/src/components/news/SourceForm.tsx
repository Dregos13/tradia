import { useRef, useState } from 'react';
import type { AddSourceRequest, TestSourceRequest, TestSourceResult } from '../../../../shared/ipc';
import { SOURCE_NAME_MAX_LENGTH, SOURCE_URL_MAX_LENGTH } from '../../../../shared/ipc';
import { ConnectionTest } from './ConnectionTest';
import {
  providers,
  reliabilityLabels,
  validFeedUrl,
  type Provider,
  type ConnectionState,
} from './sourceModel';

export function SourceForm({
  add,
  test,
  onAdded,
}: {
  add: (request: AddSourceRequest) => Promise<unknown>;
  test: (request: TestSourceRequest) => Promise<TestSourceResult>;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<'rss' | 'api'>('rss');
  const [provider, setProvider] = useState<Provider>('finnhub');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [reliability, setReliability] = useState<'agencia' | 'prensa' | 'redes'>('prensa');
  const [interval, setInterval] = useState(300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<ConnectionState>({ testing: false });
  const keyInput = useRef<HTMLInputElement>(null);
  function changed() {
    setConnection({ testing: false });
    setError('');
  }
  async function request(): Promise<AddSourceRequest | null> {
    if (!name.trim()) {
      setError('Introduce un nombre descriptivo.');
      return null;
    }
    if (
      kind === 'rss' &&
      (!validFeedUrl(url.trim()) || url.trim().length > SOURCE_URL_MAX_LENGTH)
    ) {
      setError('Introduce una URL HTTPS válida. Para feeds locales se admite HTTP en localhost.');
      return null;
    }
    const draft: AddSourceRequest = {
      name: name.trim(),
      kind,
      connector: kind === 'rss' ? 'rss' : provider,
      reliability,
      intervalSeconds: interval,
      ...(kind === 'rss' ? { url: url.trim() } : {}),
    };
    if (kind === 'api' && provider !== 'gdelt') {
      const key = keyInput.current?.value.trim() ?? '';
      if (keyInput.current) keyInput.current.value = '';
      if (key) {
        await window.tradia.secrets.setKey(provider, key);
      } else if (!(await window.tradia.secrets.hasKey(provider))) {
        setError('Introduce una clave de API o guárdala antes en Ajustes.');
        return null;
      }
    }
    return draft;
  }
  async function submit(isTest: boolean) {
    setBusy(true);
    setError('');
    setConnection({ testing: isTest });
    try {
      const draft = await request();
      if (!draft) {
        setConnection({ testing: false });
        return;
      }
      if (isTest) setConnection({ testing: false, result: await test(draft) });
      else {
        await add(draft);
        setName('');
        setUrl('');
        onAdded();
      }
    } catch {
      setConnection({ testing: false });
      setError(
        'No se pudo completar la operación. Comprueba el almacén seguro y la conexión e inténtalo de nuevo.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="source-form-panel" aria-labelledby="source-form-title" id="source-form">
      <h2 id="source-form-title">Añadir nueva fuente de noticias</h2>
      <p>Verifica la respuesta antes de guardarla.</p>
      <form
        className="source-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <fieldset disabled={busy}>
          <legend>Tipo de fuente</legend>
          <label>
            <input
              type="radio"
              name="source-kind"
              checked={kind === 'rss'}
              onChange={() => {
                setKind('rss');
                changed();
              }}
            />{' '}
            RSS / Feed Atom
          </label>
          <label>
            <input
              type="radio"
              name="source-kind"
              checked={kind === 'api'}
              onChange={() => {
                setKind('api');
                changed();
              }}
            />{' '}
            API financiera
          </label>
        </fieldset>
        <div className="source-form-fields">
          {kind === 'rss' ? (
            <label className="source-wide">
              <span id="source-url-label">URL del Feed RSS o Atom</span>
              <input
                aria-labelledby="source-url-label"
                type="url"
                value={url}
                required
                maxLength={SOURCE_URL_MAX_LENGTH}
                disabled={busy}
                aria-describedby="source-url-hint"
                onChange={(e) => {
                  setUrl(e.target.value);
                  changed();
                }}
              />
              <small id="source-url-hint">
                HTTPS para fuentes remotas; HTTP para feeds locales.
              </small>
            </label>
          ) : (
            <>
              <label>
                Proveedor de API
                <select
                  value={provider}
                  disabled={busy}
                  onChange={(e) => {
                    setProvider(e.target.value as Provider);
                    if (keyInput.current) keyInput.current.value = '';
                    changed();
                  }}
                >
                  {Object.entries(providers).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {provider !== 'gdelt' ? (
                <label>
                  <span id="source-key-label">Clave de API</span>
                  <input
                    aria-labelledby="source-key-label"
                    ref={keyInput}
                    type="password"
                    autoComplete="new-password"
                    disabled={busy}
                    aria-describedby="source-key-hint"
                    onChange={changed}
                  />
                  <small id="source-key-hint">
                    Se cifra en el llavero del sistema. Deja en blanco para usar la clave guardada.
                  </small>
                </label>
              ) : (
                <p>GDELT no necesita clave de API.</p>
              )}
            </>
          )}
          <label>
            Nombre descriptivo
            <input
              id="source-name"
              value={name}
              required
              maxLength={SOURCE_NAME_MAX_LENGTH}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value);
                changed();
              }}
            />
          </label>
          <label>
            Nivel de fiabilidad
            <select
              value={reliability}
              disabled={busy}
              onChange={(e) => {
                setReliability(e.target.value as typeof reliability);
                changed();
              }}
            >
              {Object.entries(reliabilityLabels).map(([id, label]) => (
                <option key={id} value={id} disabled={id === 'oficial'}>
                  {label}
                  {id === 'oficial' ? ' (Reservado para organismos del sistema)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Intervalo de consulta
            <select
              value={interval}
              disabled={busy}
              onChange={(e) => {
                setInterval(Number(e.target.value));
                changed();
              }}
            >
              {[5, 10, 15, 30, 60].map((minutes) => (
                <option key={minutes} value={minutes * 60}>
                  Cada {minutes} minutos
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Las noticias de Redes nunca se marcan como confirmadas por sí solas. Las consultas
          respetan los límites de cada proveedor.
        </p>
        <ConnectionTest state={connection} disabled={busy} onTest={() => void submit(true)} />
        {error && (
          <p className="settings-message error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button primary" disabled={busy}>
          {busy && !connection.testing ? 'Guardando…' : 'Guardar fuente'}
        </button>
      </form>
    </section>
  );
}
