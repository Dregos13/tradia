/**
 * Auditoría de seguridad del lenguaje de reglas propias y de su camino
 * hasta el dinero real — misión «completa-estas-partes»
 * (tarea seguridad-reglas-noticias).
 *
 * Las reglas de una ficha propia son texto libre del usuario que llega al
 * proceso principal por IPC (`strategies:*`), se compila con
 * `parseStrategyRules` y se ejecuta como estrategia en el backtest
 * (`createCustomStrategy`) y en el motor de señales (la sonda
 * `collectLastBarOrders`), cuyas propuestas acaban en `risk:submit-signal`
 * y, si el modo real está activo, en órdenes con dinero de verdad.
 *
 * Aquí se ataca ese camino desde fuera:
 *
 * - Entradas maliciosas al analizador: `constructor`, `__proto__` y la
 *   cadena de prototipos, cadenas enormes, anidación profunda, números
 *   no finitos, división por cero y periodos negativos o fuera de rango.
 * - El ejecutor compilado: operandos sin dato, velas corruptas y
 *   confirmación de que el programa es dato puro (no hay ejecución de
 *   código: el barrido de `eval`/`Function`/`import()` ya corre en
 *   `src/shared/strategyRules.test.ts`).
 * - La puerta de señales: una propia no puede emitir sin pasar por
 *   `risk:submit-signal` (pasarela única) ni saltarse los techos del
 *   dinero real (`orderGuard`), ni como entrada en corto.
 *
 * Convención: cada garantía corre como `it` normal. Ningún hallazgo se
 * marca como fallo esperado: los que haya se describen en
 * `docs/qa/auditoria-reglas-noticias.md` con su gravedad y sus pasos.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const electron = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

import type { MarketUpdatedEvent } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { RiskDecision } from '../../../shared/risk';
import type { CreateStrategyRequest, StrategyRules } from '../../../shared/strategy';
import type { Signal } from '../../../shared/signals';
import type { BrokerOrderRequest, RemoteOrder } from '../../broker/types';
import type { LiveOrderSnapshot } from '../../live/orderGuard';
import {
  parseStrategyRules,
  RULES_FIELD_MAX_LENGTH,
  RULES_MAX_DEPTH,
  RULES_MAX_PERIOD,
  RULES_MIN_PERIOD,
  type RulesBoolExpr,
  type RulesNumExpr,
  type StrategyProgram,
} from '../../../shared/strategyRules';
import { openDatabase } from '../../db/database';
import { createBacktestRepository } from '../repository';
import { createCustomStrategy } from '../strategies/custom';
import { createMarketRepository } from '../../market/repository';
import { createStrategiesRepository } from '../../strategies/repository';
import type { ServiceContext } from '../../services';
import { registerSignals } from '../../signals';
import { collectLastBarOrders } from '../../signals/probe';
import { liveOrderBlockReason, liveOrderWirePrice } from '../../live/orderGuard';
import { createOrderManager } from '../../broker/orderManager';
import { createBrokerRepository } from '../../broker/repository';
import { createSignalsRepository } from '../../signals/repository';

const NOW = Date.parse('2026-10-09T21:00:00.000Z');
// Reloj de mercado: tras el cierre del 08-10, así esa vela es la esperada.
const SIGNAL_CLOCK = { clock: { now: () => Date.parse('2026-10-08T21:00:00.000Z') } };

const RULES: StrategyRules = {
  entry: 'cierre > sma(2)',
  exit: 'cierre < sma(2)',
  stop: '5%',
  target: 'ninguno',
};

const parseErrors = (rules: Partial<StrategyRules>, parameters: Record<string, number> = {}) => {
  const result = parseStrategyRules({ ...RULES, ...rules }, parameters);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('inasequible');
  return result.errors;
};

const compile = (
  rules: Partial<StrategyRules> = {},
  parameters: Record<string, number> = {},
): StrategyProgram => {
  const result = parseStrategyRules({ ...RULES, ...rules }, parameters);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`no compila: ${JSON.stringify(result.errors)}`);
  return result.program;
};

const barsOf = (
  closes: number[],
): { date: string; open: number; high: number; low: number; close: number; volume: number }[] =>
  closes.map((close, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
  }));

// ---------------------------------------------------------------------------
// Analizador adversario
// ---------------------------------------------------------------------------

describe('auditoría del lenguaje de reglas · entradas maliciosas al análisis', () => {
  it('cadenas enormes se rechazan por campo, sin colgarse ni leer de más', () => {
    const huge = '1 '.repeat(250_000);
    const started = Date.now();
    const errors = parseErrors({ entry: huge });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(errors[0]).toMatchObject({ field: 'entry', start: RULES_FIELD_MAX_LENGTH });
    expect(errors[0]!.message).toContain(`${RULES_FIELD_MAX_LENGTH}`);

    // Los seis campos a la vez: cada uno reporta su propio tope.
    const all = parseErrors({
      entry: huge,
      exit: huge,
      stop: huge,
      target: huge,
      entryShort: huge,
      exitShort: huge,
    });
    expect(all.map((error) => error.field).sort()).toEqual([
      'entry',
      'entryShort',
      'exit',
      'exitShort',
      'stop',
      'target',
    ]);

    // Justo en el tope: una regla de 500 caracteres válida sigue pasando.
    const atCap = 'cierre > sma(2)'.padEnd(RULES_FIELD_MAX_LENGTH, ' ');
    expect(atCap.length).toBe(RULES_FIELD_MAX_LENGTH);
    expect(parseStrategyRules({ ...RULES, entry: atCap }, {}).ok).toBe(true);
  });

  it('anidación profunda se rechaza antes de desbordar la pila', () => {
    // Todas las entradas caben en los 500 caracteres: es la guarda de
    // profundidad (o la gramática de cruces) la que corta, no el tope.
    const cases: [string, Partial<StrategyRules>][] = [
      ['paréntesis', { entry: `${'('.repeat(200)}cierre > 3${')'.repeat(200)}` }],
      ['«no» encadenados', { entry: `${'no '.repeat(100)}cierre > 3` }],
      ['unarios', { entry: `${'-'.repeat(60)}sma(2) > 0` }],
      [
        'cruces anidados',
        {
          entry: (() => {
            let expr = 'cruza_arriba(sma(2), sma(3))';
            for (let i = 0; i < 19; i++) expr = `cruza_arriba(${expr}, sma(4))`;
            return expr;
          })(),
        },
      ],
      ['anidación en el stop', { stop: `${'('.repeat(80)}5${')'.repeat(80)}%` }],
    ];
    for (const [label, rules] of cases) {
      const started = Date.now();
      const errors = parseErrors(rules);
      expect(Date.now() - started, label).toBeLessThan(5_000);
      expect(
        errors.some((error) => /anidada|niveles|cerrar|válido|cruce|condición/.test(error.message)),
        `${label}: ${JSON.stringify(errors)}`,
      ).toBe(true);
    }
    // En el límite exacto sigue siendo válida: 32 niveles.
    expect(
      parseStrategyRules(
        {
          ...RULES,
          entry: `${'('.repeat(RULES_MAX_DEPTH)}cierre > 3${')'.repeat(RULES_MAX_DEPTH)}`,
        },
        {},
      ).ok,
    ).toBe(true);
  });

  it('«constructor», «__proto__» y la cadena de prototipos no resuelven nada por defecto', () => {
    // Nombres del runtime y del prototipo no son palabras del lenguaje.
    for (const word of [
      'constructor',
      '__proto__',
      'prototype',
      'hasOwnProperty',
      'eval',
      'Function',
      'process',
      'require',
      'globalThis',
      'window',
    ]) {
      const errors = parseErrors({ entry: `cierre > ${word}` });
      expect(errors[0]!.field).toBe('entry');
      expect(errors[0]!.message).toContain('no es');
    }
    // Ni siquiera como llamada: ninguna función del usuario existe.
    for (const word of ['eval', 'Function', 'execSync', 'require']) {
      expect(parseErrors({ entry: `${word}(cierre) > 1` })[0]!.field).toBe('entry');
    }
    // Ni con un objeto cuya cadena de prototipos los ofrece: solo cuentan
    // las claves propias, jamás las heredadas.
    const inherited = Object.create({ hostil: 9, otro: 2 }) as Record<string, number>;
    expect(parseErrors({ entry: 'cierre > hostil' }, inherited)[0]!.message).toContain('«hostil»');
    expect(parseErrors({ entry: 'cierre > otro' }, inherited)[0]!.message).toContain('«otro»');
  });

  it('un parámetro llamado «__proto__» o «constructor» vale por su clave propia y no contamina', () => {
    // Una ficha guardada desde JSON puede tener estas claves como
    // propiedad propia (IPC las admite: nombre de ≤64 caracteres y valor
    // finito). Deben comportarse como un parámetro más y nunca tocar el
    // prototipo compartido.
    const protoParams = JSON.parse('{"__proto__": 12}') as Record<string, number>;
    const program = compile({ entry: 'cierre = __proto__' }, protoParams);
    expect(program.parameters).toEqual(['__proto__']);
    const strategy = createCustomStrategy(program, protoParams);
    strategy.init(protoParams);
    const orders = collectLastBarOrders({
      strategy,
      params: protoParams,
      bars: { AAA: barsOf([10, 11, 12]) },
    });
    // La clave se leyó como 12 (su propio valor): solo la última vela lo
    // cumple y emite. Si hubiera leído Object.prototype sería «sin dato»
    // y no habría ninguna orden.
    expect(orders).toMatchObject([{ kind: 'buy', leg: 'entrada', referencePrice: 12 }]);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);

    const ctorParams = { constructor: 12 };
    const ctorProgram = compile({ entry: 'cierre = constructor' }, ctorParams);
    const ctorOrders = collectLastBarOrders({
      strategy: createCustomStrategy(ctorProgram, ctorParams),
      params: ctorParams,
      bars: { AAA: barsOf([10, 11, 12]) },
    });
    expect(ctorOrders).toMatchObject([{ kind: 'buy', leg: 'entrada' }]);

    // Y un valor de «__proto__» que no es número cierra el paso en init:
    // lanza, no contamina.
    const badProto = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, number>;
    const protoProgram = compile({ entry: 'cierre > __proto__' }, protoParams);
    expect(() => createCustomStrategy(protoProgram, badProto).init(badProto)).toThrow(TypeError);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('números no finitos: literales enormes y parámetros quedan inertes o cierran el paso', () => {
    // Un literal que desborda a Infinity compila pero es inerte: la
    // comparación se evalúa por vela y nunca se cumple (jamás NaN ni
    // excepción dentro del ejecutor).
    const program = compile({ entry: `cierre > ${'9'.repeat(490)}` });
    const orders = collectLastBarOrders({
      strategy: createCustomStrategy(program, {}),
      params: {},
      bars: { AAA: barsOf([10, 11, 12]) },
    });
    expect(orders).toEqual([]);

    // Un stop fuera de rango también se rechaza al analizar (el hueco
    // del múltiplo de ATR y del objetivo se cerró: ver HALLAZGO R1).
    expect(parseErrors({ stop: `${'9'.repeat(490)}%` })[0]!.field).toBe('stop');

    // Un parámetro no finito cierra el paso en `init` (TypeError), en
    // parse si es periodo, y evalúa a «sin dato» si es operando.
    expect(parseErrors({ entry: 'cierre > sma(n)' }, { n: Infinity })[0]!.field).toBe('entry');
    const used = compile({ entry: 'cierre > n' }, { n: 1 });
    expect(() => createCustomStrategy(used, { n: 1 }).init({ n: NaN })).toThrow(TypeError);
    expect(() => createCustomStrategy(used, { n: 1 }).init({ n: Infinity })).toThrow(TypeError);
    // Un parámetro extra no finito aunque la regla no lo use también
    // cierra el paso: mejor no operar que operar con datos corruptos.
    expect(() =>
      createCustomStrategy(used, { n: 1, sobra: 2 }).init({ n: 1, sobra: Infinity }),
    ).toThrow(TypeError);
  });

  it('HALLAZGO R1 (cerrado) · un nivel con escalar no finito se rechaza al analizar', () => {
    // `evalScalar` devolvía el literal sin comprobar finitud: un escalar
    // que desborda a Infinity cumplía el `value > 0` de `parseLevel`, así
    // el objetivo y los múltiplos de ATR compilaban a un nivel inerte
    // (INVALID_LEVEL) en vez de rechazarse. Cerrado: `evalScalar` solo
    // admite literales finitos (`strategyRules.ts`) y estas reglas ya no
    // compilan.
    for (const rules of [
      { target: `${'9'.repeat(490)}%` },
      { stop: `${'9'.repeat(480)} * atr(2)` },
      { target: `${'9'.repeat(480)} * atr(2)` },
    ]) {
      const field = Object.keys(rules)[0] as 'stop' | 'target';
      expect(parseErrors(rules)[0]!.field, `${field}: ${JSON.stringify(rules)}`).toBe(field);
    }
  });

  it('la división por cero nunca produce una orden: evalúa a falso o se rechaza', () => {
    // En una condición el resultado no finito es «sin dato»: la
    // comparación es falsa, vela a vela, sin lanzar ni emitir.
    for (const entry of ['cierre > sma(2) / 0', '0 / 0 = 0', 'sma(2) > 1 / (cierre - cierre)']) {
      const program = compile({ entry });
      expect(
        collectLastBarOrders({
          strategy: createCustomStrategy(program, {}),
          params: {},
          bars: { AAA: barsOf([10, 11, 12]) },
        }),
        entry,
      ).toEqual([]);
    }
    // En un nivel el escalar se evalúa al analizar: la división por cero
    // no da un número finito y la regla se rechaza con posición.
    for (const stop of ['(10 / 0) %', '0 / 0 %', '1 / (5 - 5) %']) {
      expect(parseErrors({ stop })[0]!.field).toBe('stop');
    }
    expect(parseErrors({ stop: '0 * atr(2)' })[0]!.field).toBe('stop');
  });

  it('periodos negativos, cero, no enteros o fuera de rango se rechazan en análisis y en init', () => {
    for (const entry of [
      'cierre > sma(-5)',
      'cierre > sma(0)',
      `cierre > sma(${RULES_MAX_PERIOD + 1})`,
      'cierre > sma(2.5)',
      'cierre > sma(1e3)',
      'cierre > rsi(-2)',
      'cierre > atr(0)',
      'cierre > maximo(-1)',
    ]) {
      expect(parseErrors({ entry })[0]!.field, entry).toBe('entry');
    }
    // Lo mismo cuando el periodo es un parámetro de la ficha.
    for (const n of [-3, 0, 2.5, RULES_MAX_PERIOD + 1, NaN, Infinity]) {
      expect(parseErrors({ entry: 'cierre > sma(n)' }, { n })[0]!.field, `${n}`).toBe('entry');
    }
    // Y en stop/target con atr(param).
    expect(parseErrors({ stop: '2 * atr(n)' }, { n: RULES_MIN_PERIOD - 1 })[0]!.field).toBe('stop');

    // Un periodo válido al analizar pero inválido al correr (p. ej. la
    // sensibilidad lo sobreescribe) cierra el paso en `init`: RangeError.
    const program = compile({ entry: 'cierre > sma(n)' }, { n: 4 });
    const strategy = createCustomStrategy(program, { n: 4 });
    for (const n of [-1, 0, 2.5, RULES_MAX_PERIOD + 1, NaN, Infinity]) {
      expect(() => strategy.init({ n }), `${n}`).toThrow();
    }
    expect(() => strategy.init({ n: RULES_MIN_PERIOD })).not.toThrow();
  });

  it('texto que no es una regla (binario, unicode hostil, clases erróneas) se rechaza o se aísla', () => {
    for (const entry of [
      'cierre > \x00',
      'cierre > \u202E',
      'cierre > 🚀',
      'cierre > sma()',
      'cierre > sma(2',
      'cierre >',
      'y',
      'no',
      'cierre >> sma(2)',
      'cierre > sma(2), sma(3)',
    ]) {
      expect(parseErrors({ entry })[0]!.field, JSON.stringify(entry)).toBe('entry');
    }
    // Un campo que no es texto no explota: se trata como vacío (los
    // obligatorios) o como error propio (los de corto).
    const noTexto = parseErrors({ entry: 42 as unknown as string });
    expect(noTexto[0]!.field).toBe('entry');
    const shortNoTexto = parseErrors({
      entryShort: ['x'] as unknown as string,
      exitShort: 'cierre > 3',
    });
    expect(shortNoTexto[0]).toMatchObject({ field: 'entryShort' });
    // `rules` null lanza TypeError (contrato tipado: el repositorio y el
    // guarda IPC `isStrategyRules` ya la impiden llegar); nunca cuelga.
    expect(() => parseStrategyRules(null as unknown as StrategyRules, {})).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Ejecutor compilado
// ---------------------------------------------------------------------------

describe('auditoría del lenguaje de reglas · el programa es dato puro y el ejecutor no se rompe', () => {
  it('el programa compilado es un AST de datos: serializable y solo con nodos del lenguaje', () => {
    const program = compile(
      {
        entry: 'cruza_arriba(sma(rapida), sma(lenta)) y rsi(14) < 70 y no volumen = 0',
        exit: 'cruza_abajo(sma(rapida), sma(lenta))',
        entryShort: 'cruza_abajo(sma(rapida), sma(lenta))',
        exitShort: 'cruza_arriba(sma(rapida), sma(lenta))',
        stop: '2 * atr(atrPeriod)',
        target: 'riesgo%',
      },
      { rapida: 2, lenta: 3, atrPeriod: 4, riesgo: 8 },
    );
    // Sobrevive el viaje por JSON: es lo que cruza el almacenamiento.
    const roundTrip = JSON.parse(JSON.stringify(program)) as StrategyProgram;
    expect(roundTrip).toEqual(program);
    const numKinds = new Set(['num', 'field', 'param', 'indicator', 'neg', 'arith']);
    const boolKinds = new Set(['cmp', 'cross', 'logic', 'not']);
    const visitNum = (node: RulesNumExpr): void => {
      expect(numKinds.has(node.kind)).toBe(true);
      if (node.kind === 'neg') visitNum(node.expr);
      if (node.kind === 'arith') {
        visitNum(node.left);
        visitNum(node.right);
      }
    };
    const visitBool = (node: RulesBoolExpr): void => {
      expect(boolKinds.has(node.kind)).toBe(true);
      if (node.kind === 'cmp' || node.kind === 'cross') {
        visitNum(node.left);
        visitNum(node.right);
      }
      if (node.kind === 'logic') {
        visitBool(node.left);
        visitBool(node.right);
      }
      if (node.kind === 'not') visitBool(node.expr);
    };
    for (const expr of [program.entry, program.exit, program.entryShort, program.exitShort]) {
      expect(expr).not.toBeNull();
      visitBool(expr!);
    }
  });

  it('velas corruptas (NaN, Infinity) nunca producen orden ni excepción', () => {
    const program = compile({
      entry: 'cierre > sma(2)',
      entryShort: 'cierre < sma(2)',
      exitShort: 'cierre > sma(2)',
    });
    const strategy = createCustomStrategy(program, {});
    const corrupted = barsOf([10, 11, 12]).map((bar) => ({
      ...bar,
      open: NaN,
      high: Infinity,
      low: -Infinity,
      close: NaN,
      volume: NaN,
    }));
    expect(collectLastBarOrders({ strategy, params: {}, bars: { AAA: corrupted } })).toEqual([]);
    const infinityClose = barsOf([10, 11, 12]).map((bar) => ({ ...bar, close: Infinity }));
    expect(collectLastBarOrders({ strategy, params: {}, bars: { AAA: infinityClose } })).toEqual(
      [],
    );
  });

  it('maximo(n)/minimo(n) leen solo las n velas anteriores: la actual y el futuro no se filtran', () => {
    // Última vela: máximo de la sesión 110, cierre 105, máximos previos
    // 100. Si maximo(3) mirara la vela actual valdría 110 y la regla
    // `cierre > maximo(3)` sería falsa; con solo las anteriores (100) es
    // verdadera y la orden se emite.
    const program = compile({ entry: 'cierre > maximo(3)' });
    const bars = [
      { date: '2026-10-05', open: 95, high: 100, low: 94, close: 96, volume: 100 },
      { date: '2026-10-06', open: 96, high: 99, low: 95, close: 98, volume: 100 },
      { date: '2026-10-07', open: 98, high: 100, low: 97, close: 99, volume: 100 },
      { date: '2026-10-08', open: 99, high: 110, low: 98, close: 105, volume: 100 },
    ];
    const orders = collectLastBarOrders({
      strategy: createCustomStrategy(program, {}),
      params: {},
      bars: { AAA: bars },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ kind: 'buy', leg: 'entrada', ticker: 'AAA' });
  });
});

// ---------------------------------------------------------------------------
// Pasarela de riesgo y techos del dinero real
// ---------------------------------------------------------------------------

const DECISION: RiskDecision = {
  status: 'aprobada',
  size: 5,
  sizeFactor: 1,
  riskAmount: 30,
  notional: 60,
  reasons: [],
  decidedAt: new Date(NOW).toISOString(),
};

let db: Database.Database;
let barsStoredListener: ((event: MarketUpdatedEvent) => void) | null;
let submitted: unknown[];
let broadcasted: { channel: string; payload: unknown }[];
let journalEntries: JournalRecordInput[];
let decision: RiskDecision;

/** Serie con subida clara en la última vela (cierre 12). */
const seedAaplBars = (): void => {
  const market = createMarketRepository(db);
  const batch = market.createBatch({
    version: 1,
    hash: 'h',
    provider: 'simulado',
    scope: 'bars',
    ticker: 'AAPL',
    rangeStart: '2026-10-01',
    rangeEnd: '2026-10-08',
  });
  market.upsertBars(
    'AAPL',
    'simulado',
    batch.id,
    [10, 10, 9, 9, 9, 12].map((close, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000,
    })),
  );
};

