import { useEffect, useRef, useState } from 'react';
import { DataStateIcon } from '../DataStateIcon';
import { normalizeFxPair } from '../../../../shared/fx';
import { assetSymbol, fxLabel } from '../assetPresentation';
import { isFxSymbol } from '../../../../shared/fxTrading';
import { HistoricalProgress, MarketStatus } from './MarketStatus';
import {
  isTicker,
  WATCHLIST_MAX_ITEMS,
  type DataStatusEntry,
  type WatchlistCoverageEntry,
  type WatchlistItem,
} from '../../../../shared/ipc';

const EMPTY_STATUSES: DataStatusEntry[] = [];

interface Props {
  items: WatchlistItem[];
  selected: string | null;
  statuses?: DataStatusEntry[];
  simulated?: boolean;
  onSelect(ticker: string | null): void;
  onChanged(): Promise<void>;
}
export function Watchlist({
  items,
  selected,
  onSelect,
  onChanged,
  statuses = EMPTY_STATUSES,
  simulated = false,
}: Props) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [rejectedTicker, setRejectedTicker] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<WatchlistCoverageEntry[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const focusAfter = useRef(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTicker, setPendingTicker] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    void window.tradia.watchlist.coverage().then(
      (entries) => {
        if (active) setCoverage(entries);
      },
      () => {
        if (active) setCoverage([]);
      },
    );
    return () => {
      active = false;
    };
  }, [items, statuses]);
  useEffect(() => {
    if (!busy && focusAfter.current) {
      focusAfter.current = false;
      inputRef.current?.focus();
    }
  }, [busy, error, message, focusRequest]);
  const resetFeedback = () => {
    setError(null);
    setSuggestions([]);
    setRejectedTicker(null);
    setMessage('');
  };
  const reject = (text: string) => {
    focusAfter.current = true;
    setFocusRequest((previous) => previous + 1);
    setError(text);
  };
  const mutate = async (action: () => Promise<WatchlistItem[]>, success: string) => {
    if (busy) return;
    setBusy(true);
    resetFeedback();
    try {
      const updated = await action();
      await onChanged();
      onSelect(
        updated.some((item) => item.ticker === selected) ? selected : (updated[0]?.ticker ?? null),
      );
      setConfirm(null);
      setMessage(success);
    } catch {
      reject('No pudimos actualizar la lista. Revisa el ticker e inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  };
  const add = async (value = input) => {
    if (busy) return;
    const ticker = normalizeFxPair(value) ?? value.trim().toUpperCase();
    resetFeedback();
    if (!isTicker(ticker)) {
      reject('Introduce un ticker de 1 a 12 caracteres: letras, números, punto o guion.');
      return;
    }
    if (items.some((item) => item.ticker === ticker)) {
      reject(`${assetSymbol(ticker)} ya está en tu lista.`);
      return;
    }
    if (items.length >= WATCHLIST_MAX_ITEMS) {
      reject('Has alcanzado el límite de 25 activos. Quita uno antes de añadir otro.');
      return;
    }
    setBusy(true);
    setPendingTicker(ticker);
    try {
      const result = await window.tradia.watchlist.add(ticker);
      if (!result.added) {
        if (result.reason === 'no-cubierto') {
          const alternatives = [...new Set(result.suggestions ?? [])]
            .filter(isTicker)
            .sort((a, b) => Number(isFxSymbol(b)) - Number(isFxSymbol(a)));
          const pair = alternatives.find(isFxSymbol);
          const etf = alternatives.find((symbol) => !isFxSymbol(symbol));
          setSuggestions(alternatives);
          setRejectedTicker(ticker);
          // Preserve the symbol actually rejected, including a failed alternative.
          setInput(ticker);
          reject(
            pair
              ? `Tiingo no ofrece datos para ${ticker}. Puedes añadir ${assetSymbol(pair)} para seguir el tipo de cambio${etf ? `, o cambiar por ${etf}, un fondo cotizado en bolsa que se mueve de forma parecida` : ''}.`
              : etf
                ? `Tiingo no ofrece datos para ${ticker}. Puedes añadir ${etf}, un fondo cotizado en bolsa que se mueve de forma parecida.`
                : alternatives.length
                  ? `Tiingo no ofrece datos para ${ticker}. Puedes añadir ${alternatives.join(' o ')}.`
                  : `Tiingo no ofrece datos para ${ticker}. Prueba con el ticker de una acción o de un fondo cotizado de EE. UU.`,
          );
        } else if (result.reason === 'duplicado') {
          reject(`${assetSymbol(ticker)} ya está en tu lista.`);
        } else if (result.reason === 'limite') {
          reject('Has alcanzado el límite de 25 activos. Quita uno antes de añadir otro.');
        } else {
          reject('No pudimos actualizar la lista. Revisa el ticker e inténtalo de nuevo.');
        }
        return;
      }
      const name = result.name;
      if (name) setNames((previous) => ({ ...previous, [ticker]: name }));
      await onChanged();
      onSelect(ticker);
      setInput('');
      const shown = assetSymbol(ticker);
      setMessage(
        result.reason === 'pendiente-verificar'
          ? `${shown} se ha añadido, pero aún no pudimos comprobarlo. Lo verificaremos cuando vuelva la conexión.`
          : result.name
            ? `${shown} se ha añadido a tu lista como ${result.name}.`
            : isFxSymbol(ticker)
              ? `${shown} se ha añadido a tu lista: ${fxLabel(ticker).toLowerCase()}.`
              : `${shown} se ha añadido a tu lista.`,
      );
      focusAfter.current = true;
    } catch {
      reject('No pudimos actualizar la lista. Revisa el ticker e inténtalo de nuevo.');
    } finally {
      setBusy(false);
      setPendingTicker(null);
    }
  };
  return (
    <>
      <div className="market-toolbar">
        <form
          className="market-add"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
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
                resetFeedback();
              }}
              placeholder="p. ej. AAPL o EUR/USD"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={`market-ticker-help${error ? ' market-list-error' : ''}`}
              disabled={busy}
            />
            <button className="button primary" disabled={busy}>
              {pendingTicker ? 'Comprobando…' : 'Añadir'}
            </button>
          </div>
          <p id="market-ticker-help" className="market-ticker-help">
            Acciones y ETF: AAPL, SPY o FXE. Divisas: EUR/USD o EURUSD.
          </p>
          {error && (
            <div
              id="market-list-error"
              className={`market-add-feedback${rejectedTicker ? ' market-add-uncovered' : ''}`}
              role="alert"
              aria-live="assertive"
            >
              {rejectedTicker && (
                <strong>
                  <DataStateIcon kind="uncovered" />
                  {assetSymbol(rejectedTicker)} no está disponible en Tiingo
                </strong>
              )}
              <p>{error}</p>
              {suggestions.length > 0 && (
                <div className="market-add-alternatives">
                  {suggestions.map((ticker) => (
                    <button
                      key={ticker}
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => void add(ticker)}
                    >
                      {isFxSymbol(ticker)
                        ? `Añadir ${assetSymbol(ticker)} (divisa)`
                        : `Cambiar por ${ticker}`}
                    </button>
                  ))}
                  <a className="button" href="#ajustes?provider=tiingo">
                    Abrir Ajustes › Conectores
                  </a>
                </div>
              )}
            </div>
          )}
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
        <p className="market-announcement" role="status" aria-live="polite">
          {pendingTicker
            ? `Comprobando si ${assetSymbol(pendingTicker)} está disponible en Tiingo…`
            : busy
              ? 'Actualizando la lista…'
              : message}
        </p>
      </div>
      {pendingTicker && (
        <div className="market-download">
          <HistoricalProgress ticker={pendingTicker} active={busy} />
        </div>
      )}
      <aside className="market-watch" data-tour="mercado-lista" aria-label="Lista de seguimiento">
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
                    aria-label={assetSymbol(item.ticker)}
                    aria-describedby={`market-coverage-${item.ticker}`}
                    aria-pressed={selected === item.ticker}
                    onClick={() => {
                      onSelect(item.ticker);
                      setConfirm(null);
                    }}
                  >
                    <span
                      className={
                        statuses.find((entry) => entry.key === `ticker:${item.ticker}`)?.state ===
                        'no-fiable'
                          ? 'data-dimmed'
                          : undefined
                      }
                    >
                      {assetSymbol(item.ticker)}
                    </span>
                    {names[item.ticker] && (
                      <span className="market-asset-name">{names[item.ticker]}</span>
                    )}
                  </button>
                  <div id={`market-coverage-${item.ticker}`} className="market-asset-coverage">
                    {item.assetClass === 'fx' && (
                      <span className="market-asset-class">{fxLabel(item.ticker)}</span>
                    )}
                    {statuses.find((entry) => entry.key === `ticker:${item.ticker}`)?.state ===
                      'sin-cobertura' ||
                    coverage.find((entry) => entry.ticker === item.ticker)?.coverage ===
                      'sin-cobertura' ? (
                      <span className="market-badge market-coverage-uncovered">
                        <DataStateIcon kind="uncovered" />
                        Sin datos en Tiingo
                      </span>
                    ) : coverage.find((entry) => entry.ticker === item.ticker)?.coverage !==
                      'cubierto' ? (
                      <span className="market-badge market-coverage-pending">
                        <DataStateIcon kind="pending" />
                        Pendiente de verificar
                      </span>
                    ) : (
                      <MarketStatus
                        status={statuses.find((entry) => entry.key === `ticker:${item.ticker}`)}
                        simulated={simulated}
                      />
                    )}
                  </div>
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
                Quitar {assetSymbol(selected)}
              </button>
            )}
            {confirm && (
              <div
                className="market-confirm"
                role="group"
                aria-label={`Confirmar quitar ${assetSymbol(confirm)}`}
              >
                <p>¿Quitar {assetSymbol(confirm)} de tu lista? Puedes volver a añadirlo.</p>
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
                      `${assetSymbol(confirm)} se ha quitado de tu lista.`,
                    );
                    inputRef.current?.focus();
                  }}
                >
                  Confirmar quitar {assetSymbol(confirm)}
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
