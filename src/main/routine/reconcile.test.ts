import { describe, expect, it } from 'vitest';

import type { JournalEntry } from '../../shared/journal';
import type { Signal } from '../../shared/signals';
import type { PaperPositionRecord } from '../risk/portfolio';
import { reconcileDay } from './reconcile';
import type { EquityHistoryRow } from './repository';

/** Miércoles de mercado (EDT) usado en toda la batería. */
const DIA = '2026-10-07';
/** 19:30 UTC = 15:30 en Nueva York (EDT): cae dentro del día de mercado. */
const CIERRE_UTC = '2026-10-07T19:30:00.000Z';
/** 02:00 UTC del día siguiente = 22:00 del día en Nueva York: aún es DIA allí. */
const CIERRE_TARDE_UTC = '2026-10-08T02:00:00.000Z';

const makeSignal = (patch: Partial<Signal> = {}): Signal => ({
  id: 1,
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 110,
  confidence: 0.6,
  reason: 'Cruce de medias alcista',
  strategies: [],
  dataUsed: {
    barDate: DIA,
    desde: '2026-09-01',
    hasta: DIA,
    barCount: 25,
    batchId: 1,
    batchVersion: 2,
    source: 'simulado',
  },
  decision: {
    status: 'aprobada',
    size: 5,
    sizeFactor: 1,
    riskAmount: 25,
    notional: 500,
    reasons: [],
    decidedAt: '2026-10-07T20:00:00.000Z',
  },
  destination: 'cartera-simulada',
  destinationReason: null,
  createdAt: '2026-10-07T20:00:00.000Z',
  ...patch,
});

const makePosition = (patch: Partial<PaperPositionRecord> = {}): PaperPositionRecord => ({
  id: 11,
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 110,
  size: 5,
  sector: null,
  currency: 'USD',
  signalId: 1,
  openedOnBar: '2026-10-06',
  openedAt: '2026-10-07T13:00:00.000Z',
  closedAt: CIERRE_UTC,
  exit: 110,
  exitReason: 'objetivo',
  ...patch,
});

const makeOperation = (patch: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 21,
  type: 'operacion',
  createdAt: CIERRE_UTC,
  ticker: 'AAPL',
  strategies: [],
  reason: 'Cierre simulado por objetivo',
  dataUsed: { posicionId: 11, pnl: 50 },
  result: 'ganancia',
  errors: [],
  ruleChecks: [],
  signalId: 1,
  ...patch,
});

const baseInput = () => {
  const signal = makeSignal();
  const position = makePosition(); // (110-100)*5 = +50
  const operation = makeOperation();
  const equityHistory: EquityHistoryRow[] = [
    { fecha: '2026-10-06T20:00:00.000Z', capital: 100_000 },
    { fecha: CIERRE_UTC, capital: 100_050 },
  ];
  return {
    dia: DIA,
    signals: [signal],
    positions: [position],
    operations: [operation],
    equityHistory,
  };
};

