import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db/database';
import { createRoutineReads, createRoutineRunsRepository } from './repository';

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

const insertJournal = (): number =>
  Number(
    db
      .prepare(`INSERT INTO journal_entries (tipo, motivo) VALUES ('resumen', 'Resumen de prueba')`)
      .run().lastInsertRowid,
  );

const insertSignal = (ticker = 'AAPL'): number =>
  Number(
    db
      .prepare(
        `INSERT INTO signals
           (ticker, direccion, entrada, confianza, motivo, estrategias, datos_usados, decision, estado, vela_fecha)
         VALUES (?, 'largo', 100, 0.6, 'motivo', '[]', '{}',
                 '{"status":"aprobada","size":5,"sizeFactor":1,"riskAmount":25,"notional":500,"reasons":[],"decidedAt":"2026-10-07T20:00:00.000Z"}',
                 'aprobada', '2026-10-06')`,
      )
      .run(ticker).lastInsertRowid,
  );

const insertPosition = (patch: {
  signalId?: number | null;
  cerradaEn?: string | null;
  salida?: number | null;
  motivoSalida?: string | null;
}): number =>
  Number(
    db
      .prepare(
        `INSERT INTO risk_portfolio_positions
           (ticker, direccion, entrada, stop, objetivo, tamano, sector, divisa,
            senal_id, vela_apertura, salida, motivo_salida, abierta_en, cerrada_en)
         VALUES ('AAPL', 'largo', 100, 95, 110, 5, NULL, 'USD',
                 ?, '2026-10-06', ?, ?, '2026-10-07T13:00:00.000Z', ?)`,
      )
      .run(
        patch.signalId ?? null,
        patch.salida ?? null,
        patch.motivoSalida ?? null,
        patch.cerradaEn ?? null,
      ).lastInsertRowid,
  );

describe('routine_runs · deduplicación por día', () => {
  it('reserva la ejecución una sola vez por (rutina, dia)', () => {
    const repo = createRoutineRunsRepository(db);
    const id = repo.claim('preapertura', '2026-10-07', false, '2026-10-07T12:30:00.000Z');
    expect(id).not.toBeNull();
    // Segunda reclamación del mismo día: nula, sin duplicar la fila.
    expect(repo.claim('preapertura', '2026-10-07', true, '2026-10-07T13:00:00.000Z')).toBeNull();
    expect(repo.has('preapertura', '2026-10-07')).toBe(true);
    // Otra rutina del mismo día y la misma rutina otro día sí reservan.
    expect(repo.claim('cierre', '2026-10-07', false, '2026-10-07T20:15:00.000Z')).not.toBeNull();
    expect(
      repo.claim('preapertura', '2026-10-08', false, '2026-10-08T12:30:00.000Z'),
    ).not.toBeNull();
  });

  it('guarda la marca de retraso y enlaza la entrada del diario', () => {
    const repo = createRoutineRunsRepository(db);
    const journalId = insertJournal();
    const id = repo.claim('conciliacion', '2026-10-07', true, '2026-10-07T22:00:00.000Z')!;
    repo.attachJournal(id, journalId);
    const run = repo.get('conciliacion', '2026-10-07');
    expect(run).toMatchObject({
      rutina: 'conciliacion',
      dia: '2026-10-07',
      enviadaEn: '2026-10-07T22:00:00.000Z',
      conRetraso: true,
      journalId,
    });
    expect(repo.get('cierre', '2026-10-07')).toBeNull();
  });

  it('ignora rutinas fuera del CHECK de la tabla (OR IGNORE: no reserva)', () => {
    const repo = createRoutineRunsRepository(db);
    expect(
      repo.claim('nocturna' as never, '2026-10-07', false, '2026-10-07T12:30:00.000Z'),
    ).toBeNull();
    expect(repo.has('nocturna' as never, '2026-10-07')).toBe(false);
  });
});

describe('routineReads · conciliación sobre la cartera simulada', () => {
  it('lista posiciones abiertas y cerradas con su trazabilidad', () => {
    const signalId = insertSignal();
    const abierta = insertPosition({ signalId });
    const cerrada = insertPosition({
      cerradaEn: '2026-10-07T19:30:00.000Z',
      salida: 110,
      motivoSalida: 'objetivo',
    });
    const reads = createRoutineReads(db);
    const positions = reads.listPaperPositions();
    expect(positions.map((p) => p.id)).toEqual([abierta, cerrada]);
    expect(positions[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      entry: 100,
      size: 5,
      signalId,
      openedOnBar: '2026-10-06',
      closedAt: null,
    });
    expect(positions[1]).toMatchObject({ closedAt: '2026-10-07T19:30:00.000Z', exit: 110 });
    expect(reads.getPaperPosition(cerrada)?.exitReason).toBe('objetivo');
    expect(reads.getPaperPosition(9999)).toBeNull();
    expect(reads.hasPositionForSignal(signalId)).toBe(true);
    expect(reads.hasPositionForSignal(9999)).toBe(false);
  });

  it('devuelve la curva de capital en orden cronológico', () => {
    db.prepare(
      `INSERT INTO risk_equity_history (fecha, capital) VALUES
      ('2026-10-06T20:30:00.000Z', 100000),
      ('2026-10-07T19:30:00.000Z', 100050)`,
    ).run();
    const reads = createRoutineReads(db);
    expect(reads.listEquityHistory()).toEqual([
      { fecha: '2026-10-06T20:30:00.000Z', capital: 100000 },
      { fecha: '2026-10-07T19:30:00.000Z', capital: 100050 },
    ]);
  });
});