const seedCustomStrategy = (rules: Partial<CreateStrategyRequest['rules']> = {}): number => {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  const created = strategies.create({
    name: 'Propia auditoría',
    hypothesis: 'Auditoría de la pasarela.',
    rules: {
      entry: 'cruza_arriba(sma(2), sma(3))',
      exit: 'cruza_abajo(sma(2), sma(3))',
      stop: '5%',
      target: 'ninguno',
      ...rules,
    },
    parameters: {},
    markets: ['AAPL'],
    regime: 'tendencial',
  });
  strategies.setStatus({ id: created.id, status: 'activa' });
  return created.id;
};

const makeCtx = (overrides: { noRisk?: boolean } = {}): ServiceContext => {
  const settingsStore = new Map<string, string>();
  const ctx = {
    broadcast: (channel: string, payload: unknown) => {
      broadcasted.push({ channel, payload });
    },
    services: {
      storage: { getDb: () => db },
      strategies: createStrategiesRepository(
        db,
        (id) => createBacktestRepository(db).implementationKey(id) !== null,
      ),
      market: {
        listWatchlist: () => [{ ticker: 'AAPL', addedAt: '', position: 0 }],
        onBarsStored: (listener: (event: MarketUpdatedEvent) => void) => {
          barsStoredListener = listener;
          return () => {
            barsStoredListener = null;
          };
        },
      },
      risk: overrides.noRisk
        ? undefined
        : {
            submitSignal: (intent: unknown) => {
              submitted.push(intent);
              return decision;
            },
          },
      journal: { record: (input: JournalRecordInput) => journalEntries.push(input) },
      settings: {
        getValue: (key: string) => settingsStore.get(key) ?? null,
        setValue: (key: string, value: string) => void settingsStore.set(key, value),
      },
    },
  } as unknown as ServiceContext;
  return ctx;
};

