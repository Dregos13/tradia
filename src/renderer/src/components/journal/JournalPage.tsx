import { useState } from 'react';
import tokens from '../../design/dashboard.tokens.json';
import { JOURNAL_PAGE_SIZE, useJournal } from '../../hooks/useJournal';
import { JournalDetail } from './JournalDetail';
import { JournalFilters } from './JournalFilters';
import { localDate, resultLabel, typeLabel } from './labels';
import './journal.css';
export function JournalPage() {
  const journal = useJournal();
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="journal">
      <style>{`.journal{--journal-table-min:${tokens.size.journalTableMin};--journal-detail-size:${tokens.size.detailPanel};--journal-shadow:${tokens.shadow.floating.value};--journal-veil:${tokens.color.overlay.light};}@media(prefers-color-scheme:dark){.journal{--journal-veil:${tokens.color.overlay.dark};}}`}</style>
      <div className="headline journal-heading">
        <div>
          <h2>Diario</h2>
          <p>{journal.total} entradas · Señales, operaciones simuladas y decisiones auditables.</p>
        </div>
        <button
          disabled={journal.exporting || journal.loading || journal.error || journal.total === 0}
          onClick={() => void journal.exportCsv()}
        >
          {journal.exporting ? 'Preparando CSV…' : `Exportar CSV · ${journal.total} entradas`}
        </button>
      </div>
      <JournalFilters apply={journal.apply} />
      <p role="status">
        {journal.savedPath
          ? `CSV guardado en ${journal.savedPath}`
          : journal.exporting
            ? 'Preparando CSV…'
            : ''}
      </p>
      {journal.exportError && (
        <p role="alert">No se pudo exportar el CSV. No se creó ningún archivo.</p>
      )}
      {journal.error && (
        <p role="alert">
          No se pudo consultar el diario.{' '}
          <button onClick={() => void journal.reload()}>Reintentar</button>
        </p>
      )}
      <p id="journal-scroll-hint">Desplázate para ver todas las columnas.</p>
      <div
        className="journal-table-scroll"
        role="region"
        aria-label="Entradas del diario"
        aria-describedby="journal-scroll-hint"
        tabIndex={0}
        aria-busy={journal.loading}
      >
        <table>
          <caption className="sr-only">Diario ordenado por fecha descendente</caption>
          <thead>
            <tr>
              {[
                'Fecha',
                'Tipo',
                'Activo',
                'Estrategia',
                'Decisión / resultado',
                'Motivo',
                'Detalle',
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {journal.entries.map((entry) => (
              <tr key={entry.id} aria-selected={selected === entry.id}>
                <td>
                  <time dateTime={entry.createdAt}>{localDate(entry.createdAt)}</time>
                </td>
                <td>{typeLabel[entry.type]}</td>
                <td>{entry.ticker ?? 'No aplica'}</td>
                <td>
                  {entry.strategies.map((s) => `${s.name} · v${s.version}`).join(', ') ||
                    'No aplica'}
                </td>
                <td>{entry.result ? resultLabel[entry.result] : 'No aplica'}</td>
                <td>{entry.reason}</td>
                <td>
                  <button
                    aria-label={`Ver detalle de ${typeLabel[entry.type]} de ${entry.ticker ?? 'General'} · entrada ${entry.id}`}
                    onClick={() => setSelected(entry.id)}
                  >
                    Ver detalle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {journal.loading ? (
        <p role="status">Cargando diario…</p>
      ) : (
        !journal.error &&
        journal.entries.length === 0 && (
          <p>
            {Object.keys(journal.query).length
              ? 'No hay entradas con estos filtros'
              : 'El diario todavía está vacío'}
          </p>
        )
      )}
      <nav className="journal-pagination" aria-label="Paginación del diario">
        <button
          disabled={journal.loading || journal.offset === 0}
          onClick={() => journal.setOffset(Math.max(0, journal.offset - JOURNAL_PAGE_SIZE))}
        >
          Anterior
        </button>
        <span role="status">
          Página {Math.floor(journal.offset / JOURNAL_PAGE_SIZE) + 1} de{' '}
          {Math.max(1, Math.ceil(journal.total / JOURNAL_PAGE_SIZE))}
        </span>
        <button
          disabled={journal.loading || journal.offset + JOURNAL_PAGE_SIZE >= journal.total}
          onClick={() => journal.setOffset(journal.offset + JOURNAL_PAGE_SIZE)}
        >
          Siguiente
        </button>
      </nav>
      {selected !== null && <JournalDetail id={selected} close={() => setSelected(null)} />}
    </div>
  );
}
