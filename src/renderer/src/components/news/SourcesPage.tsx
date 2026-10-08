import { useEffect, useRef, useState } from 'react';
import type { NewsSource } from '../../../../shared/ipc';
import { useSources } from '../../hooks/useSources';
import { SourceForm } from './SourceForm';
import { ConnectionTest } from './ConnectionTest';
import { reliabilityLabels, providers, type Provider, type ConnectionState } from './sourceModel';
import './sources.css';
import { sourceTokenStylesheet } from './sourceTokens';

function SourceRow({
  source,
  data,
  onRemove,
}: {
  source: NewsSource;
  data: ReturnType<typeof useSources>;
  onRemove: (source: NewsSource) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<ConnectionState>({ testing: false });
  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await data.update({ id: source.id, active: !source.active });
    } catch {
      setError('No se pudo cambiar la actividad de la fuente. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setConnection({ testing: true });
    try {
      setConnection({ testing: false, result: await data.test({ id: source.id }) });
    } catch {
      setConnection({
        testing: false,
        result: { ok: false, itemsFound: 0, latencyMs: null, error: null },
      });
    }
  }
  const official = source.kind === 'oficial';
  return (
    <tr>
      <th scope="row">
        {source.name}
        {official && <small className="source-protected">Fuente protegida</small>}
      </th>
      <td>
        {source.kind === 'api'
          ? `API · ${providers[source.connector as Provider] ?? source.connector}`
          : 'RSS / Atom'}
      </td>
      <td>
        <span className={`source-reliability source-${official ? 'oficial' : source.reliability}`}>
          {reliabilityLabels[official ? 'oficial' : source.reliability]}
        </span>
      </td>
      <td>
        <span
          className={
            source.lastStatus === 'ok'
              ? 'online'
              : source.lastStatus === 'error'
                ? 'offline'
                : undefined
          }
        >
          {source.lastStatus === 'ok'
            ? 'Correcto'
            : source.lastStatus === 'error'
              ? 'Error de lectura'
              : 'Pendiente'}
        </span>
      </td>
      <td className="source-date">
        {source.lastFetchedAt ? (
          <time dateTime={source.lastFetchedAt}>
            {new Date(source.lastFetchedAt).toLocaleString('es-ES')}
          </time>
        ) : (
          'Sin lecturas'
        )}
        <small>Cada {source.intervalSeconds / 60} min</small>
      </td>
      <td>
        <label className="source-active">
          <input
            type="checkbox"
            role="switch"
            checked={source.active}
            disabled={busy || connection.testing}
            aria-label={`Fuente activa: ${source.name}`}
            onChange={() => void toggle()}
          />
          {source.active ? 'Activa' : 'En pausa'}
        </label>
      </td>
      <td>
        <div className="source-actions">
          <ConnectionTest state={connection} disabled={busy} onTest={() => void test()} />
          {!official && (
            <button
              className="button danger"
              disabled={busy || connection.testing}
              aria-label={`Quitar fuente ${source.name}`}
              onClick={() => onRemove(source)}
            >
              Quitar
            </button>
          )}
          {error && (
            <p role="alert" className="settings-message error">
              {error}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}
function RemoveDialog({
  source,
  remove,
  close,
}: {
  source: NewsSource;
  remove: (id: number) => Promise<unknown>;
  close: (removed: boolean) => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>('#source-name')?.focus();
    };
  }, []);
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await remove(source.id);
      close(true);
    } catch {
      setError('No se pudo quitar la fuente. Inténtalo de nuevo.');
      setBusy(false);
    }
  }
  return (
    <div className="source-dialog-backdrop">
      <div
        ref={panel}
        className="source-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        aria-describedby="confirm-delete-desc"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            close(false);
          }
          if (event.key === 'Tab') {
            const buttons =
              panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (!buttons?.length) {
              event.preventDefault();
              return;
            }
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id="confirm-delete-title">¿Quitar la fuente «{source.name}»?</h2>
        <p id="confirm-delete-desc">
          Los titulares ya guardados se mantendrán en tu historial, pero no se descargarán noticias
          nuevas de esta fuente.
        </p>
        {error && (
          <p role="alert" className="settings-message error">
            {error}
          </p>
        )}
        <div className="source-dialog-actions">
          <button ref={cancel} className="button" disabled={busy} onClick={() => close(false)}>
            Cancelar
          </button>
          <button className="button danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Quitando…' : 'Quitar fuente'}
          </button>
        </div>
      </div>
    </div>
  );
}
export function SourcesPage() {
  const data = useSources();
  const [removing, setRemoving] = useState<NewsSource | null>(null);
  const [message, setMessage] = useState('');
  // The background remains inert while the confirmation owns keyboard focus.
  return (
    <>
      <style>{sourceTokenStylesheet()}</style>
      <section
        className="sources-page"
        aria-label="Fuentes de noticias"
        aria-busy={data.loading}
        inert={removing ? true : undefined}
      >
        <div className="source-heading">
          <div>
            <h2>Canales de información bajo tu control.</h2>
            <p>
              {data.sources.length} fuentes configuradas ·{' '}
              {data.sources.filter((s) => s.active).length} activas
            </p>
          </div>
          <div className="source-heading-actions">
            <a
              className="button primary"
              href="#source-form"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById('source-name')?.focus();
              }}
            >
              Añadir nueva fuente
            </a>
            <button className="button" disabled={data.loading} onClick={() => void data.reload()}>
              Actualizar lista
            </button>
          </div>
        </div>
        <p role="status" aria-live="polite">
          {message}
        </p>
        {data.error && (
          <div className="data-empty" role="alert">
            <p>{data.error}</p>
            <button className="button" onClick={() => void data.reload()}>
              Reintentar
            </button>
          </div>
        )}
        {data.loading && <p role="status">Cargando fuentes de noticias…</p>}
        {!data.loading && !data.error && !data.sources.length && (
          <p className="data-empty" role="status">
            Todavía no has añadido fuentes de noticias.
          </p>
        )}
        {(['oficial', 'custom'] as const).map((group) => {
          const sources = data.sources.filter(
            (source) => (source.kind === 'oficial') === (group === 'oficial'),
          );
          return sources.length ? (
            <section className="source-list" key={group} aria-labelledby={`sources-${group}`}>
              <h3 id={`sources-${group}`}>
                {group === 'oficial' ? 'Fuentes oficiales predefinidas' : 'Proveedores de noticias'}
              </h3>
              {group === 'oficial' && (
                <p>Protegidas: puedes pausar su lectura; su fiabilidad siempre es Oficial.</p>
              )}
              <div
                className="source-table-scroll"
                role="region"
                aria-label={
                  group === 'oficial'
                    ? 'Listado de fuentes oficiales protegidas'
                    : 'Listado de proveedores configurados'
                }
                tabIndex={0}
              >
                <table className="source-table">
                  <thead>
                    <tr>
                      {[
                        'Fuente',
                        'Tipo',
                        'Fiabilidad',
                        'Estado',
                        'Última lectura',
                        'Actividad',
                        'Acciones',
                      ].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((source) => (
                      <SourceRow
                        key={source.id}
                        source={source}
                        data={data}
                        onRemove={setRemoving}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null;
        })}
        <SourceForm
          add={data.add}
          test={data.test}
          onAdded={() => setMessage('Fuente añadida. La lectura periódica está activa.')}
        />
      </section>
      {removing && (
        <RemoveDialog
          source={removing}
          remove={data.remove}
          close={(removed) => {
            setRemoving(null);
            if (removed)
              setMessage('Fuente quitada. No se descargarán titulares nuevos de esta fuente.');
          }}
        />
      )}
    </>
  );
}