const fireBarStored = (ticker = 'AAPL', lastDate = '2026-10-08'): void => {
  barsStoredListener?.({
    ticker,
    source: 'simulado',
    lastDate,
    updatedAt: new Date(NOW).toISOString(),
  });
};

/** Snapshot del modo real con los límites escritos en los techos fijos. */
const liveSnapshot = (patch: Partial<LiveOrderSnapshot> = {}): LiveOrderSnapshot => ({
  mode: 'activo',
  limits: {
    capitalUsd: 1_000,
    orderUsd: 200,
    dailyLossUsd: 20,
    openPositions: 2,
    shortOrderUsd: 100,
    shortExposureUsd: 200,
    shortPositions: 1,
  },
  openPositions: [],
  shortExposureUsd: 0,
  pendingShortUsd: 0,
  accountShorting: true,
  asset: { shortable: true, easyToBorrow: true },
  capitalInUseUsd: 0,
  realizedLossTodayUsd: 0,
  ...patch,
});

/** Adaptador de broker falso que solo registra los envíos. */
const spyAdapter = () => {
  const sent: BrokerOrderRequest[] = [];
  const adapter = {
    id: 'simulado' as const,
    paperOnly: true,
    getAccount: async () => ({
      accountId: 'ACC',
      status: 'ACTIVE',
      currency: 'USD',
      cash: 1_000,
      equity: 1_000,
      buyingPower: null,
      paper: false,
      shortingEnabled: true,
    }),
    listPositions: async () => [],
    getAsset: async (ticker: string) => ({
      ticker,
      tradable: true,
      shortable: true,
      easyToBorrow: true,
    }),
    listOrders: async () => [],
    getOrderByClientId: async () => null,
    submitOrder: async (request: BrokerOrderRequest): Promise<RemoteOrder> => {
      sent.push(request);
      return {
        brokerOrderId: `b-${sent.length}`,
        clientOrderId: request.clientOrderId,
        ticker: request.ticker,
        type: request.type,
        side: request.side,
        quantity: request.quantity,
        filledQuantity: 0,
        limitPrice: request.limitPrice ?? null,
        stopPrice: request.stopPrice ?? null,
        status: 'enviada',
        submittedAt: new Date(NOW).toISOString(),
        filledAt: null,
        filledAvgPrice: null,
        ocoGroupId: null,
        legs: null,
      };
    },
    cancelOrder: async () => {
      throw new Error('no aplica');
    },
  };
  return { adapter, sent };
};

