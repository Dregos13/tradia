import { describe, expect, it } from 'vitest';

import { SIMULATED_PROVIDER_ID, createSimulatedProvider } from './simulated';
import { isMarketDataError, type Bar } from './types';

// Miércoles 12:00 UTC → la última sesión cerrada es el martes 10 (~21:00 UTC).
const NOW = Date.parse('2024-06-12T12:00:00.000Z');

const make = (options = {}) =>
  createSimulatedProvider({ seed: 'pruebas', now: () => NOW, ...options });

const byDate = (bars: Bar[]): Map<string, Bar[]> => {
  const map = new Map<string, Bar[]>();
  for (const bar of bars) {
    const list = map.get(bar.date) ?? [];
    list.push(bar);
    map.set(bar.date, list);
  }
  return map;
};

describe('proveedor simulado', () => {
  it('es determinista: la misma semilla produce la misma serie', async () => {
    const a = await make().getBars('AAPL', '2024-01-02', '2024-06-11');
    const b = await make().getBars('AAPL', '2024-01-02', '2024-06-11');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(100);
  });

  it('la serie no depende del rango consultado (anclada al génesis)', async () => {
    const provider = make();
    const long = await provider.getBars('MSFT', '2020-01-01', '2024-06-11');
    const short = await provider.getBars('MSFT', '2024-06-01', '2024-06-11');
    const longByDate = byDate(long);
    for (const bar of short) {
      expect(longByDate.get(bar.date)?.[0]).toEqual(bar);
    }
  });

  it('otra semilla produce precios distintos', async () => {
    const a = await make({ seed: 'uno' }).getBars('X', '2024-06-01', '2024-06-11');
    const b = await make({ seed: 'dos' }).getBars('X', '2024-06-01', '2024-06-11');
    expect(a.map((x) => x.close)).not.toEqual(b.map((x) => x.close));
  });

  it('solo genera días laborables y OHLC coherentes', async () => {
    const bars = await make().getBars('SPY', '2024-05-01', '2024-06-11');
    expect(bars.length).toBeGreaterThan(20);
    for (const bar of bars) {
      const day = new Date(`${bar.date}T00:00:00.000Z`).getUTCDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.volume).toBeGreaterThan(0);
      expect(bar.adjClose).toBeGreaterThan(0);
      // Sin acciones corporativas no hay split ni dividendo y adjClose = close.
      expect(bar.splitFactor).toBe(1);
      expect(bar.dividend).toBe(0);
      expect(bar.adjClose).toBeCloseTo(bar.close, 2);
    }
  });

  it('una sesión solo existe si su cierre ya pasó según el reloj', async () => {
    // Viernes 14-06 antes del cierre de verano (20:00 UTC).
    const beforeClose = createSimulatedProvider({
      seed: 's',
      now: () => Date.parse('2024-06-14T19:59:00.000Z'),
    });
    const barsBefore = await beforeClose.getBars('AAPL', '2024-06-10', '2024-06-30');
    expect(barsBefore[barsBefore.length - 1]!.date).toBe('2024-06-13');

    // A las 22:00 UTC la sesión del viernes ya está cerrada y aparece.
    const afterClose = createSimulatedProvider({
      seed: 's',
      now: () => Date.parse('2024-06-14T22:00:00.000Z'),
    });
    const barsAfter = await afterClose.getBars('AAPL', '2024-06-10', '2024-06-30');
    expect(barsAfter[barsAfter.length - 1]!.date).toBe('2024-06-14');
  });

  it('omite Acción de Gracias y respeta el cierre anticipado del viernes', async () => {
    let clock = Date.parse('2026-11-26T23:00:00Z');
    const provider = make({ now: () => clock });
    expect((await provider.getQuote('SPY')).date).toBe('2026-11-25');
    clock = Date.parse('2026-11-27T17:59:00Z');
    expect((await provider.getQuote('SPY')).date).toBe('2026-11-25');
    clock = Date.parse('2026-11-27T18:00:00Z');
    const bars = await provider.getBars('SPY', '2026-11-25', '2026-11-27');
    expect(bars.map((bar) => bar.date)).toEqual(['2026-11-25', '2026-11-27']);
    expect((await provider.getQuote('SPY')).date).toBe('2026-11-27');
  });

  it('permite inyectar un split: el crudo salta y el ajustado sigue continuo', async () => {
    const provider = make();
    provider.injectSplit('AAPL', '2024-06-10', 10);
    const bars = await provider.getBars('AAPL', '2024-06-05', '2024-06-11');
    const map = byDate(bars);
    const prev = map.get('2024-06-07')![0]!;
    const day = map.get('2024-06-10')![0]!;

    expect(day.splitFactor).toBe(10);
    expect(prev.splitFactor).toBe(1);
    // Los precios crudos anteriores van en unidades pre-split (~10×).
    expect(prev.close / day.close).toBeGreaterThan(6);
    expect(prev.close / day.close).toBeLessThan(14);
    // El ajustado es continuo: el salto desaparece (ruido diario <10 %).
    const adjRatio = day.adjClose / prev.adjClose;
    expect(adjRatio).toBeGreaterThan(0.9);
    expect(adjRatio).toBeLessThan(1.1);
    // El volumen pre-split se expresa en acciones antiguas (menor).
    expect(prev.volume).toBeLessThan(day.volume / 3);
  });

  it('las inyecciones de un ticker no contaminan a los demás', async () => {
    const provider = make();
    provider.injectSplit('AAPL', '2024-06-10', 4);
    const msft = await provider.getBars('MSFT', '2024-06-05', '2024-06-11');
    for (const bar of msft) expect(bar.splitFactor).toBe(1);
  });

  it('permite inyectar un dividendo: baja el ajustado anterior, no el crudo', async () => {
    const provider = make();
    const plain = await provider.getBars('KO', '2024-06-03', '2024-06-11');
    provider.injectDividend('KO', '2024-06-07', 2);
    const adjusted = await provider.getBars('KO', '2024-06-03', '2024-06-11');
    const plainMap = byDate(plain);
    const adjMap = byDate(adjusted);

    expect(adjMap.get('2024-06-07')![0]!.dividend).toBe(2);
    for (const bar of adjusted) {
      const raw = plainMap.get(bar.date)![0]!;
      expect(bar.close).toBe(raw.close); // el crudo no cambia
      if (bar.date < '2024-06-07') {
        expect(bar.adjClose).toBeLessThan(raw.adjClose);
      } else {
        expect(bar.adjClose).toBe(raw.adjClose);
      }
    }
  });

  it('getCorporateActions lista los splits y dividendos inyectados del rango', async () => {
    const provider = make();
    provider.injectSplit('NVDA', '2024-06-10', 10);
    provider.injectDividend('NVDA', '2024-06-11', 0.1);
    provider.injectDividend('NVDA', '2024-07-01', 0.1); // fuera de rango
    const actions = await provider.getCorporateActions('NVDA', '2024-06-01', '2024-06-30');
    expect(actions).toEqual([
      { ticker: 'NVDA', date: '2024-06-10', kind: 'split', value: 10 },
      { ticker: 'NVDA', date: '2024-06-11', kind: 'dividend', value: 0.1 },
    ]);
  });

  it('permite inyectar un hueco: la sesión no aparece', async () => {
    const provider = make();
    provider.injectGap('QQQ', '2024-06-06');
    const bars = await provider.getBars('QQQ', '2024-06-03', '2024-06-11');
    expect(bars.some((b) => b.date === '2024-06-06')).toBe(false);
    expect(bars.some((b) => b.date === '2024-06-05')).toBe(true);
  });

  it('permite inyectar un duplicado: la sesión llega dos veces', async () => {
    const provider = make();
    provider.injectDuplicate('QQQ', '2024-06-06');
    const bars = await provider.getBars('QQQ', '2024-06-03', '2024-06-11');
    const dupes = bars.filter((b) => b.date === '2024-06-06');
    expect(dupes).toHaveLength(2);
    expect(dupes[0]).toEqual(dupes[1]);
  });

  it('permite inyectar un valor anómalo en una vela', async () => {
    const provider = make();
    provider.injectAnomaly('SPY', '2024-06-06', { close: 0, high: 0 });
    const bars = await provider.getBars('SPY', '2024-06-03', '2024-06-11');
    const bad = byDate(bars).get('2024-06-06')![0]!;
    expect(bad.close).toBe(0);
    expect(bad.high).toBe(0);
    // El resto de velas no se toca.
    expect(byDate(bars).get('2024-06-05')![0]!.close).toBeGreaterThan(0);
  });

  it('getQuote devuelve la última sesión cerrada', async () => {
    const provider = make();
    const quote = await provider.getQuote('AAPL');
    expect(quote).toMatchObject({ ticker: 'AAPL', date: '2024-06-11' });
    expect(quote.last).toBeGreaterThan(0);
  });

  it('los tickers marcados como desconocidos lanzan not-found', async () => {
    const provider = make();
    provider.markUnknown('xxoo');
    const error = await provider
      .getBars('XXOO', '2024-06-01', '2024-06-11')
      .catch((e: unknown) => e);
    expect(isMarketDataError(error, 'not-found')).toBe(true);
    expect((error as { provider?: string }).provider).toBe(SIMULATED_PROVIDER_ID);
    await expect(provider.getQuote('xxoo')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('los fallos programados agotan su cuenta y luego se recupera', async () => {
    const provider = make();
    provider.queueFailures(2, 'network');
    await expect(provider.getBars('AAPL', '2024-06-01', '2024-06-11')).rejects.toMatchObject({
      kind: 'network',
    });
    await expect(provider.getQuote('AAPL')).rejects.toMatchObject({ kind: 'network' });
    // Tercera llamada: ya no quedan fallos encolados.
    await expect(provider.getBars('AAPL', '2024-06-01', '2024-06-11')).resolves.toBeInstanceOf(
      Array,
    );
  });

  it('setFailing simula al proveedor caído hasta reactivarlo', async () => {
    const provider = make();
    provider.setFailing('auth');
    await expect(provider.getBars('AAPL', '2024-06-01', '2024-06-11')).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
    provider.setFailing(null);
    await expect(provider.getQuote('AAPL')).resolves.toMatchObject({ ticker: 'AAPL' });
  });

  it('rechaza tickers y rangos inválidos con bad-data', async () => {
    const provider = make();
    await expect(provider.getBars('', '2024-06-01', '2024-06-11')).rejects.toMatchObject({
      kind: 'bad-data',
    });
    await expect(provider.getBars('AAPL', '2024-13-01', '2024-06-11')).rejects.toMatchObject({
      kind: 'bad-data',
    });
  });
});

describe('proveedor simulado — pares de divisas 24/5', () => {
  const FX_NOW = Date.parse('2024-07-08T12:00:00.000Z');
  const makeFx = () => createSimulatedProvider({ seed: 'fx', now: () => FX_NOW });

  it('genera velas de lunes a viernes, festivos de NYSE incluidos', async () => {
    const provider = makeFx();
    const bars = await provider.getBars('EURUSD', '2024-07-01', '2024-07-07');

    // El rango incluye el fin de semana 06-07/07-07, que no tiene vela, y
    // el jueves 04-07 (Independence Day, NYSE cerrada), que en divisas sí.
    expect(bars.map((b) => b.date)).toEqual([
      '2024-07-01',
      '2024-07-02',
      '2024-07-03',
      '2024-07-04',
      '2024-07-05',
    ]);
    for (const bar of bars) {
      const day = new Date(`${bar.date}T00:00:00.000Z`).getUTCDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      // Sin volumen ni acciones corporativas en divisas.
      expect(bar.volume).toBe(0);
      expect(bar.splitFactor).toBe(1);
      expect(bar.dividend).toBe(0);
      expect(bar.adjClose).toBe(bar.close);
    }
    // La misma semana en una acción no tiene el 4 de julio.
    const aapl = await provider.getBars('AAPL', '2024-07-01', '2024-07-07');
    expect(aapl.map((b) => b.date)).toEqual([
      '2024-07-01',
      '2024-07-02',
      '2024-07-03',
      '2024-07-05',
    ]);
  });

  it('los demás pares admitidos también generan velas 24/5 y deterministas', async () => {
    const expected = ['2024-07-01', '2024-07-02', '2024-07-03', '2024-07-04', '2024-07-05'];
    for (const pair of ['GBPUSD', 'USDJPY', 'USDCHF'] as const) {
      const bars = await makeFx().getBars(pair, '2024-07-01', '2024-07-07');
      expect(bars.map((b) => b.date)).toEqual(expected);
    }
    // Determinista: dos proveedores con la misma semilla coinciden.
    const a = await makeFx().getBars('EURUSD', '2024-07-01', '2024-07-07');
    const b = await makeFx().getBars('EURUSD', '2024-07-01', '2024-07-07');
    expect(a).toEqual(b);
  });

  it('un ticker de seis letras que no es par admitido sigue el calendario NYSE', async () => {
    const provider = makeFx();
    const bars = await provider.getBars('ABCDEF', '2024-07-01', '2024-07-07');
    expect(bars.map((b) => b.date)).not.toContain('2024-07-04');
  });

  it('no genera vela el 25-12 ni el 01-01 aunque sean laborables', async () => {
    const provider = createSimulatedProvider({
      seed: 'fx',
      now: () => Date.parse('2024-01-05T12:00:00.000Z'),
    });
    const bars = await provider.getBars('EURUSD', '2023-12-25', '2024-01-02');
    expect(bars.map((b) => b.date)).toEqual([
      '2023-12-26',
      '2023-12-27',
      '2023-12-28',
      '2023-12-29',
      '2024-01-02',
    ]);
  });

  it('la vela de divisas existe en cuanto cierra su día UTC (00:00)', async () => {
    // Viernes 14-06 a las 23:59 UTC: su vela aún no ha cerrado.
    const beforeClose = createSimulatedProvider({
      seed: 's',
      now: () => Date.parse('2024-06-14T23:59:00.000Z'),
    });
    const before = await beforeClose.getBars('EURUSD', '2024-06-10', '2024-06-15');
    expect(before[before.length - 1]!.date).toBe('2024-06-13');

    // Sábado 15-06 a las 00:01 UTC: la vela del viernes ya está publicada.
    const afterClose = createSimulatedProvider({
      seed: 's',
      now: () => Date.parse('2024-06-15T00:01:00.000Z'),
    });
    const after = await afterClose.getBars('EURUSD', '2024-06-10', '2024-06-15');
    expect(after[after.length - 1]!.date).toBe('2024-06-14');
  });

  it('getQuote del par usa el último día UTC cerrado, sin volumen', async () => {
    const provider = makeFx(); // lunes 08-07 12:00 UTC → última vela: viernes 05
    await expect(provider.getQuote('EURUSD')).resolves.toMatchObject({
      ticker: 'EURUSD',
      date: '2024-07-05',
      volume: null,
    });
  });

  it('getTickerInfo etiqueta el par como fx y la acción como equity', async () => {
    const provider = make();
    await expect(provider.getTickerInfo('eurusd')).resolves.toEqual({
      ticker: 'EURUSD',
      assetClass: 'fx',
    });
    await expect(provider.getTickerInfo('aapl')).resolves.toEqual({
      ticker: 'AAPL',
      assetClass: 'equity',
    });
    provider.markUnknown('EURUSD');
    await expect(provider.getTickerInfo('EURUSD')).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('EUR/USD cotiza en la banda realista (0,9–1,4) en cualquier fecha del reloj', async () => {
    // El paseo revierte al anclaje del par: ni a los pocos meses ni a las
    // décadas del génesis el precio se va a niveles de acción (~12,8).
    for (const instant of [
      '2001-04-11T12:00:00.000Z',
      '2008-09-17T12:00:00.000Z',
      '2015-11-20T12:00:00.000Z',
      '2024-07-08T12:00:00.000Z',
      '2026-10-13T12:00:00.000Z',
      '2031-06-25T12:00:00.000Z',
    ]) {
      const provider = createSimulatedProvider({
        seed: 'tradia-e2e',
        now: () => Date.parse(instant),
      });
      const quote = await provider.getQuote('EURUSD');
      expect(quote.last).toBeGreaterThanOrEqual(0.9);
      expect(quote.last).toBeLessThanOrEqual(1.4);
    }
    // Y sigue siendo determinista para el mismo (seed, ticker).
    const a = createSimulatedProvider({ seed: 'tradia-e2e', now: () => FX_NOW });
    const b = createSimulatedProvider({ seed: 'tradia-e2e', now: () => FX_NOW });
    expect(await a.getQuote('EURUSD')).toEqual(await b.getQuote('EURUSD'));
  });

  it('cada par se mueve en torno a su nivel realista con variación diaria ≈0,5 %', async () => {
    const provider = makeFx();
    const quote = async (ticker: string) => (await provider.getQuote(ticker)).last;
    // Nivel de cada par en su propia escala (USD por EUR/GBP; JPY y CHF
    // por USD), nunca el precio de una acción.
    expect(await quote('EURUSD')).toBeGreaterThan(0.9);
    expect(await quote('EURUSD')).toBeLessThan(1.4);
    expect(await quote('GBPUSD')).toBeGreaterThan(1.0);
    expect(await quote('GBPUSD')).toBeLessThan(1.6);
    expect(await quote('USDCHF')).toBeGreaterThan(0.7);
    expect(await quote('USDCHF')).toBeLessThan(1.1);
    expect(await quote('USDJPY')).toBeGreaterThan(120);
    expect(await quote('USDJPY')).toBeLessThan(180);

    const bars = await provider.getBars('EURUSD', '2024-01-02', '2024-07-05');
    let maxMove = 0;
    let moves = 0;
    for (let i = 1; i < bars.length; i += 1) {
      const move = Math.abs(bars[i]!.close / bars[i - 1]!.close - 1);
      expect(bars[i]!.close).toBeGreaterThanOrEqual(0.9);
      expect(bars[i]!.close).toBeLessThanOrEqual(1.4);
      maxMove = Math.max(maxMove, move);
      if (move > 0) moves += 1;
    }
    // El par varía cada día pero con pasos de divisa (techo ≈1 %), no de
    // acción (2 % diarios en el paseo libre).
    expect(moves).toBeGreaterThan(0);
    expect(maxMove).toBeGreaterThan(0.001);
    expect(maxMove).toBeLessThan(0.02);
  });
});
