import { useRef, useState } from 'react';
import { HistoricalProgress } from './MarketStatus';
import { isTicker, WATCHLIST_MAX_ITEMS, type WatchlistItem } from '../../../../shared/ipc';

interface Props {
  items: WatchlistItem[];
  selected: string | null;
  onSelect(ticker: string | null): void;
  onChanged(): Promise<void>;
}
export function Watchlist({ items, selected, onSelect, onChanged }: Props) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTicker, setPendingTicker] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const mutate = async (
    action: () => Promise<WatchlistItem[]>,
    success: string,
    choose?: string,
  ) => {
    setBusy(true);
    setPendingTicker(choose ?? null);
    setError(null);
    setMessage('');
    try {
      const updated = await action();
      await onChanged();
      onSelect(
        choose ??
          (updated.some((item) => item.ticker === selected)
            ? selected
            : (updated[0]?.ticker ?? null)),
      );
      setConfirm(null);
      setMessage(success);
      if (choose) setInput('');
    } catch {
      setError('No pudimos actualizar la lista. Revisa el ticker e inténtalo de nuevo.');
    } finally {
      setBusy(false);
      setPendingTicker(null);
    }
  };
  const add = () => {
    const ticker = input.trim().toUpperCase();
    if (!isTicker(ticker)) {
      setError('Introduce un ticker de 1 a 12 caracteres: letras, números, punto o guion.');
    } else if (items.some((item) => item.ticker === ticker)) {
      setError(`${ticker} ya está en tu lista.`);
    } else if (items.length >= WATCHLIST_MAX_ITEMS) {
      setError('Has alcanzado el límite de 25 activos. Quita uno antes de añadir otro.');
    } else {
      void mutate(
        () => window.tradia.watchlist.add(ticker),
        `${ticker} se ha añadido a tu lista.`,
        ticker,
      );
    }
  };
  return (
    <>
      <div className="market-toolbar">
        <form
          className="market-add"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <label htmlFor="market-ticker">Ticker</label>
          <div className="market-add-controls">
            <input
              id="market-ticker"
              ref={inputRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setError(null);
              }}
              placeholder="p. ej. AAPL o SPY"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={error ? 'market-list-error' : undefined}
              disabled={busy}
            />
            <button className="button primary" disabled={busy}>
              Añadir
            </button>
          </div>
        </form>
        <button
          className="button"
          disabled={busy || items.length >= WATCHLIST_MAX_ITEMS}
          onClick={() =>
            void mutate(() => window.tradia.watchlist.addUniverse(), 'Universo inicial añadido.')
          }
        >
          Añadir universo inicial · 25
        </button>
        {error && (
          <p id="market-list-error" className="market-error" role="alert">
            {error}
          </p>
        )}
        <p className="market-announcement" role="status">
          {busy ? 'Actualizando lista…' : message}
        </p>
      </div>
      {pendingTicker && (
        <div className="market-download">
          <HistoricalProgress ticker={pendingTicker} active={busy} />
        </div>
      )}
      <aside className="market-watch" aria-label="Lista de seguimiento">
        <div className="market-watch-heading">
          <h3>Lista de seguimiento</h3>
          <span>
            {items.length} / {WATCHLIST_MAX_ITEMS}
          </span>
        </div>
        {items.length ? (
          <>
            <ul>
              {items.map((item) => (
                <li key={item.ticker}>
                  <button
                    className="market-asset"
                    aria-pressed={selected === item.ticker}
                    onClick={() => {
                      onSelect(item.ticker);
                      setConfirm(null);
                    }}
                  >
                    {item.ticker}
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <button
                ref={removeRef}
                className="button market-remove"
                disabled={busy}
                onClick={() => setConfirm(selected)}
              >
                Quitar {selected}
              </button>
            )}
            {confirm && (
              <div
                className="market-confirm"
                role="group"
                aria-label={`Confirmar quitar ${confirm}`}
              >
                <p>¿Quitar {confirm} de tu lista? Puedes volver a añadirlo.</p>
                <button
                  autoFocus
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(null);
                    removeRef.current?.focus();
                  }}
                >
                  Cancelar
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={async () => {
                    await mutate(
                      () => window.tradia.watchlist.remove(confirm),
                      `${confirm} se ha quitado de tu lista.`,
                    );
                    inputRef.current?.focus();
                  }}
                >
                  Confirmar quitar {confirm}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="market-list-empty">
            <h3>Tu lista está vacía.</h3>
            <p>Añade un ticker concreto o incorpora los 25 activos del universo inicial.</p>
          </div>
        )}
      </aside>
    </>
  );
}
