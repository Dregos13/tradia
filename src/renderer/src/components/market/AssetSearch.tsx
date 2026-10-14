import { useEffect, useId, useRef, useState } from 'react';
import { formatFxPair, inferAssetClass, isFxPair } from '../../../../shared/fx';
import type { AssetSearchClass, AssetSearchMatch, WatchlistItem } from '../../../../shared/ipc';

export interface AssetSearchProps {
  items: WatchlistItem[];
  disabled?: boolean;
  onAdd(ticker: string): Promise<boolean> | boolean | void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  error?: string | null;
  onClearError?: () => void;
}

export function badgeClass(assetClass: AssetSearchClass): string {
  switch (assetClass) {
    case 'divisa':
      return 'forex';
    case 'etf':
      return 'etf';
    case 'accion':
    default:
      return 'stock';
  }
}

export function badgeLabel(assetClass: AssetSearchClass): string {
  switch (assetClass) {
    case 'divisa':
      return 'Divisa';
    case 'etf':
      return 'ETF';
    case 'accion':
    default:
      return 'Acción';
  }
}

export interface SearchOption {
  ticker: string;
  display: string;
  name: string;
  assetClass: AssetSearchClass;
  isDirect?: boolean;
}

export function AssetSearch({
  items,
  disabled = false,
  onAdd,
  inputRef: externalInputRef,
  error,
  onClearError,
}: AssetSearchProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [matches, setMatches] = useState<AssetSearchMatch[]>([]);
  const [directTicker, setDirectTicker] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Combine matches and directTicker into a single list of options
  const options: SearchOption[] = [...matches];
  if (directTicker && !matches.some((m) => m.ticker === directTicker)) {
    options.push({
      ticker: directTicker,
      display: isFxPair(directTicker) ? formatFxPair(directTicker) : directTicker,
      name: `Símbolo directo («${directTicker}»)`,
      assetClass: inferAssetClass(directTicker) === 'fx' ? 'divisa' : 'accion',
      isDirect: true,
    });
  }

  // Trigger search on query change
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setMatches([]);
      setDirectTicker(null);
      setLoading(false);
      setIsOpen(false);
      setFocusedIndex(-1);
      return;
    }

    let active = true;
    setLoading(true);

    if (window.tradia?.market?.search) {
      window.tradia.market
        .search(trimmed)
        .then((result) => {
          if (!active) return;
          setMatches(result?.matches ?? []);
          setDirectTicker(result?.directTicker ?? null);
          setLoading(false);
          setIsOpen(true);
        })
        .catch(() => {
          if (!active) return;
          setMatches([]);
          setDirectTicker(null);
          setLoading(false);
        });
    } else {
      setLoading(false);
    }

    return () => {
      active = false;
    };
  }, [query]);

  // Click outside to close dropdown
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setFocusedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, []);

  // Scroll active option into view
  useEffect(() => {
    if (focusedIndex >= 0 && options[focusedIndex]) {
      const activeElement = document.getElementById(`search-item-${options[focusedIndex].ticker}`);
      activeElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex, options]);

  const handleAdd = async (rawTicker: string) => {
    const result = await onAdd(rawTicker);
    // If onAdd returns false, it indicates validation/mutation failed -> keep query so user can fix
    if (result !== false) {
      setQuery('');
      setIsOpen(false);
      setFocusedIndex(-1);
    }
  };

  const handleSelectOption = (option: SearchOption) => {
    // If already in list, do not re-add
    if (items.some((item) => item.ticker === option.ticker)) {
      return;
    }
    void handleAdd(option.ticker);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen && query.trim()) {
        setIsOpen(true);
        setFocusedIndex(0);
        return;
      }
      if (options.length === 0) return;
      setFocusedIndex((prev) => (prev + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen && query.trim()) {
        setIsOpen(true);
        setFocusedIndex(options.length - 1);
        return;
      }
      if (options.length === 0) return;
      setFocusedIndex((prev) => (prev - 1 + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && focusedIndex >= 0 && options[focusedIndex]) {
        handleSelectOption(options[focusedIndex]);
      } else if (query.trim()) {
        void handleAdd(query.trim());
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setFocusedIndex(-1);
    } else if (e.key === 'Tab') {
      setIsOpen(false);
      setFocusedIndex(-1);
    }
  };

  const handleClear = () => {
    setQuery('');
    setIsOpen(false);
    setFocusedIndex(-1);
    inputRef.current?.focus();
    onClearError?.();
  };

  const focusedOptionId =
    isOpen && focusedIndex >= 0 && options[focusedIndex]
      ? `search-item-${options[focusedIndex].ticker}`
      : undefined;

  return (
    <form
      className="market-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (isOpen && focusedIndex >= 0 && options[focusedIndex]) {
          handleSelectOption(options[focusedIndex]);
        } else if (query.trim()) {
          void handleAdd(query.trim());
        }
      }}
    >
      <div
        className="market-search-container"
        ref={containerRef}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-owns={isOpen ? listboxId : undefined}
      >
        <label htmlFor="market-ticker" className="market-search-label">
          Buscar activo o divisa
        </label>
        <label htmlFor="market-ticker" className="sr-only">
          Ticker
        </label>
        <div className="market-search-input-wrapper">
          <div className="market-search-input-inner">
            <input
              id="market-ticker"
              ref={inputRef}
              type="text"
              className="market-search-input"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFocusedIndex(-1);
                onClearError?.();
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (query.trim() && options.length > 0) {
                  setIsOpen(true);
                }
              }}
              placeholder="Escribe un símbolo o nombre (ej. EUR/USD, Apple, SPY)…"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              aria-autocomplete="list"
              aria-controls={isOpen ? listboxId : undefined}
              aria-activedescendant={focusedOptionId}
              aria-invalid={!!error}
              aria-describedby={error ? 'market-list-error' : undefined}
            />
            {query.length > 0 && (
              <button
                type="button"
                className="market-search-clear"
                onClick={handleClear}
                aria-label="Limpiar búsqueda"
                tabIndex={-1}
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="submit"
            className="button primary market-search-add-btn"
            disabled={disabled || !query.trim()}
          >
            Añadir
          </button>
        </div>

        {isOpen && (
          <ul
            id={listboxId}
            className="market-search-dropdown"
            role="listbox"
            aria-label="Sugerencias de activos"
          >
            {loading ? (
              <li className="market-search-empty" role="status">
                Buscando activos…
              </li>
            ) : options.length > 0 ? (
              options.map((option, index) => {
                const isFocused = focusedIndex === index;
                const inList = items.some((item) => item.ticker === option.ticker);
                const isForex = option.assetClass === 'divisa';
                return (
                  <li
                    key={option.ticker}
                    id={`search-item-${option.ticker}`}
                    role="option"
                    aria-selected={isFocused}
                    className={`market-search-option ${isFocused ? 'focused' : ''} ${
                      inList ? 'in-list' : ''
                    }`}
                    onMouseEnter={() => setFocusedIndex(index)}
                    onClick={() => handleSelectOption(option)}
                  >
                    <div className="market-search-option-info">
                      <div className="market-search-option-header">
                        <span className="market-search-ticker">{option.display}</span>
                        <span className={`asset-badge ${badgeClass(option.assetClass)}`}>
                          {badgeLabel(option.assetClass)}
                        </span>
                      </div>
                      <span className="market-search-name">{option.name}</span>
                      {isForex && (
                        <span className="market-search-extra">
                          Forex 24/5 · Cartera simulada interna
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`button ${inList ? '' : 'primary'} market-search-item-btn`}
                      disabled={disabled || inList}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectOption(option);
                      }}
                    >
                      {inList ? 'Ya en lista' : '+ Añadir'}
                    </button>
                  </li>
                );
              })
            ) : (
              <li className="market-search-empty" role="option" aria-selected="false">
                No encontramos ningún activo para «{query.trim()}». Comprueba que el símbolo esté
                bien escrito o introduce un ticker directo para añadirlo.
              </li>
            )}
          </ul>
        )}
      </div>
    </form>
  );
}
