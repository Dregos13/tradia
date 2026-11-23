import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MarketBar } from '../../../../shared/ipc';
import {
  formatChange,
  readMarket,
  type MarketReading,
  type PatternCandle,
} from '../../../../shared/patterns';
import { formatFxPair } from '../../../../shared/fx';
import { isFxSymbol } from '../../../../shared/fxTrading';
import { MesaChart } from './MesaChart';
import { SessionsTimeline } from './SessionsTimeline';
import './mesa.css';

/** Activos que importan, en el orden en que se leen. */
export const MESA_ASSETS = [
  { ticker: 'EURUSD', name: 'Euro / dólar', note: 'El par más negociado del mundo' },
  { ticker: 'USDJPY', name: 'Dólar / yen', note: 'Se mueve sobre todo en la sesión de Tokio' },
  { ticker: 'GBPUSD', name: 'Libra / dólar', note: 'Muy activo en la sesión de Londres' },
  { ticker: 'GLD', name: 'Oro', note: 'Oro físico, en dólares (fondo cotizado)' },
] as const;

type Asset = (typeof MESA_ASSETS)[number];

interface AssetData {
  candles: PatternCandle[];
  reading: MarketReading;
}

const priceFmt = (fx: boolean) =>
  new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: fx ? 4 : 2,
    maximumFractionDigits: fx ? 4 : 2,
    useGrouping: 'always' as unknown as boolean,
  });

const dateFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const hourFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function toCandles(bars: MarketBar[]): PatternCandle[] {
  return bars.map((b) => ({
    date: b.date,
    open: b.adjOpen ?? b.open,
    high: b.adjHigh ?? b.high,
    low: b.adjLow ?? b.low,
    close: b.adjClose ?? b.close,
  }));
}

const toneOf = (value: number | null) =>
  value === null || Math.abs(value) < 0.0005 ? 'flat' : value > 0 ? 'up' : 'down';

/**
 * Mesa: lo primero que ves. Qué bolsas están abiertas, cómo van los
 * activos que importan y qué patrones han aparecido hoy en sus velas.
 * Cada patrón se puede llevar al Laboratorio para convertirlo en una
 * estrategia y probarla.
 */
