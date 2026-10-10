import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MarketUpdatedEvent } from '../../../shared/ipc';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { StrategyStatus } from '../../../shared/strategy';
import { openDatabase } from '../../db/database';
import { createRegimeRepository } from './repository';
import { createRegimeService, type RegimeCandle, type RegimeStrategyCard } from './service';

// ---------------------------------------------------------------------------
// Utilidades: series sintéticas deterministas con fechas correlativas
// ---------------------------------------------------------------------------

function datedSeries(
  n: number,
  ret: (i: number) => number,
  start = '2024-01-02',
  wick = 0.001,
): RegimeCandle[] {
  const candles: RegimeCandle[] = [];
  let close = 100;
  let ms = Date.parse(`${start}T00:00:00.000Z`);
  const DAY = 86_400_000;
  for (let i = 0; i < n; i++) {
    const next = close * (1 + ret(i));
    candles.push({
      date: new Date(ms).toISOString().slice(0, 10),
      open: close,
      high: Math.max(close, next) * (1 + wick),
      low: Math.min(close, next) * (1 - wick),
      close: next,
    });
    close = next;
    ms += DAY;
  }
  return candles;
}

const phased =
  (first: (i: number) => number, second: (i: number) => number, cut: number) =>
  (i: number): number =>
    i < cut ? first(i) : second(i);

/** Lateral + volatilidad baja al final (seno amplio que se calma). */
const lateralSeries = (n: number): RegimeCandle[] =>
  datedSeries(
    n,
    phased(
      (i) => 0.03 * Math.sin(i * 0.7),
      (i) => 0.002 * Math.sin(i * 0.7),
      n - 40,
    ),
  );

/** Deriva constante: tendencia clara con volatilidad nula. */
const trendReturn = (): number => 0.006;

const extendWithTrend = (base: RegimeCandle[], extra: number): RegimeCandle[] => {
  const last = base[base.length - 1]!;
  let close = last.close;
  let ms = Date.parse(`${last.date}T00:00:00.000Z`) + 86_400_000;
  const added: RegimeCandle[] = [];
  for (let i = 0; i < extra; i++) {
    const next = close * (1 + trendReturn());
    added.push({
      date: new Date(ms).toISOString().slice(0, 10),
      open: close,
      high: Math.max(close, next) * 1.001,
      low: Math.min(close, next) * 0.999,
      close: next,
    });
    close = next;
    ms += 86_400_000;
  }
  return [...base, ...added];
};

const NOW = Date.parse('2026-10-09T21:00:00.000Z');
const event = (ticker: string, lastDate: string | null): MarketUpdatedEvent => ({
  ticker,
  source: 'simulado',
  lastDate,
  updatedAt: new Date(NOW).toISOString(),
});

// ---------------------------------------------------------------------------
// Banco de pruebas del servicio con el repositorio real
// ---------------------------------------------------------------------------

let db: Database.Database;
let journal: JournalRecordInput[];
let emitted: { channel: string; payload: unknown }[];
let seriesByTicker: Map<string, RegimeCandle[]>;
let strategies: RegimeStrategyCard[];
let watchlist: string[];

const strategy = (over: Partial<RegimeStrategyCard> & { id: number }): RegimeStrategyCard => ({
  name: `Estrategia ${over.id}`,
  version: 1,
  status: 'activa' as StrategyStatus,
  worksIn: [],
  failsIn: [],
  ...over,
});

const makeService = () =>
  createRegimeService({
    repo: createRegimeRepository(db),
    barsFor: (ticker) => seriesByTicker.get(ticker) ?? [],
    lastBarDate: (ticker) => seriesByTicker.get(ticker)?.at(-1)?.date ?? null,
    listWatchlistTickers: () => watchlist,
    listStrategies: () => strategies,
    recordJournal: (input) => journal.push(input),
    broadcast: (channel, payload) => emitted.push({ channel, payload }),
    now: () => NOW,
    logger: {},
  });

const aiChangedCount = (): number =>
  emitted.filter((e) => e.channel === IPC_CHANNELS.ai.changed).length;

beforeEach(() => {
  db = openDatabase(':memory:');
  journal = [];
  emitted = [];
  seriesByTicker = new Map();
  strategies = [];
  watchlist = [];
});

afterEach(() => {
  db.close();
});

