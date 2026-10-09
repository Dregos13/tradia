import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CreateStrategyRequest } from '../../shared/strategy';
import { openDatabase } from '../db/database';
import { createStrategiesRepository, StrategiesError } from './repository';

let db: Database.Database;
let repo: ReturnType<typeof createStrategiesRepository>;

const BASE: CreateStrategyRequest = {
  name: 'Cruce de medias 50/200',
  hypothesis: 'Las tendencias de largo plazo persisten; el cruce las captura.',
  rules: {
    entry: 'Compra cuando SMA50 cruza al alza a SMA200.',
    exit: 'Vende cuando SMA50 cruza a la baja a SMA200.',
    stop: 'Stop a 2×ATR(14) bajo la entrada.',
    target: 'Sin objetivo fijo: sale por señal o por stop.',
  },
  parameters: { fast: 50, slow: 200, atrStop: 2 },
  parameterRanges: { fast: { min: 20, max: 100, step: 10 } },
  markets: ['SPY', 'QQQ'],
  trainingPeriod: { desde: '2005-01-01', hasta: '2015-12-31' },
  outOfSamplePeriod: { desde: '2016-01-01', hasta: '2024-12-31' },
  regime: 'Mercado tendencial alcista o bajista sostenido',
};

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createStrategiesRepository(db);
});

describe('alta de estrategia', () => {
  it('crea la versión 1 en estado investigacion y anota el registro', () => {
    const created = repo.create(BASE);

    expect(created.id).toBe(1);
    expect(created.version).toBe(1);
    expect(created.status).toBe('investigacion');
    expect(created.name).toBe(BASE.name);
    expect(created.rules).toEqual(BASE.rules);
    expect(created.parameters).toEqual(BASE.parameters);
    expect(created.parameterRanges).toEqual(BASE.parameterRanges);
    expect(created.markets).toEqual(['SPY', 'QQQ']);
    expect(created.trainingPeriod).toEqual(BASE.trainingPeriod);
    expect(created.outOfSamplePeriod).toEqual(BASE.outOfSamplePeriod);
    expect(created.regime).toBe(BASE.regime);
    expect(created.metricsSummary).toBeNull();
    // Los costes por defecto del plan cuando el alta no los trae.
    expect(created.assumedCosts).toEqual({
      commissionPct: 0.05,
      commissionMin: 1,
      slippageBps: 5,
      spreadBps: 2,
    });
    expect(created.changeNote).toBe('Alta de la estrategia');

    const history = repo.history(created.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: 'version',
      version: 1,
      note: 'Alta de la estrategia',
      fromStatus: null,
      toStatus: null,
    });
  });

  it('usa la nota del alta cuando la petición la trae', () => {
    const created = repo.create({ ...BASE, note: 'Idea de la revisión mensual' });
    expect(created.changeNote).toBe('Idea de la revisión mensual');
    expect(repo.history(created.id)[0]?.note).toBe('Idea de la revisión mensual');
  });

  it('aparece en la biblioteca con su versión vigente', () => {
    repo.create(BASE);
    repo.create({ ...BASE, name: 'RSI(2) reversión' });
    const list = repo.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 1, name: BASE.name, version: 1, status: 'investigacion' });
    expect(list[1]).toMatchObject({ id: 2, name: 'RSI(2) reversión', version: 1 });
  });

  it('rechaza fichas incompletas o inválidas', () => {
    expect(() => repo.create({ ...BASE, name: '  ' })).toThrowError(StrategiesError);
    expect(() => repo.create({ ...BASE, hypothesis: '' })).toThrowError(/hipotesis/);
    expect(() => repo.create({ ...BASE, rules: { ...BASE.rules, stop: '' } })).toThrowError(
      /reglas\.stop/,
    );
    expect(() => repo.create({ ...BASE, markets: [] })).toThrowError(/mercado/);
    expect(() => repo.create({ ...BASE, parameters: { fast: Number.NaN } })).toThrowError(
      StrategiesError,
    );
    expect(() =>
      repo.create({ ...BASE, parameterRanges: { periodo: { min: 1, max: 2, step: 1 } } }),
    ).toThrowError(/no corresponde a ningún parámetro/);
    expect(() =>
      repo.create({
        ...BASE,
        trainingPeriod: { desde: '2020-01-01', hasta: '2019-01-01' },
      }),
    ).toThrowError(/entrenamiento/);
    expect(() =>
      repo.create({
        ...BASE,
        assumedCosts: { commissionPct: 0.05, commissionMin: 1, slippageBps: -1, spreadBps: 2 },
      }),
    ).toThrowError(/negativo/);
  });
});