describe('reconcileDay', () => {
  it('no reporta discrepancias cuando todo cuadra', () => {
    const result = reconcileDay(baseInput());
    expect(result.discrepancies).toEqual([]);
    expect(result.checked).toEqual({
      senalesAprobadas: 1,
      posicionesCerradasHoy: 1,
      operacionesHoy: 1,
      cierresConCurva: 1,
    });
  });

  it('señal aprobada con tamaño sin posición enlazada es discrepancia', () => {
    const input = baseInput();
    input.positions = [];
    input.operations = [];
    const result = reconcileDay(input);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toContain('señal #1');
    expect(result.discrepancies[0]).toContain('AAPL');
  });

  it('las señales vetadas o sin tamaño no exigen posición', () => {
    const input = baseInput();
    input.signals = [
      makeSignal({
        id: 2,
        decision: {
          status: 'vetada',
          size: 0,
          sizeFactor: 0,
          riskAmount: 0,
          notional: 0,
          reasons: [],
          decidedAt: '2026-10-07T20:00:00.000Z',
        },
      }),
      makeSignal({ id: 3, decision: { ...makeSignal().decision, status: 'reducida', size: 0 } }),
    ];
    input.positions = [makePosition({ signalId: null })];
    const result = reconcileDay(input);
    // Las señales no exigen posición; la posición cerrada sigue cuadrando
    // (su operación del diario existe).
    expect(result.discrepancies).toEqual([]);
    expect(result.checked.senalesAprobadas).toBe(0);
  });

  it('posición cerrada hoy sin operación en el diario es discrepancia', () => {
    const input = baseInput();
    input.operations = [];
    const result = reconcileDay(input);
    expect(result.discrepancies.some((d) => d.includes('posición #11'))).toBe(true);
  });

  it('una operación de dinero real no cuadra contra la cartera simulada ni da discrepancia', () => {
    const input = baseInput();
    // La entrada 'operacion' de la prueba de humo (sin posicionId, como
    // corresponde a una operación real) no es una operación simulada.
    input.operations = [
      ...input.operations,
      makeOperation({
        id: 40,
        mode: 'live',
        ticker: 'SPY',
        reason: 'Prueba de humo real completada: compra y cierre conciliados',
        dataUsed: { notionalUsd: 1, descuadres: 0 },
      }),
    ];
    const result = reconcileDay(input);
    expect(result.discrepancies).toEqual([]);
    // Solo cuenta las operaciones simuladas.
    expect(result.checked.operacionesHoy).toBe(1);
  });

  it('operación del diario sin posición o con P&L distinto es discrepancia', () => {
    const input = baseInput();
    input.operations = [
      makeOperation({ id: 30, dataUsed: { posicionId: 999, pnl: 50 } }),
      makeOperation({ id: 31, dataUsed: { posicionId: 11, pnl: -30 } }),
      makeOperation({ id: 32, dataUsed: {} }),
    ];
    const discrepancies = reconcileDay(input).discrepancies;
    expect(discrepancies.some((d) => d.includes('posición #999'))).toBe(true);
    expect(discrepancies.some((d) => d.includes('P&L'))).toBe(true);
    expect(discrepancies.some((d) => d.includes('operación #32'))).toBe(true);
  });

  it('cierre sin punto en la curva de capital es discrepancia', () => {
    const input = baseInput();
    input.equityHistory = [{ fecha: '2026-10-06T20:00:00.000Z', capital: 100_000 }];
    const result = reconcileDay(input);
    expect(result.discrepancies.some((d) => d.includes('curva de capital'))).toBe(true);
  });

  it('punto de capital cuyo delta no cuadra con el P&L es discrepancia', () => {
    const input = baseInput();
    input.equityHistory = [
      { fecha: '2026-10-06T20:00:00.000Z', capital: 100_000 },
      { fecha: CIERRE_UTC, capital: 100_500 }, // +500 pero el cierre suma +50
    ];
    const result = reconcileDay(input);
    expect(result.discrepancies.some((d) => d.includes('varía 500'))).toBe(true);
  });

  it('acota al día reconciliado: cierres y operaciones de otros días no cuentan', () => {
    const input = baseInput();
    // Posición cerrada el día anterior (NY): no exige operación hoy.
    input.positions = [
      makePosition({ id: 12, closedAt: '2026-10-06T19:00:00.000Z' }),
      // Cierre a las 22:00 ET (02:00 UTC del día siguiente): aún es DIA en NY.
      makePosition({ id: 13, closedAt: CIERRE_TARDE_UTC, signalId: 9 }),
    ];
    input.signals = [makeSignal({ id: 9 })];
    input.operations = [
      makeOperation({ dataUsed: { posicionId: 13, pnl: 50 }, createdAt: CIERRE_TARDE_UTC }),
    ];
    input.equityHistory = [
      { fecha: '2026-10-06T20:00:00.000Z', capital: 100_000 },
      { fecha: CIERRE_TARDE_UTC, capital: 100_050 },
    ];
    const result = reconcileDay(input);
    expect(result.discrepancies).toEqual([]);
    expect(result.checked.posicionesCerradasHoy).toBe(1);
  });
});

