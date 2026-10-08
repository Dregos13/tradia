import { describe, expect, it } from 'vitest';

import type { AdjustedBar } from './types';
import { batchHash, nextBatchVersion, normalizeBatch } from './version';

const adjBar = (date: string, over: Partial<AdjustedBar> = {}): AdjustedBar => ({
  date,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1_000_000,
  adjClose: 100,
  splitFactor: 1,
  dividend: 0,
  adjOpen: 100,
  adjHigh: 101,
  adjLow: 99,
  adjVolume: 1_000_000,
  ...over,
});

describe('batchHash', () => {
  it('es estable: mismo contenido, mismo SHA-256', () => {
    const bars = [adjBar('2024-01-02'), adjBar('2024-01-03')];
    expect(batchHash(bars)).toBe(batchHash([...bars]));
    expect(batchHash(bars)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no depende del orden de las velas (normalización por fecha)', () => {
    const a = [adjBar('2024-01-02'), adjBar('2024-01-03')];
    const b = [adjBar('2024-01-03'), adjBar('2024-01-02')];
    expect(batchHash(a)).toBe(batchHash(b));
  });

  it('cambia si cambia cualquier campo del lote', () => {
    const base = [adjBar('2024-01-02'), adjBar('2024-01-03')];
    const hash = batchHash(base);

    expect(batchHash([adjBar('2024-01-02', { close: 100.5 }), adjBar('2024-01-03')])).not.toBe(
      hash,
    );
    expect(batchHash([adjBar('2024-01-02'), adjBar('2024-01-03', { volume: 2 })])).not.toBe(hash);
    expect(batchHash([...base, adjBar('2024-01-04')])).not.toBe(hash);
  });

  it('normaliza el ruido de coma flotante y los valores no finitos', () => {
    const a = [adjBar('2024-01-02', { close: 100 })];
    const b = [adjBar('2024-01-02', { close: 100.00000000001 })];
    expect(batchHash(a)).toBe(batchHash(b));

    const c = [adjBar('2024-01-02', { close: -0 })];
    const d = [adjBar('2024-01-02', { close: 0 })];
    expect(batchHash(c)).toBe(batchHash(d));

    // Un valor no finito no rompe el hash: se serializa como null.
    expect(() => batchHash([adjBar('2024-01-02', { close: Number.NaN })])).not.toThrow();
  });
});

describe('nextBatchVersion', () => {
  const bars = [adjBar('2024-01-02'), adjBar('2024-01-03')];

  it('sin lote previo la versión es 1', () => {
    expect(nextBatchVersion(bars)).toEqual({ version: 1, hash: batchHash(bars) });
    expect(nextBatchVersion(bars, null).version).toBe(1);
  });

  it('el mismo lote reprocesado conserva la versión', () => {
    const first = nextBatchVersion(bars);
    const again = nextBatchVersion(bars, first);
    expect(again).toEqual(first);
    // También con una versión alta ya persistida.
    expect(nextBatchVersion(bars, { version: 7, hash: first.hash }).version).toBe(7);
  });

  it('un lote distinto incrementa la versión', () => {
    const first = nextBatchVersion(bars);
    const changed = nextBatchVersion([adjBar('2024-01-02', { close: 50 })], first);
    expect(changed.version).toBe(first.version + 1);
    expect(changed.hash).not.toBe(first.hash);
  });
});

describe('normalizeBatch', () => {
  it('ordena por fecha y fija el orden de los campos', () => {
    const rows = normalizeBatch([adjBar('2024-01-03'), adjBar('2024-01-02')]);
    expect(rows.map((r) => r[0])).toEqual(['2024-01-02', '2024-01-03']);
    expect(rows[0]).toHaveLength(13);
  });
});
