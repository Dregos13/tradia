import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: lo que la 007 extiende. */
const PHASE_0_2 = MIGRATIONS.filter((m) => m.version <= 6);
/** Hasta riesgo inclusive: lo que cubre esta prueba. */
const PHASE_3 = MIGRATIONS.filter((m) => m.version <= 7);

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

/** Límites válidos (los RISK_DEFAULTS del contrato). */
const INSERT_LIMITS = `INSERT INTO risk_limits (
    id, risk_per_trade_pct, min_reward_risk_ratio, max_daily_loss_pct,
    max_weekly_loss_pct, max_monthly_loss_pct, max_drawdown_pct,
    max_open_positions, max_asset_exposure_pct, max_sector_exposure_pct,
    max_currency_exposure_pct, max_correlation, max_leverage,
    max_liquidity_pct, updated_at
  ) VALUES (1, 0.5, 2, 2, 4, 6, 10, 5, 20, 30, 25, 0.7, 1, 1, '2026-10-09T00:00:00.000Z')`;

const INSERT_VETO = `INSERT INTO risk_vetoes (senal, ticker, decision, codigo, motivo, detalles)
  VALUES ('{"ticker":"AAPL","direction":"largo","entry":200,"stop":null,"target":null,"confidence":0.8,"origin":"estrategia"}',
          'AAPL', ?, ?, ?, '{}')`;

const INSERT_KILL_EVENT = `INSERT INTO kill_switch_events (accion, causa, actor, detalle)
  VALUES (?, ?, ?, NULL)`;

const INSERT_POSITION = `INSERT INTO risk_portfolio_positions
    (ticker, direccion, entrada, tamano, sector, divisa, cerrada_en)
  VALUES (?, ?, 100, 10, 'tecnologia', 'USD', ?)`;

const INSERT_EQUITY = `INSERT INTO risk_equity_history (fecha, capital) VALUES (?, ?)`;

describe('migración 007 · motor de riesgo', () => {
  it('sube sobre la fase anterior y crea las cinco tablas del módulo', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_2);

    expect(migrate(db, PHASE_3)).toEqual([7]);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'risk_limits',
        'risk_vetoes',
        'kill_switch_events',
        'risk_portfolio_positions',
        'risk_equity_history',
      ]),
    );
    db.close();
  });

  it('los límites son una fila única dentro de los márgenes duros', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_3);

    db.prepare(INSERT_LIMITS).run();
    // Singleton: no cabe una segunda fila.
    expect(() => db.prepare(INSERT_LIMITS.replace('1, 0.5', '2, 0.5')).run()).toThrowError();
    // Riesgo del 3 % por operación: fuera del margen duro 0,5–2.
    expect(() => db.prepare(INSERT_LIMITS.replace('0.5,', '3,')).run()).toThrowError();
    // Ratio 1:1,5: por debajo del mínimo de 2.
    expect(() => db.prepare(INSERT_LIMITS.replace('0.5, 2,', '0.5, 1.5,')).run()).toThrowError();
    // Apalancamiento distinto de 1x: fijo por CHECK.
    expect(() => db.prepare(INSERT_LIMITS.replace('0.7, 1,', '0.7, 2,')).run()).toThrowError();
    // Nada inválido quedó escrito.
    expect((db.prepare('SELECT COUNT(*) AS n FROM risk_limits').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('los vetos guardan la señal, la regla incumplida y los valores', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_3);

    db.prepare(INSERT_VETO).run('vetada', 'STOP_MISSING', 'La señal no tiene stop de protección');
    db.prepare(INSERT_VETO).run('reducida', 'CAUTION_MODE', 'Modo cautela');
    // La decisión solo admite 'vetada' o 'reducida'.
    expect(() => db.prepare(INSERT_VETO).run('aprobada', 'STOP_MISSING', 'x')).toThrowError();

    const vetadas = db
      .prepare("SELECT codigo FROM risk_vetoes WHERE decision = 'vetada'")
      .all() as { codigo: string }[];
    expect(vetadas.map((row) => row.codigo)).toEqual(['STOP_MISSING']);
    db.close();
  });

  it('el estado de la parada es el del último evento registrado', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_3);

    db.prepare(INSERT_KILL_EVENT).run('activada', 'perdida-anomala', 'automatico');
    db.prepare(INSERT_KILL_EVENT).run('reanudada', 'manual', 'usuario');

    const last = db
      .prepare('SELECT accion, causa, actor FROM kill_switch_events ORDER BY id DESC LIMIT 1')
      .get() as { accion: string; causa: string; actor: string };
    expect(last).toEqual({ accion: 'reanudada', causa: 'manual', actor: 'usuario' });

    // Los CHECK rechazan acciones, causas y actores ajenos al contrato.
    expect(() => db.prepare(INSERT_KILL_EVENT).run('pausada', 'manual', 'usuario')).toThrowError();
    expect(() => db.prepare(INSERT_KILL_EVENT).run('activada', 'bug', 'automatico')).toThrowError();
    expect(() => db.prepare(INSERT_KILL_EVENT).run('activada', 'manual', 'la-ia')).toThrowError();
    db.close();
  });

  it('las posiciones distinguen abiertas de cerradas y exigen dirección válida', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_3);

    db.prepare(INSERT_POSITION).run('AAPL', 'largo', null);
    db.prepare(INSERT_POSITION).run('MSFT', 'corto', '2026-10-01T15:00:00.000Z');
    expect(() => db.prepare(INSERT_POSITION).run('NVDA', 'compra', null)).toThrowError();
    expect(() => db.prepare(INSERT_POSITION).run('NVDA', 'largo', null)).not.toThrowError();
    // Entrada o tamaño no positivos quedan rechazados.
    expect(() =>
      db.prepare(INSERT_POSITION.replace('100, 10', '0, 10')).run('NVDA', 'largo', null),
    ).toThrowError();

    const abiertas = db
      .prepare(
        'SELECT ticker FROM risk_portfolio_positions WHERE cerrada_en IS NULL ORDER BY ticker',
      )
      .all() as { ticker: string }[];
    expect(abiertas.map((row) => row.ticker)).toEqual(['AAPL', 'NVDA']);
    db.close();
  });

  it('la curva de capital no admite dos puntos en el mismo instante', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_3);

    db.prepare(INSERT_EQUITY).run('2026-10-09T14:00:00.000Z', 100_000);
    db.prepare(INSERT_EQUITY).run('2026-10-09T15:00:00.000Z', 99_500);
    expect(() => db.prepare(INSERT_EQUITY).run('2026-10-09T14:00:00.000Z', 99_800)).toThrowError();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM risk_equity_history').get() as { n: number }).n,
    ).toBe(2);
    db.close();
  });

  it('revertir la 007 solo elimina las tablas del módulo de riesgo', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_3);
    db.prepare(INSERT_LIMITS).run();
    db.prepare(INSERT_VETO).run('vetada', 'STOP_MISSING', 'La señal no tiene stop de protección');
    db.prepare(INSERT_KILL_EVENT).run('activada', 'manual', 'usuario');

    expect(rollbackLast(db, PHASE_3)).toBe(7);
    const tables = tableNames(db);
    for (const table of [
      'risk_limits',
      'risk_vetoes',
      'kill_switch_events',
      'risk_portfolio_positions',
      'risk_equity_history',
    ]) {
      expect(tables).not.toContain(table);
    }
    // Las fases anteriores quedan intactas.
    expect(tables).toContain('strategies');
    expect(tables).toContain('backtest_runs');
    db.close();
  });
});