describe('reconcileDay · divisas en la cartera simulada', () => {
  /**
   * Conciliación del lunes 7 de julio de 2025: la sesión anterior de NYSE
   * es el jueves 3; la vela de divisas del viernes 4 (festivo de NYSE)
   * llegó el sábado a la 01:00 UTC y su señal y su cierre se concilian hoy.
   */
  const LUNES = '2025-07-07';
  const JUEVES = '2025-07-03';
  /** Sábado 5, 01:30 UTC = viernes 4, 21:30 en Nueva York. */
  const CIERRE_FX = '2025-07-05T01:30:00.000Z';

  const fxInput = () => {
    const signal = makeSignal({
      id: 7,
      ticker: 'EURUSD',
      entry: 1.09,
      stop: 1.0464,
      target: 1.199,
      dataUsed: { ...makeSignal().dataUsed, barDate: '2025-07-03' },
      decision: { ...makeSignal().decision, size: 11_467 },
    });
    // Abierta con la vela del jueves 3 y cerrada por stop con la del viernes 4.
    const position = makePosition({
      id: 70,
      ticker: 'EURUSD',
      entry: 1.09,
      stop: 1.0464,
      target: 1.199,
      size: 11_467,
      currency: 'EUR',
      sector: 'divisas',
      signalId: 7,
      openedOnBar: '2025-07-03',
      closedAt: CIERRE_FX,
      exit: 1.0464,
      exitReason: 'stop',
    });
    const pnl = Math.round((1.0464 - 1.09) * 11_467 * 100) / 100;
    const operation = makeOperation({
      id: 71,
      ticker: 'EURUSD',
      createdAt: CIERRE_FX,
      dataUsed: { posicionId: 70, pnl },
      result: 'perdida',
      signalId: 7,
    });
    return {
      dia: LUNES,
      fxWindowStart: JUEVES,
      signals: [signal],
      positions: [position],
      operations: [operation],
      equityHistory: [
        { fecha: '2025-07-03T20:00:00.000Z', capital: 100_000 },
        { fecha: CIERRE_FX, capital: 100_000 + pnl },
      ] as EquityHistoryRow[],
    };
  };

  it('la señal, el cierre y la operación del par en la ventana [sesión anterior, día) cuadran', () => {
    const result = reconcileDay(fxInput());
    expect(result.discrepancies).toEqual([]);
    expect(result.checked).toEqual({
      senalesAprobadas: 1,
      posicionesCerradasHoy: 1,
      operacionesHoy: 1,
      cierresConCurva: 1,
    });
  });

  it('un P&L del diario que no cuadra con la posición de divisas es discrepancia', () => {
    const input = fxInput();
    input.operations = [
      makeOperation({ ...input.operations[0]!, dataUsed: { posicionId: 70, pnl: -1 } }),
    ];
    const result = reconcileDay(input);
    expect(result.discrepancies.some((d) => d.includes('posición #70'))).toBe(true);
  });

  it('una señal aprobada del par sin posición se detecta en la conciliación siguiente', () => {
    const input = fxInput();
    input.positions = [];
    input.operations = [];
    input.equityHistory = [];
    const result = reconcileDay(input);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toContain('EURUSD');
  });

  it('cada día de divisas cae en una sola conciliación: el del propio día queda para la siguiente', () => {
    const input = fxInput();
    // Mismos datos, pero conciliando el jueves 3: la vela del 3 y el
    // cierre del 4 todavía no le tocan (llegan después de las 17:30).
    const result = reconcileDay({ ...input, dia: JUEVES, fxWindowStart: '2025-07-02' });
    expect(result.checked.senalesAprobadas).toBe(0);
    expect(result.checked.posicionesCerradasHoy).toBe(0);
  });

  it('una señal de solo análisis (USDJPY) nunca exige posición', () => {
    const input = fxInput();
    input.signals = [
      makeSignal({
        id: 8,
        ticker: 'USDJPY',
        dataUsed: { ...makeSignal().dataUsed, barDate: '2025-07-03' },
        destination: 'solo-analisis',
        destinationReason: 'par no cotizado en USD: solo análisis por ahora',
      }),
    ];
    input.positions = [];
    input.operations = [];
    input.equityHistory = [];
    expect(reconcileDay(input).discrepancies).toEqual([]);
  });

  it('las acciones siguen conciliándose solo en su día', () => {
    const input = baseInput();
    const result = reconcileDay({ ...input, fxWindowStart: '2026-10-06' });
    expect(result.discrepancies).toEqual([]);
    expect(result.checked.senalesAprobadas).toBe(1);
  });
});