export function MesaPage() {
  const [data, setData] = useState<Record<string, AssetData>>({});
  const [selected, setSelected] = useState<Asset['ticker']>('EURUSD');
  const [missing, setMissing] = useState<string[]>([]);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [frame, setFrame] = useState<'1h' | '1d'>('1h');
  const [hourly, setHourly] = useState<{
    ticker: string;
    data: AssetData | null;
    error: string | null;
    loading: boolean;
  } | null>(null);

  const load = useCallback(async (tickers: readonly string[]) => {
    const entries = await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const result = await window.tradia.market.getBars({ ticker });
          const candles = toCandles(result.bars);
          const asset = MESA_ASSETS.find((a) => a.ticker === ticker)!;
          return [ticker, { candles, reading: readMarket(candles, asset) }] as const;
        } catch {
          return null;
        }
      }),
    );
    setData((current) => {
      const next = { ...current };
      for (const entry of entries)
        if (entry && entry[1].candles.length > 0) next[entry[0]] = entry[1];
      return next;
    });
  }, []);

  // Carga las velas de los activos de la Mesa que ya sigues.
  const refresh = useCallback(async () => {
    try {
      const list = await window.tradia.watchlist.list();
      const have = new Set(list.map((item) => item.ticker));
      setMissing(MESA_ASSETS.filter((a) => !have.has(a.ticker)).map((a) => a.ticker));
      await load(MESA_ASSETS.map((a) => a.ticker).filter((t) => have.has(t)));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    return window.tradia.market.onUpdated((event) => {
      if (MESA_ASSETS.some((a) => a.ticker === event.ticker)) void load([event.ticker]);
    });
  }, [load, refresh]);

  // Seguir es explícito: añade a tu lista los activos que falten.
  const follow = async () => {
    setFollowing(true);
    try {
      for (const ticker of missing) {
        await window.tradia.watchlist.add(ticker).catch(() => undefined);
      }
      await refresh();
    } finally {
      setFollowing(false);
    }
  };

  // Velas de 1 hora del activo elegido (solo ese, para cuidar el cupo).
  useEffect(() => {
    if (frame !== '1h') return;
    let alive = true;
    setHourly((h) => ({
      ticker: selected,
      data: h?.ticker === selected ? h.data : null,
      error: null,
      loading: true,
    }));
    const asset = MESA_ASSETS.find((a) => a.ticker === selected)!;
    window.tradia.market
      .getIntraday({ ticker: selected, days: 60 })
      .then((result) => {
        if (!alive) return;
        const candles: PatternCandle[] = result.bars.map((b) => ({
          date: b.time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        }));
        setHourly({
          ticker: selected,
          data:
            candles.length > 0
              ? { candles, reading: readMarket(candles, asset, { unit: 'hour' }) }
              : null,
          error: result.error,
          loading: false,
        });
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setHourly({
          ticker: selected,
          data: null,
          error: (cause as Error)?.message ?? 'No se pudieron cargar las velas de 1 hora.',
          loading: false,
        });
      });
    return () => {
      alive = false;
    };
  }, [frame, selected]);

  const asset = MESA_ASSETS.find((a) => a.ticker === selected)!;
  const hourlyHere = hourly?.ticker === selected ? hourly : null;
  const current = frame === '1h' ? (hourlyHere?.data ?? undefined) : data[selected];
  const fx = isFxSymbol(selected);
  const last = current?.candles.at(-1);
  const allPatterns = useMemo(
    () =>
      MESA_ASSETS.flatMap((a) =>
        (data[a.ticker]?.reading.patterns ?? []).map((p) => ({ asset: a, pattern: p })),
      ),
    [data],
  );

  const toLab = (idea: string) => {
    window.location.hash = `laboratorio?idea=${encodeURIComponent(idea)}`;
  };

  return (
    <div className="mesa-page" data-layout-page="mesa">
      <SessionsTimeline />

      {missing.length > 0 && !loading && (
        <div className="mesa-follow">
          <p>
            Aún no sigues{' '}
            {missing.map((t) => MESA_ASSETS.find((a) => a.ticker === t)!.name).join(', ')}. Al
            seguirlos se descarga su histórico diario (unos segundos por activo).
          </p>
          <button
            type="button"
            className="button primary"
            disabled={following}
            aria-busy={following}
            onClick={() => void follow()}
          >
            {following ? 'Añadiendo…' : 'Seguir estos activos'}
          </button>
        </div>
      )}

      <div className="mesa-desk">
        <section className="mesa-assets" aria-labelledby="mesa-assets-title">
          <header className="mesa-section-head">
            <h2 id="mesa-assets-title">Activos</h2>
            <p className="mesa-meta">Cierre diario</p>
          </header>
          <ul>
            {MESA_ASSETS.map((a) => {
              const d = data[a.ticker];
              const c = d?.candles.at(-1);
              const change = d?.reading.trend.change ?? null;
              const count = d?.reading.patterns.length ?? 0;
              return (
                <li key={a.ticker}>
                  <button
                    type="button"
                    className="mesa-asset"
                    aria-pressed={a.ticker === selected}
                    onClick={() => setSelected(a.ticker)}
                  >
                    <span className="mesa-asset-name">
                      <strong>{a.name}</strong>
                      <span>{isFxSymbol(a.ticker) ? formatFxPair(a.ticker) : a.ticker}</span>
                    </span>
                    <span className="mesa-asset-figures">
                      <span className="mesa-price">
                        {c ? priceFmt(isFxSymbol(a.ticker)).format(c.close) : loading ? '…' : '—'}
                      </span>
                      <span className="mesa-change" data-tone={toneOf(change)}>
                        {formatChange(change)}
                      </span>
                    </span>
                    {count > 0 && (
                      <span className="mesa-asset-patterns">
                        {count === 1 ? d!.reading.patterns[0]!.label : `${count} patrones`}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mesa-focus" aria-labelledby="mesa-focus-title">
          <header className="mesa-focus-head">
            <div>
              <h2 id="mesa-focus-title">{asset.name}</h2>
              <p className="mesa-meta">
                {asset.note}
                {last &&
                  (last.date.includes('T')
                    ? ` · última vela ${hourFmt.format(new Date(last.date))}`
                    : ` · cierre del ${dateFmt.format(new Date(`${last.date}T12:00:00Z`))}`)}
              </p>
            </div>
            <div className="mesa-frame" role="group" aria-label="Temporalidad">
              <button type="button" aria-pressed={frame === '1h'} onClick={() => setFrame('1h')}>
                1 hora
              </button>
              <button type="button" aria-pressed={frame === '1d'} onClick={() => setFrame('1d')}>
                Diario
              </button>
            </div>
            {current && last && (
              <div className="mesa-focus-figures">
                <span className="mesa-focus-price">{priceFmt(fx).format(last.close)}</span>
                <span data-tone={toneOf(current.reading.trend.change)}>
                  {formatChange(current.reading.trend.change)}{' '}
                  {frame === '1h' ? 'última hora' : 'hoy'} ·{' '}
                  {formatChange(current.reading.trend.change20)}{' '}
                  {frame === '1h' ? 'en 20 horas' : 'en 20 sesiones'}
                </span>
              </div>
            )}
          </header>

          {current ? (
            <>
              <p className="mesa-trend" data-tone={current.reading.trend.tone}>
                {current.reading.trend.label}
                {current.reading.trend.rsi14 !== null &&
                  ` · RSI ${current.reading.trend.rsi14.toFixed(0)}`}
                {current.reading.trend.atrPct !== null &&
                  ` · se mueve ~${(current.reading.trend.atrPct * 100).toFixed(1).replace('.', ',')} % ${frame === '1h' ? 'por hora' : 'al día'}`}
              </p>
              <MesaChart
                candles={current.candles}
                patterns={current.reading.patterns}
                fx={fx}
                label={asset.name}
              />
              <div className="mesa-patterns">
                <h3>Patrones en la última vela</h3>
                {frame === '1h' && (
                  <p className="mesa-frame-note">
                    Ojo: las pruebas de «Crear» todavía usan velas diarias; las pruebas con velas de
                    1 hora llegan en la próxima versión.
                  </p>
                )}
                {current.reading.patterns.length === 0 ? (
                  <p className="mesa-muted">
                    Ninguno claro hoy. Puedes estudiar tu propia idea sobre {asset.name}.
                  </p>
                ) : (
                  <ul>
                    {current.reading.patterns.map((p) => (
                      <li key={p.id} data-tone={p.tone}>
                        <div>
                          <strong>{p.label}</strong>
                          <p>{p.explanation}</p>
                        </div>
                        <button type="button" className="button" onClick={() => toLab(p.idea)}>
                          Crear estrategia con esto
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  className="mesa-link mesa-own-idea"
                  onClick={() => toLab(`Estrategia sobre ${asset.name} (${asset.ticker}): `)}
                >
                  Escribir mi propia idea sobre {asset.name}
                </button>
              </div>
            </>
          ) : (
            <p
              className="mesa-empty"
              role={frame === '1h' && hourlyHere?.error ? 'alert' : undefined}
            >
              {frame === '1h'
                ? hourlyHere?.loading !== false
                  ? 'Descargando velas de 1 hora… La primera vez tarda unos segundos.'
                  : (hourlyHere?.error ?? `No hay velas de 1 hora de ${asset.name}.`)
                : loading
                  ? 'Cargando velas…'
                  : `Aún no hay velas diarias de ${asset.name}. Pulsa «Seguir estos activos» arriba o revisa la clave de datos en Ajustes.`}
            </p>
          )}
          {frame === '1h' && current && hourlyHere?.error && (
            <p className="mesa-frame-note" role="status">
              {hourlyHere.error}
            </p>
          )}
        </section>
      </div>

      {allPatterns.length > 0 && (
        <section className="mesa-today" aria-labelledby="mesa-today-title">
          <header className="mesa-section-head">
            <h2 id="mesa-today-title">Lo que ha pasado hoy</h2>
            <p className="mesa-meta">
              {allPatterns.length} patrones en {MESA_ASSETS.length} activos
            </p>
          </header>
          <ul>
            {allPatterns.map(({ asset: a, pattern: p }) => (
              <li key={`${a.ticker}-${p.id}`} data-tone={p.tone}>
                <button
                  type="button"
                  className="mesa-today-asset"
                  onClick={() => setSelected(a.ticker)}
                >
                  {a.name}
                </button>
                <span>{p.label}</span>
                <button type="button" className="mesa-link" onClick={() => toLab(p.idea)}>
                  Probar como estrategia
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