describe('versionado', () => {
  it('la edición crea la versión 2 con su nota y conserva la 1', () => {
    const created = repo.create(BASE);
    const updated = repo.update({
      id: created.id,
      note: 'Subo el stop a 3×ATR tras el primer backtest',
      parameters: { ...BASE.parameters, atrStop: 3 },
    });

    expect(updated.version).toBe(2);
    expect(updated.parameters.atrStop).toBe(3);
    // Los campos no tocados se heredan de la versión anterior.
    expect(updated.parameters.fast).toBe(50);
    expect(updated.name).toBe(BASE.name);
    expect(updated.changeNote).toBe('Subo el stop a 3×ATR tras el primer backtest');

    // La versión 1 sigue consultable con su contenido intacto.
    const v1 = repo.get(created.id, 1);
    expect(v1).not.toBeNull();
    expect(v1?.version).toBe(1);
    expect(v1?.parameters.atrStop).toBe(2);
    expect(repo.get(created.id)?.version).toBe(2);
    expect(repo.listVersions(created.id)).toEqual([1, 2]);

    const history = repo.history(created.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ kind: 'version', version: 2 });
    expect(history[1]).toMatchObject({ kind: 'version', version: 1 });
  });

  it('rechaza la edición sin nota o sin cambios', () => {
    const created = repo.create(BASE);
    expect(() => repo.update({ id: created.id, note: '', parameters: { fast: 10 } })).toThrowError(
      /nota de cambio/,
    );
    expect(() => repo.update({ id: created.id, note: '  ', name: 'Otro nombre' })).toThrowError(
      /nota de cambio/,
    );
    // Nota sin ningún campo versionable: no hay nada que versionar.
    expect(() => repo.update({ id: created.id, note: 'sin cambios' })).toThrowError(
      /al menos un campo/,
    );
    // Nada se ha escrito: sigue en la versión 1.
    expect(repo.get(created.id)?.version).toBe(1);
    expect(repo.history(created.id)).toHaveLength(1);
  });

  it('si cambian los parámetros, los rangos huérfanos no se arrastran a la nueva versión', () => {
    const created = repo.create(BASE);
    const updated = repo.update({
      id: created.id,
      note: 'Rehago la parametrización',
      parameters: { lookback: 60 },
    });
    expect(updated.parameters).toEqual({ lookback: 60 });
    expect(updated.parameterRanges).toEqual({});
  });
});

describe('cambio de estado', () => {
  it('anota el registro sin crear versión nueva', () => {
    const created = repo.create(BASE);
    repo.update({ id: created.id, note: 'ajuste', parameters: { fast: 40 } });

    const updated = repo.setStatus({ id: created.id, status: 'paper', note: 'Pasa a paper' });
    expect(updated.status).toBe('paper');
    expect(updated.version).toBe(2);
    expect(repo.listVersions(created.id)).toEqual([1, 2]);

    const history = repo.history(created.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      kind: 'estado',
      version: null,
      fromStatus: 'investigacion',
      toStatus: 'paper',
      note: 'Pasa a paper',
    });
  });

  it('genera una nota por defecto si el cambio no la trae', () => {
    const created = repo.create(BASE);
    repo.setStatus({ id: created.id, status: 'activa' });
    expect(repo.history(created.id)[0]?.note).toBe('Cambio de estado: investigacion → activa');
  });

  it('rechaza estados fuera del catálogo y el estado repetido', () => {
    const created = repo.create(BASE);
    expect(() => repo.setStatus({ id: created.id, status: 'en vivo' as never })).toThrowError(
      /estado de estrategia inválido/,
    );
    expect(() => repo.setStatus({ id: created.id, status: 'investigacion' })).toThrowError(
      /ya está en estado/,
    );
    expect(repo.get(created.id)?.status).toBe('investigacion');
    expect(repo.history(created.id)).toHaveLength(1);
  });
});

describe('consultas y métricas', () => {
  it('devuelve null ante ids o versiones inexistentes', () => {
    expect(repo.get(999)).toBeNull();
    const created = repo.create(BASE);
    expect(repo.get(created.id, 7)).toBeNull();
    expect(repo.list()).toHaveLength(1);
  });

  it('lanza not-found al editar, cambiar estado o métricas de algo inexistente', () => {
    expect(() => repo.update({ id: 9, note: 'x', name: 'y' })).toThrowError(/no existe/);
    expect(() => repo.setStatus({ id: 9, status: 'paper' })).toThrowError(/no existe/);
    expect(() =>
      repo.setVersionMetrics(9, {
        totalReturnPct: 1,
        maxDrawdownPct: 1,
        sharpe: 1,
        profitFactor: 1,
        winRatePct: 50,
        expectancy: 1,
        maxLosingStreak: 0,
        trades: 1,
      }),
    ).toThrowError(/no existe/);
  });

  it('setVersionMetrics escribe el resumen de una versión y sale en la lista', () => {
    const created = repo.create(BASE);
    repo.update({ id: created.id, note: 'v2', parameters: { fast: 30 } });
    const metrics = {
      totalReturnPct: 12.5,
      maxDrawdownPct: 8.2,
      sharpe: 0.9,
      profitFactor: 1.6,
      winRatePct: 55,
      expectancy: 45,
      maxLosingStreak: 3,
      trades: 20,
    };

    // Sin `version`: escribe en la vigente (v2). La v1 queda sin métricas.
    const updated = repo.setVersionMetrics(created.id, metrics);
    expect(updated.version).toBe(2);
    expect(updated.metricsSummary).toEqual(metrics);
    expect(repo.get(created.id, 1)?.metricsSummary).toBeNull();
    expect(repo.list()[0]?.metricsSummary).toEqual(metrics);

    // Con `version` explícita apunta a esa versión.
    repo.setVersionMetrics(created.id, { ...metrics, trades: 21 }, 1);
    expect(repo.get(created.id, 1)?.metricsSummary?.trades).toBe(21);
  });
});
