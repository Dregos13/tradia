import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Esquema anterior: data_status con los cuatro estados antiguos. */
const PHASE_0_17 = MIGRATIONS.filter((m) => m.version <= 17);
/** Incluye la 018: 'sin-cobertura' en el CHECK y la recalificación. */
const ALL = MIGRATIONS.filter((m) => m.version <= 18);

const insertStatus = (
  db: Database.Database,
  clave: string,
  estado: string,
  fallos: number,
  motivo: string | null,
): void => {
  db.prepare(
    `INSERT INTO data_status (clave, estado, ultimo_ok, fallos_seguidos, motivo, actualizado_en)
     VALUES (?, ?, '2026-10-07T21:15:00.000Z', ?, ?, '2026-10-12T10:00:00.000Z')`,
  ).run(clave, estado, fallos, motivo);
};

const statusOf = (db: Database.Database, clave: string) =>
  db
    .prepare(
      `SELECT estado, fallos_seguidos AS fallos, motivo, ultimo_ok AS ultimoOk, actualizado_en AS actualizadoEn
       FROM data_status WHERE clave = ?`,
    )
    .get(clave) as {
    estado: string;
    fallos: number;
    motivo: string | null;
    ultimoOk: string | null;
    actualizadoEn: string;
  };

describe('migración 018 · estado sin-cobertura en data_status', () => {
  it('amplía el CHECK y reclasifica las filas «no devolvió datos» a sin-cobertura', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_17);

    // Antes de subir, 'sin-cobertura' no cabe en el CHECK.
    expect(() => insertStatus(db, 'ticker:EUR', 'sin-cobertura', 0, null)).toThrowError();

    // Filas del caso EUR: el proveedor respondió vacío y el código viejo
    // lo marcó 'no-fiable' con fallos.
    insertStatus(
      db,
      'ticker:EUR',
      'no-fiable',
      2,
      "el proveedor 'tiingo' no devolvió datos para EUR",
    );
    // Un 404 guardado por el camino 'not-found' también es sin cobertura.
    insertStatus(
      db,
      'ticker:GBP',
      'no-fiable',
      1,
      '[tiingo] recurso no encontrado (HTTP 404): Not found',
    );
    // Un 'no-fiable' por otra causa (anomalía) no se toca.
    insertStatus(db, 'ticker:AAPL', 'no-fiable', 0, 'valor anómalo grave en el último lote');
    // Un 'desactualizado' con motivo parecido tampoco: solo 'no-fiable'.
    insertStatus(
      db,
      'ticker:MSFT',
      'desactualizado',
      1,
      "el proveedor 'tiingo' no devolvió datos para MSFT",
    );
    // La fila del proveedor con el mismo motivo no es sin cobertura: la
    // cobertura es por activo, y el refresco la corrige al responder.
    insertStatus(
      db,
      'provider:tiingo',
      'no-fiable',
      3,
      "el proveedor 'tiingo' no devolvió datos para EUR",
    );

    expect(migrate(db, ALL)).toEqual([18]);

    // Las dos filas sin cobertura se recalculan sin perder el motivo ni
    // la marca temporal; los fallos que arrastraban no eran fallos reales.
    expect(statusOf(db, 'ticker:EUR')).toMatchObject({
      estado: 'sin-cobertura',
      fallos: 0,
      motivo: "el proveedor 'tiingo' no devolvió datos para EUR",
      ultimoOk: '2026-10-07T21:15:00.000Z',
      actualizadoEn: '2026-10-12T10:00:00.000Z',
    });
    expect(statusOf(db, 'ticker:GBP')).toMatchObject({
      estado: 'sin-cobertura',
      fallos: 0,
    });
    // El resto queda intacto.
    expect(statusOf(db, 'ticker:AAPL')).toMatchObject({ estado: 'no-fiable', fallos: 0 });
    expect(statusOf(db, 'ticker:MSFT')).toMatchObject({
      estado: 'desactualizado',
      fallos: 1,
    });
    expect(statusOf(db, 'provider:tiingo')).toMatchObject({
      estado: 'no-fiable',
      fallos: 3,
    });
    db.close();
  });

  it('la vuelta atrás restaura el CHECK y devuelve sin-cobertura a no-fiable', () => {
    const db = new Database(':memory:');
    migrate(db, ALL);
    insertStatus(db, 'ticker:EUR', 'sin-cobertura', 0, 'el proveedor no devolvió datos para EUR');
    insertStatus(db, 'ticker:AAPL', 'fiable', 0, null);

    expect(rollbackLast(db, MIGRATIONS)).toBe(18);

    // 'sin-cobertura' vuelve a 'no-fiable' con al menos un fallo para que
    // la parada de la versión anterior no lo lea como anomalía (fallos 0).
    expect(statusOf(db, 'ticker:EUR')).toMatchObject({ estado: 'no-fiable', fallos: 1 });
    expect(statusOf(db, 'ticker:AAPL')).toMatchObject({ estado: 'fiable', fallos: 0 });
    // El CHECK antiguo vuelve a rechazar el estado nuevo.
    expect(() => insertStatus(db, 'ticker:GBP', 'sin-cobertura', 0, null)).toThrowError();
    db.close();
  });
});