let signalSeq = 0;

const insertSignal = (patch: Partial<Signal> = {}): Signal => {
  // (ticker, vela_fecha) es único en `signals`: cada señal sembrada lleva
  // una fecha distinta para no chocar con el antideduplicado.
  signalSeq += 1;
  const barDate = `2026-10-${String(Math.min(28, signalSeq)).padStart(2, '0')}`;
  const { signal } = createSignalsRepository(db).insertSignal({
    ticker: patch.ticker ?? 'AAPL',
    direction: 'corto',
    entry: 12,
    stop: 12.6,
    target: null,
    confidence: 0.6,
    reason: 'auditoría corto',
    strategies: [
      {
        strategyId: 1,
        name: 'Propia auditoría',
        version: 1,
        direction: 'corto',
        confidence: 0.6,
        reason: 'cierre > 11',
      },
    ],
    dataUsed: {
      barDate,
      desde: '2026-10-01',
      hasta: barDate,
      barCount: 6,
      batchId: null,
      batchVersion: null,
      source: 'simulado',
    },
    decision: patch.decision ?? DECISION,
    barDate,
  });
  return { ...signal, ...patch };
};

const makeManager = (snapshot: () => LiveOrderSnapshot) => {
  const { adapter, sent } = spyAdapter();
  const manager = createOrderManager({
    adapter,
    repository: createBrokerRepository(db),
    getSignal: (id) => createSignalsRepository(db).getSignal(id),
    isKillSwitchActive: () => false,
    isOnline: () => true,
    checkOrderAllowed: (request, context) => liveOrderBlockReason(snapshot(), request, context),
    orderWirePrice: (request, context) =>
      Promise.resolve(liveOrderWirePrice(snapshot(), request, context)),
    recordJournal: (input) => journalEntries.push(input),
    now: () => NOW,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, sent };
};

beforeEach(() => {
  electron.handlers.clear();
  db = openDatabase(':memory:');
  barsStoredListener = null;
  submitted = [];
  broadcasted = [];
  journalEntries = [];
  decision = DECISION;
  signalSeq = 0;
});

afterEach(() => {
  db.close();
});

describe('auditoría · la señal de una estrategia propia no sale del motor de riesgo', () => {
  it('toda propuesta de una propia cruza risk:submit-signal y conserva su decisión', () => {
    seedAaplBars();
    seedCustomStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();
    service.stop();

    const signals = createSignalsRepository(db).listSignals({});
    expect(signals).toHaveLength(1);
    // Exactamente un intent por la pasarela, con el sello 'estrategia'.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      origin: 'estrategia',
    });
    // La decisión persistida es la que devolvió la pasarela, no otra.
    expect(signals[0]!.decision).toEqual(DECISION);
    expect(signals[0]!.decision.status).toBe('aprobada');
  });

  it('sin pasarela de riesgo no se emite ni se marca la vela', () => {
    seedAaplBars();
    seedCustomStrategy();
    const service = registerSignals(makeCtx({ noRisk: true }), SIGNAL_CLOCK);

    fireBarStored();
    service.stop();

    expect(createSignalsRepository(db).listSignals({})).toHaveLength(0);
    expect(broadcasted.some(({ channel }) => channel.includes('signals:new'))).toBe(false);
    // El fallo queda en el Diario, no una señal sin veto.
    expect(
      journalEntries.some(
        (entry) => entry.type === 'error' && String(entry.reason).includes('señal'),
      ),
    ).toBe(true);
  });

  it('una decisión vetada se conserva en la señal y el gestor de órdenes no la ejecuta', async () => {
    seedAaplBars();
    seedCustomStrategy();
    decision = { ...DECISION, status: 'vetada', size: 0 };
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();
    service.stop();

    const [signal] = createSignalsRepository(db).listSignals({});
    expect(signal).toBeDefined();
    expect(signal!.decision.status).toBe('vetada');
    expect(submitted).toHaveLength(1);

    // El gestor solo ejecuta lo aprobado: la vetada no llega a la red.
    const { manager, sent } = makeManager(() => liveSnapshot());
    const result = await manager.handleSignalEvent({ signal });
    expect(result.outcome).toBe('ignorada');
    expect(sent).toHaveLength(0);
  });

  it('una entrada en corto de una propia respeta los techos del corto con dinero real', async () => {
    // Señal de corto producida por una propia real (reglas compiladas por
    // el propio motor): la construimos como el motor la entregaría.
    const signal = insertSignal({
      direction: 'corto',
      entry: 12,
      stop: 12.6,
      decision: { ...DECISION, size: 5, notional: 60 },
    });

    // Dentro de los techos (5 uds × 12 USD = 60 ≤ 100 con margen, stop a
    // +5 %): sale como venta stop a la referencia, nunca a mercado.
    const { manager, sent } = makeManager(() => liveSnapshot());
    const result = await manager.handleSignalEvent({ signal });
    expect(result.outcome).toBe('enviada');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'stop', side: 'sell', ticker: 'AAPL' });
    expect(sent[0]!.stopPrice).toBeLessThanOrEqual(12);
    expect(sent[0]!.stopPrice).toBeGreaterThan(0);

    // Por encima del techo por orden en corto (10 × 12 × 1,05 > 100):
    // bloqueada antes de la red.
    const bigSignal = insertSignal({
      direction: 'corto',
      entry: 12,
      stop: 12.6,
      decision: { ...DECISION, size: 10, notional: 120 },
    });
    const blocked = makeManager(() => liveSnapshot());
    const res = await blocked.manager.handleSignalEvent({ signal: bigSignal });
    expect(res.outcome).toBe('bloqueada');
    expect(blocked.sent).toHaveLength(0);
  });

  it('los agujeros de la puerta del corto se cierran: stop ausente/lejano, modo y lecturas del broker', async () => {
    const cases: {
      label: string;
      signal: Partial<Signal>;
      snapshot: () => LiveOrderSnapshot;
    }[] = [
      {
        label: 'sin stop de protección',
        signal: { stop: null },
        snapshot: () => liveSnapshot(),
      },
      {
        label: 'stop a más del 5 % sobre la entrada',
        signal: { stop: 13 },
        snapshot: () => liveSnapshot(),
      },
      {
        label: 'modo suspendido',
        signal: {},
        snapshot: () => liveSnapshot({ mode: 'suspendido' }),
      },
      {
        label: 'límites sin confirmar',
        signal: {},
        snapshot: () => liveSnapshot({ limits: null }),
      },
      {
        label: 'límites del corto a cero (desactivado)',
        signal: {},
        snapshot: () =>
          liveSnapshot({
            limits: {
              ...liveSnapshot().limits!,
              shortOrderUsd: 0,
              shortExposureUsd: 0,
              shortPositions: 0,
            },
          }),
      },
      {
        label: 'cuenta sin permiso de corto',
        signal: {},
        snapshot: () => liveSnapshot({ accountShorting: false }),
      },
      {
        label: 'cuenta no comprobada',
        signal: {},
        snapshot: () => liveSnapshot({ accountShorting: null }),
      },
      {
        label: 'título no prestable',
        signal: {},
        snapshot: () => liveSnapshot({ asset: { shortable: false, easyToBorrow: true } }),
      },
      {
        label: 'exposición corta desconocida',
        signal: {},
        snapshot: () => liveSnapshot({ shortExposureUsd: null }),
      },
      {
        label: 'exposición que superaría los 200 USD',
        signal: {},
        snapshot: () => liveSnapshot({ shortExposureUsd: 150 }),
      },
      {
        label: 'ya hay un corto abierto',
        signal: { ticker: 'BBB' },
        snapshot: () =>
          liveSnapshot({
            openPositions: [{ ticker: 'CCC', side: 'short', quantity: 5 }],
          }),
      },
      {
        label: 'pérdida diaria alcanzada',
        signal: {},
        snapshot: () => liveSnapshot({ realizedLossTodayUsd: 20 }),
      },
    ];
    for (const { label, signal, snapshot } of cases) {
      const seeded = insertSignal({
        direction: 'corto',
        entry: 12,
        stop: 12.6,
        decision: { ...DECISION, size: 5, notional: 60 },
        ...signal,
      });
      const { manager, sent } = makeManager(snapshot);
      const result = await manager.handleSignalEvent({ signal: seeded });
      expect(sent, `${label}: la orden llegó a la red`).toHaveLength(0);
      expect(result.outcome, label).not.toBe('enviada');
    }
  });

  it('los cierres pasan siempre: recompra de corto y pata de salida no se bloquean', () => {
    const snapshot = liveSnapshot({
      mode: 'suspendido',
      limits: null,
      openPositions: [{ ticker: 'AAPL', side: 'short', quantity: 5 }],
    });
    // Recomprar el corto abierto cierra riesgo: pasa aunque el modo esté
    // suspendido y los límites sin confirmar.
    expect(
      liveOrderBlockReason(
        snapshot,
        { ticker: 'AAPL', type: 'market', side: 'buy', quantity: 5 },
        { leg: null, requestedPrice: 12 },
      ),
    ).toBeNull();
    // La pata 'salida' del OCO tampoco se frena jamás.
    expect(
      liveOrderBlockReason(
        snapshot,
        { ticker: 'AAPL', type: 'oco', side: 'buy', quantity: 5 },
        { leg: 'salida', requestedPrice: 12.6 },
      ),
    ).toBeNull();
    // Pero una compra que daría la vuelta (más que el corto abierto) no.
    expect(
      liveOrderBlockReason(
        liveSnapshot({ openPositions: [{ ticker: 'AAPL', side: 'short', quantity: 5 }] }),
        { ticker: 'AAPL', type: 'market', side: 'buy', quantity: 6 },
        { leg: null, requestedPrice: 12 },
      ),
    ).toContain('vuelta');
    // Y una venta a mercado que abriría un corto nunca pasa la puerta
    // (defensa en profundidad: el gestor la convierte antes a stop, pero
    // la guarda no confía en que siempre se haga).
    expect(
      liveOrderBlockReason(
        liveSnapshot(),
        { ticker: 'AAPL', type: 'market', side: 'sell', quantity: 5 },
        { leg: 'entrada', requestedPrice: 12, entryStopPrice: 12.6 },
      ),
    ).toContain('mercado');
  });
});

// ---------------------------------------------------------------------------
// Superficie de código: el ejecutor no evalúa ni muta objetos del usuario
// ---------------------------------------------------------------------------

describe('auditoría del lenguaje de reglas · superficie de código', () => {
  it('los caminos de ejecución de reglas no construyen código ni leen propiedades dinámicas', () => {
    // El barrido de eval/Function/import() ya corre en
    // strategyRules.test.ts; aquí se comprueba además que ni el
    // analizador ni el ejecutor acceden a propiedades por nombre de
    // usuario ni modifican prototipos.
    const files = [
      'src/shared/strategyRules.ts',
      'src/main/backtest/strategies/custom.ts',
      'src/main/signals/probe.ts',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/__proto__\s*=/);
      expect(source, file).not.toMatch(/Object\.setPrototypeOf/);
      expect(source, file).not.toMatch(/Object\.assign\s*\(\s*{\s*}\s*,\s*parameters/);
      // Acceso a parámetros solo por claves conocidas del AST.
      expect(source, file).not.toMatch(/\[["']proto["']/);
    }
  });
});
