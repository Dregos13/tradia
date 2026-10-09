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