describe('recálculo al guardar velas', () => {
  it('la primera ingesta clasifica todas las sesiones con datos suficientes', () => {
    seriesByTicker.set('AAPL', lateralSeries(300));
    const service = makeService();
    service.handleBarStored(event('AAPL', '2024-11-23'));

    const history = service.history('activo', 'AAPL');
    expect(history.length).toBe(300 - 50); // desde el índice 50 (SMA50 + pendiente)
    expect(history.at(-1)!.direction).toBe('lateral');
    expect(history.at(-1)!.volatility).toBe('volatilidad-baja');
    // El primer llenado no es «un cambio»: ni Diario ni ráfaga de eventos.
    expect(journal).toHaveLength(0);
    expect(aiChangedCount()).toBe(1);
  });

  it('series con menos de 51 velas no generan régimen', () => {
    seriesByTicker.set('AAPL', lateralSeries(30));
    const service = makeService();
    service.handleBarStored(event('AAPL', '2024-01-31'));
    expect(service.regimeFor('AAPL')).toBeNull();
    expect(aiChangedCount()).toBe(0);
  });

  it('un cambio de régimen del mercado genera Diario y evento, sin duplicarse', () => {
    const spy = lateralSeries(300);
    seriesByTicker.set('SPY', spy);
    const service = makeService();
    service.handleBarStored(event('SPY', spy.at(-1)!.date));
    expect(service.marketRegime()!.direction).toBe('lateral');
    expect(journal).toHaveLength(0);

    // Llegan 60 cierres de tendencia: el mercado gira de etiqueta.
    const grown = extendWithTrend(spy, 60);
    seriesByTicker.set('SPY', grown);
    service.handleBarStored(event('SPY', grown.at(-1)!.date));

    const market = service.marketRegime()!;
    expect(market.direction).toBe('tendencia');
    expect(journal).toHaveLength(1);
    expect(journal[0]!.type).toBe('resumen');
    expect(journal[0]!.ticker).toBe('SPY');
    expect(journal[0]!.reason).toContain('Lateral → Tendencia');
    expect(aiChangedCount()).toBe(2); // una por el llenado, otra por el giro

    // El «cambio anterior» del vigente apunta al inicio de la racha.
    expect(market.previousChange).toEqual({
      direction: 'lateral',
      sessionDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('el recálculo de la misma vela no duplica Diario ni eventos', () => {
    const grown = extendWithTrend(lateralSeries(300), 60);
    seriesByTicker.set('SPY', grown);
    const service = makeService();
    service.handleBarStored(event('SPY', grown.at(-1)!.date));
    service.handleBarStored(event('SPY', grown.at(-1)!.date));
    service.handleBarStored(event('SPY', grown.at(-1)!.date));
    // Llenado único: sin entradas del Diario (primer cálculo) y un solo evento.
    expect(journal).toHaveLength(0);
    expect(aiChangedCount()).toBe(1);
  });

  it('un cambio de régimen de un activo emite el evento pero no ensucia el Diario', () => {
    const aapl = lateralSeries(300);
    seriesByTicker.set('AAPL', aapl);
    const service = makeService();
    service.handleBarStored(event('AAPL', aapl.at(-1)!.date));

    const grown = extendWithTrend(aapl, 60);
    seriesByTicker.set('AAPL', grown);
    service.handleBarStored(event('AAPL', grown.at(-1)!.date));

    expect(service.regimeFor('AAPL')!.direction).toBe('tendencia');
    expect(journal).toHaveLength(0); // el Diario solo registra el mercado
    expect(aiChangedCount()).toBe(2);
  });

  it('el régimen de la sesión t no cambia al añadir velas posteriores (servicio)', () => {
    const spy = lateralSeries(300);
    seriesByTicker.set('SPY', spy);
    const service = makeService();
    service.handleBarStored(event('SPY', spy.at(-1)!.date));
    const session200 = spy[200]!.date;
    const before = service.regimeFor('SPY', session200)!;

    seriesByTicker.set('SPY', extendWithTrend(spy, 60));
    service.handleBarStored(event('SPY', seriesByTicker.get('SPY')!.at(-1)!.date));

    const after = service.regimeFor('SPY', session200)!;
    expect({
      direction: after.direction,
      volatility: after.volatility,
      metrics: after.metrics,
    }).toEqual({
      direction: before.direction,
      volatility: before.volatility,
      metrics: before.metrics,
    });
  });
});

describe('habilitación de estrategias según su ficha', () => {
  const setup = (cards: RegimeStrategyCard[]): ReturnType<typeof makeService> => {
    seriesByTicker.set('SPY', lateralSeries(300));
    strategies = cards;
    const service = makeService();
    service.handleBarStored(event('SPY', seriesByTicker.get('SPY')!.at(-1)!.date));
    return service;
  };

  it('devuelve para cada estrategia activa o desactivada con motivo legible', () => {
    const service = setup([
      strategy({ id: 1, name: 'Tendencial', worksIn: ['tendencia'] }),
      strategy({ id: 2, name: 'Reversión', worksIn: ['lateral'], failsIn: ['tendencia'] }),
      strategy({ id: 3, name: 'Solo lateral', worksIn: ['lateral'] }),
      strategy({ id: 4, name: 'Sin ficha' }),
    ]);

    // El mercado gira a tendencia + volatilidad baja.
    const grown = extendWithTrend(seriesByTicker.get('SPY')!, 60);
    seriesByTicker.set('SPY', grown);
    service.handleBarStored(event('SPY', grown.at(-1)!.date));

    const [tendencial, reversion, soloLateral, sinFicha] = service.overview().strategies;
    expect(tendencial!.regimeState).toBe('habilitada');
    expect(tendencial!.reason).toBe(
      'Coincide: Tendencia · Volatilidad baja. No coincide con ningún régimen de fallo.',
    );
    expect(reversion!.regimeState).toBe('desactivada');
    expect(reversion!.reason).toBe(
      'El mercado está en Tendencia · Volatilidad baja y la estrategia declara que falla en Tendencia.',
    );
    expect(soloLateral!.regimeState).toBe('desactivada');
    expect(soloLateral!.reason).toBe(
      'Solo funciona en Lateral; el régimen actual es Tendencia · Volatilidad baja.',
    );
    // Sin ficha de régimen: nunca se desactiva.
    expect(sinFicha!.regimeState).toBe('habilitada');
  });

  it("'degradada' tiene prioridad y 'retirada' no aparece", () => {
    const service = setup([
      strategy({ id: 1, name: 'Degradada', status: 'degradada', failsIn: ['tendencia'] }),
      strategy({ id: 2, name: 'Retirada', status: 'retirada' }),
      strategy({ id: 3, name: 'Paper', status: 'paper', worksIn: ['lateral'] }),
    ]);
    const statuses = service.overview().strategies;
    expect(statuses).toHaveLength(2);
    expect(statuses[0]!.regimeState).toBe('degradada');
    expect(statuses[0]!.reason).toBe(
      'El drift sostenido tiene prioridad. Revisa Salud de modelos.',
    );
    // Con mercado lateral, 'paper' también se evalúa por su ficha.
    expect(statuses[1]!.regimeState).toBe('habilitada');
    expect(statuses[1]!.reason).toContain('Coincide: Lateral');
  });

  it('sin régimen calculado las estrategias quedan habilitadas con motivo', () => {
    strategies = [strategy({ id: 1, worksIn: ['lateral'] })];
    const service = makeService(); // sin barras: mercado null
    const [card] = service.overview().strategies;
    expect(card!.regimeState).toBe('habilitada');
    expect(card!.reason).toBe('Todavía no hay régimen calculado del mercado: faltan cierres.');
  });
});

describe('vista del overview', () => {
  it('mercado, activos del seguimiento y fecha de la instantánea', () => {
    seriesByTicker.set('SPY', lateralSeries(300));
    seriesByTicker.set('AAPL', extendWithTrend(lateralSeries(280), 40));
    seriesByTicker.set('MSFT', lateralSeries(20)); // insuficiente: no aparece
    watchlist = ['SPY', 'AAPL', 'MSFT'];
    const service = makeService();
    service.recalculateAll();

    const view = service.overview();
    expect(view.market!.ticker).toBe('SPY');
    expect(view.market!.scope).toBe('mercado');
    expect(view.assets.map((a) => a.ticker).sort()).toEqual(['AAPL', 'SPY']);
    expect(view.computedAt).toBe(new Date(NOW).toISOString());
    // SPY figura dos veces: como referencia de mercado y como activo.
    expect(service.regimeFor('SPY')!.scope).toBe('activo');
  });
});

describe('simulateRegime (gancho E2E)', () => {
  it('fija el régimen del mercado y registra el cambio en el Diario', () => {
    seriesByTicker.set('SPY', lateralSeries(300));
    const service = makeService();
    service.handleBarStored(event('SPY', seriesByTicker.get('SPY')!.at(-1)!.date));
    expect(journal).toHaveLength(0);

    const snapshot = service.simulateRegime({ direction: 'tendencia' });
    expect(snapshot.scope).toBe('mercado');
    expect(snapshot.ticker).toBe('SPY');
    expect(snapshot.direction).toBe('tendencia');
    expect(snapshot.volatility).toBe('volatilidad-baja'); // conserva el eje no pedido
    expect(journal).toHaveLength(1);
    expect(journal[0]!.reason).toContain('Lateral → Tendencia');
    expect(aiChangedCount()).toBe(2);
  });

  it('fijar una sesión pasada no genera entrada del Diario', () => {
    seriesByTicker.set('SPY', lateralSeries(300));
    const service = makeService();
    service.handleBarStored(event('SPY', seriesByTicker.get('SPY')!.at(-1)!.date));
    const past = seriesByTicker.get('SPY')![200]!.date;
    const snapshot = service.simulateRegime({ direction: 'tendencia', sessionDate: past });
    expect(snapshot.direction).toBe('tendencia');
    expect(journal).toHaveLength(0);
  });

  it('exige ticker en ámbito activo y una sesión que fijar', () => {
    const service = makeService();
    expect(() => service.simulateRegime({ scope: 'activo', direction: 'lateral' })).toThrow();
    expect(() => service.simulateRegime({ direction: 'lateral' })).toThrow();
  });
});
