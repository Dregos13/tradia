import { useState } from 'react';
import { JOURNAL_ENTRY_TYPES, JOURNAL_RESULTS, type JournalListQuery } from '../../../../shared/journal';
import { useStrategies } from '../../hooks/useStrategies';
import { typeLabel, resultLabel } from './labels';
export function JournalFilters({ apply }: { apply: (query: JournalListQuery) => void }) {
  const [draft, setDraft] = useState({ desde: '', hasta: '', type: '', ticker: '', strategyId: '', result: '' });
  const [error, setError] = useState('');
  const strategies = useStrategies();
  const field = (key: keyof typeof draft, value: string) => setDraft({ ...draft, [key]: value });
  const clear = () => { setDraft({ desde: '', hasta: '', type: '', ticker: '', strategyId: '', result: '' }); setError(''); apply({}); };
  return <form className="journal-filters" aria-label="Filtros del diario" onSubmit={(event) => {
    event.preventDefault();
    if (draft.desde && draft.hasta && draft.desde > draft.hasta) { setError('Desde debe ser anterior o igual a Hasta.'); return; }
    setError('');
    apply({ ...(draft.desde ? { desde: draft.desde } : {}), ...(draft.hasta ? { hasta: draft.hasta } : {}), ...(draft.type ? { type: draft.type as JournalListQuery['type'] } : {}), ...(draft.ticker.trim() ? { ticker: draft.ticker.trim().toUpperCase() } : {}), ...(draft.strategyId ? { strategyId: Number(draft.strategyId) } : {}), ...(draft.result ? { result: draft.result as JournalListQuery['result'] } : {}) });
  }}>
    <label>Desde<input type="date" value={draft.desde} onChange={e => field('desde', e.target.value)} /></label>
    <label>Hasta<input type="date" value={draft.hasta} onChange={e => field('hasta', e.target.value)} /></label>
    <label>Tipo<select value={draft.type} onChange={e => field('type', e.target.value)}><option value="">Todos</option>{JOURNAL_ENTRY_TYPES.map(type => <option key={type} value={type}>{typeLabel[type]}</option>)}</select></label>
    <label>Activo<input value={draft.ticker} maxLength={20} onChange={e => field('ticker', e.target.value)} placeholder="Todos" /></label>
    <label>Estrategia<select value={draft.strategyId} onChange={e => field('strategyId', e.target.value)}><option value="">Todas</option>{strategies.strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <label>Resultado<select value={draft.result} onChange={e => field('result', e.target.value)}><option value="">Todos</option>{JOURNAL_RESULTS.map(result => <option key={result} value={result}>{resultLabel[result]}</option>)}</select></label>
    <div className="journal-actions"><button type="submit">Aplicar</button><button type="button" onClick={clear}>Limpiar filtros</button></div>
    {error && <p role="alert">{error}</p>}
    {strategies.error && <p role="alert">No se pudieron cargar las estrategias. <button type="button" onClick={() => void strategies.reload()}>Reintentar estrategias</button></p>}
  </form>;
}
