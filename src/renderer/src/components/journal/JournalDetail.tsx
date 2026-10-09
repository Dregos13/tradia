import { useEffect, useRef, useState } from 'react';
import type { JournalEntry } from '../../../../shared/journal';
import { localDate, resultLabel, typeLabel } from './labels';
const valueText = (value: unknown): string =>
  value === null ? 'No aplica' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function JournalDetail({ id, close }: { id: number; close: () => void }) {
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement;
    title.current?.focus();
    return () => trigger?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    setError(false);
    setEntry(null);
    void window.tradia.journal.get(id).then(
      (result) => {
        if (active) {
          setEntry(result);
          setError(!result);
        }
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [id, attempt]);
  return (
    <div className="journal-veil">
      <div
        ref={panel}
        className="journal-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="journal-detail-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
          if (event.key === 'Tab') {
            const controls = panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), summary, a[href], input, select',
            );
            if (!controls?.length) return;
            const first = controls[0],
              last = controls[controls.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === title.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2 id="journal-detail-title" tabIndex={-1} ref={title}>
            Detalle del diario
            {entry ? ` · ${typeLabel[entry.type]} · ${entry.ticker ?? 'General'}` : ''}
          </h2>
          <button onClick={close} aria-label="Cerrar detalle">
            ×
          </button>
        </header>
        {error ? (
          <p role="alert">
            No se pudo consultar la entrada.{' '}
            <button onClick={() => setAttempt(attempt + 1)}>Reintentar detalle</button>
          </p>
        ) : !entry ? (
          <p role="status">Cargando detalle…</p>
        ) : (
          <>
            <time dateTime={entry.createdAt}>
              {localDate(entry.createdAt)}
              <br />
              {entry.createdAt}
            </time>
            <dl>
              <dt>Tipo</dt>
              <dd>{typeLabel[entry.type]}</dd>
              <dt>Activo</dt>
              <dd>{entry.ticker ?? 'No aplica'}</dd>
              <dt>Estrategias y versiones</dt>
              <dd>
                {entry.strategies.map((s) => `${s.name} · v${s.version}`).join(', ') || 'No aplica'}
              </dd>
            </dl>
            <section>
              <h3>Motivo</h3>
              <p>{entry.reason || 'No aplica'}</p>
            </section>
            <section>
              <h3>Datos usados</h3>
              {entry.dataUsed && Object.keys(entry.dataUsed).length ? (
                <>
                  <dl>
                    {Object.entries(entry.dataUsed).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{valueText(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <details>
                    <summary>Ver datos técnicos JSON</summary>
                    <pre>{JSON.stringify(entry.dataUsed, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <p>No aplica</p>
              )}
            </section>
            <section>
              <h3>Resultado</h3>
              <p>{entry.result ? resultLabel[entry.result] : 'No aplica'}</p>
            </section>
            <section>
              <h3>Errores</h3>
              {entry.errors.length ? (
                <ul>
                  {entry.errors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              ) : (
                <p>No se registraron errores.</p>
              )}
            </section>
            <section>
              <h3>Cumplimiento de reglas</h3>
              {entry.ruleChecks.length ? (
                <ul>
                  {entry.ruleChecks.map((rule, index) => (
                    <li key={index}>
                      <strong>
                        {rule.cumplida ? '✓ Cumplida' : '× Incumplida'} · {rule.label}
                      </strong>
                      <p>
                        Observado: {rule.observed ?? 'No aplica'} · Límite:{' '}
                        {rule.limit ?? 'No aplica'}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No aplica</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
