import { useRef, useState } from 'react';
import { HistoricalProgress, MarketStatus } from './MarketStatus';
import { formatAssetSymbol, inferAssetClass, isFxPair } from '../../../../shared/fx';
import {
  isTicker,
  normalizeAssetSymbol,
  WATCHLIST_MAX_ITEMS,
  type DataStatusEntry,
  type WatchlistItem,
} from '../../../../shared/ipc';
import { AssetSearch } from './AssetSearch';

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
  statuses = [],
  simulated = false,
}: Props) {
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
  ): Promise<boolean> => {
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
      return true;
    } catch {
      setError('No pudimos actualizar la lista. Revisa el ticker e inténtalo de nuevo.');
      return false;
    } finally {
      setBusy(false);
      setPendingTicker(null);
    }
  };

  const add = async (rawTicker: string): Promise<boolean> => {
    // 'EUR/USD' o 'eur-usd' se guardan en su forma canónica ('EURUSD').
    const ticker = normalizeAssetSymbol(rawTicker) ?? rawTicker.trim().toUpperCase();
    if (!isTicker(ticker)) {
      setError(
        'Símbolo no reconocido. Introduce un ticker de 1 a 12 caracteres: letras, números, punto o guion.',
      );
      return false;
    }
    if (items.some((item) => item.ticker === ticker)) {
      setError(`${ticker} ya está en tu lista.`);
      return false;
    }
    if (items.length >= WATCHLIST_MAX_ITEMS) {
      setError('Has alcanzado el límite de 25 activos. Quita uno antes de añadir otro.');
      return false;
    }
    return mutate(
      () => window.tradia.watchlist.add(ticker),
      `${formatAssetSymbol(ticker, inferAssetClass(ticker))} se ha añadido a tu lista.`,
      ticker,
    );
  };

  return (
    <>
      <div className="market-toolbar">
        <AssetSearch
          items={items}
          disabled={busy}
          onAdd={add}
          inputRef={inputRef}
          error={error}
          onClearError={() => setError(null)}
        />
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
              {items.map((item) => {
                const isForex = item.assetClass === 'fx' || isFxPair(item.ticker);
                const display = formatAssetSymbol(
                  item.ticker,
                  item.assetClass ?? inferAssetClass(item.ticker),
                );
                return (
                  <li key={item.ticker}>
                    <button
                      className="market-asset"
                      aria-label={display}
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
                        {display}
                      </span>
                      {isForex && (
                        <span className="asset-badge forex market-asset-badge">Divisa</span>
                      )}
                    </button>
                    <MarketStatus
                      status={statuses.find((entry) => entry.key === `ticker:${item.ticker}`)}
                      simulated={simulated}
                    />
                  </li>
                );
              })}
            </ul>
            {selected && (
              <button
                ref={removeRef}
                className="button market-remove"
                disabled={busy}
                onClick={() => setConfirm(selected)}
              >
                Quitar {formatAssetSymbol(selected, inferAssetClass(selected))}
              </button>
            )}
            {confirm && (
              <div
                className="market-confirm"
                role="group"
                aria-label={`Confirmar quitar ${formatAssetSymbol(confirm, inferAssetClass(confirm))}`}
              >
                <p>
                  ¿Quitar {formatAssetSymbol(confirm, inferAssetClass(confirm))} de tu lista? Puedes
                  volver a añadirlo.
                </p>
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
                      `${formatAssetSymbol(confirm, inferAssetClass(confirm))} se ha quitado de tu lista.`,
                    );
                    inputRef.current?.focus();
                  }}
                >
                  Confirmar quitar {formatAssetSymbol(confirm, inferAssetClass(confirm))}
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
