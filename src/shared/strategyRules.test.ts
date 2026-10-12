/**
 * Pruebas del lenguaje de reglas de las estrategias propias:
 * análisis sintáctico, mensajes de error con posición, límites de
 * seguridad y garantía de que el módulo no ejecuta código.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  INDICADORES,
  PALABRAS_CLAVE,
  parseStrategyRules,
  RULES_FIELD_MAX_LENGTH,
  RULES_MAX_DEPTH,
  type StrategyProgram,
  type StrategyRulesError,
} from './strategyRules';
import type { StrategyRules } from './strategy';

const PARAMS = {
  rapida: 3,
  lenta: 8,
  atrPeriod: 14,
  stopAtr: 3,
  targetR: 2.5,
  umbral: 30,
  riesgo: 5,
};

function rules(over: Partial<StrategyRules> = {}): StrategyRules {
  return {
    entry: 'cruza_arriba(sma(rapida), sma(lenta))',
    exit: 'cruza_abajo(sma(rapida), sma(lenta))',
    stop: 'stopAtr * atr(atrPeriod)',
    target: 'targetR * stopAtr * atr(atrPeriod)',
    ...over,
  };
}

function parseOk(over: Partial<StrategyRules> = {}, params = PARAMS): StrategyProgram {
  const result = parseStrategyRules(rules(over), params);
  if (!result.ok) {
    throw new Error(`se esperaba ok y llegaron errores: ${JSON.stringify(result.errors)}`);
  }
  return result.program;
}

function parseErrors(over: Partial<StrategyRules>, params = PARAMS): StrategyRulesError[] {
  const result = parseStrategyRules(rules(over), params);
  if (result.ok) {
    throw new Error('se esperaban errores y el análisis devolvió ok');
  }
  return result.errors;
}

describe('análisis de reglas válidas', () => {
  it('compila el cruce de medias de la semilla con sus parámetros', () => {
    const program = parseOk();
    expect(program.entry).toMatchObject({
      kind: 'cross',
      direction: 'up',
      left: { kind: 'indicator', indicator: 'sma', period: { kind: 'param', name: 'rapida' } },
      right: { kind: 'indicator', indicator: 'sma', period: { kind: 'param', name: 'lenta' } },
    });
    expect(program.exit).toMatchObject({ kind: 'cross', direction: 'down' });
    expect(program.stop).toMatchObject({ kind: 'atr' });
    expect(program.target).toMatchObject({ kind: 'atr' });
    expect(program.parameters).toEqual(
      ['atrPeriod', 'lenta', 'rapida', 'stopAtr', 'targetR'].sort(),
    );
  });

  it('acepta comparaciones, lógica, paréntesis y aritmética', () => {
    const program = parseOk({
      entry: '(rsi(14) < umbral y cierre > sma(50)) o cruza_arriba(ema(10), sma(20))',
      exit: 'no (cierre >= apertura * 1,02) y rsi(14) > 70',
    });
    expect(program.entry.kind).toBe('logic');
    expect(program.exit.kind).toBe('logic');
  });

  it('acepta los seis campos, los seis indicadores y el decimal con coma', () => {
    const program = parseOk({
      entry:
        'cierre > maximo(20) y volumen > sma(20) * 1,5 y apertura > minimo(10) y atr(14) > 0,5',
      exit: 'cierre < minimo(10) o minimo < apertura - atr(14)',
    });
    expect(program.entry.kind).toBe('logic');
    expect(program.exit.kind).toBe('logic');
  });

  it('acepta «ninguno», «N%» y «K * atr(n)» en stop y objetivo', () => {
    const pct = parseOk({ stop: '5%', target: 'riesgo%' });
    expect(pct.stop).toMatchObject({ kind: 'pct' });
    expect(pct.target).toMatchObject({ kind: 'pct' });

    const none = parseOk({ stop: 'ninguno', target: 'Ninguno' });
    expect(none.stop).toEqual({ kind: 'none' });
    expect(none.target).toEqual({ kind: 'none' });

    const atr = parseOk({ stop: '2,5 * atr(14)', target: 'atr(atrPeriod)' });
    expect(atr.stop).toMatchObject({ kind: 'atr', period: { kind: 'const', value: 14 } });
    expect(atr.target).toMatchObject({
      kind: 'atr',
      period: { kind: 'param', name: 'atrPeriod' },
    });
  });

  it('no distingue mayúsculas ni acentos en las palabras del lenguaje', () => {
    const program = parseOk({
      entry: 'CRUZA_ARRIBA(SMA(rapida), SMA(lenta)) y CIERRE > MÁXIMO(20)',
    });
    expect(program.entry.kind).toBe('logic');
  });

  it('el programa compilado es un dato serializable', () => {
    const program = parseOk();
    expect(JSON.parse(JSON.stringify(program))).toEqual(program);
  });
});

describe('errores de análisis', () => {
  const fields: [keyof StrategyRules, string][] = [
    ['entry', 'entrada'],
    ['exit', 'salida'],
    ['stop', 'stop'],
    ['target', 'objetivo'],
  ];

  it('token desconocido', () => {
    const errors = parseErrors({ entry: 'cierre > sma(20) @' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: 'entry' });
    expect(errors[0]!.message).toContain('carácter no válido');
    expect(errors[0]!.start).toBeGreaterThanOrEqual(0);
    expect(errors[0]!.end).toBeGreaterThan(errors[0]!.start);
  });

  it('parámetro inexistente', () => {
    const errors = parseErrors({ entry: 'cierre > sma(inexistente)' });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('entry');
    expect(errors[0]!.message).toContain('inexistente');
    expect(errors[0]!.start).toBeGreaterThan(0);
    expect(errors[0]!.end).toBeGreaterThan(errors[0]!.start);
  });

  it('periodo fuera de rango', () => {
    for (const entry of ['sma(0) > 3', 'sma(501) > 3', 'sma(2,5) > 3']) {
      const errors = parseErrors({ entry });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.field).toBe('entry');
      expect(errors[0]!.message).toMatch(/periodo/);
    }
    const paramErrors = parseErrors({ entry: 'rsi(rapida) > 3' }, { ...PARAMS, rapida: 700 });
    expect(paramErrors[0]!.message).toMatch(/periodo/);
  });

  it('paréntesis sin cerrar', () => {
    const errors = parseErrors({ entry: '(cierre > sma(20)' });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('entry');
    expect(errors[0]!.message).toContain(')');
    expect(errors[0]!.end).toBeGreaterThanOrEqual(errors[0]!.start);
  });

  it('llamada sin cerrar señala el nombre de la función', () => {
    const errors = parseErrors({ entry: 'cruza_arriba(sma(3), sma(8)' });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('cruza_arriba');
    expect(errors[0]!.start).toBe(0);
    expect(errors[0]!.end).toBe('cruza_arriba'.length);
  });

  it.each(fields)('campo vacío: %s (%s)', (field) => {
    for (const text of ['', '   ']) {
      const over: Partial<StrategyRules> = {};
      over[field] = text;
      const errors = parseErrors(over);
      const error = errors.find((e) => e.field === field);
      expect(error).toBeDefined();
      expect(error!.start).toBe(0);
      expect(error!.end).toBe(0);
    }
  });

  it('texto libre antiguo da error con posición', () => {
    const errors = parseErrors({
      entry: 'Compra cuando SMA(rapida) cruza al alza a SMA(lenta)',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('entry');
    expect(errors[0]!.message).toContain('Compra');
    expect(errors[0]!.start).toBe(0);
    expect(errors[0]!.end).toBeGreaterThan(0);
  });

  it('los errores de varios campos llegan juntos, cada uno con su posición', () => {
    const errors = parseErrors({ entry: 'foo', stop: 'todo' });
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.field).sort()).toEqual(['entry', 'stop']);
    for (const error of errors) {
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.end).toBeGreaterThanOrEqual(error.start);
    }
  });

  it('una regla numérica no es una condición', () => {
    const errors = parseErrors({ entry: 'cierre + 1' });
    expect(errors[0]!.message).toMatch(/condición/);
  });

  it('una condición no cabe en stop ni en objetivo', () => {
    const errors = parseErrors({ stop: 'cierre > 100', target: 'cruza_arriba(sma(3), sma(8))' });
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error.message).toMatch(/N%|atr|ninguno/);
    }
  });

  it('rechaza niveles mal formados', () => {
    for (const stop of ['todo', '5 % + 1', 'cierre * atr(14)', '2 * sma(3)']) {
      const errors = parseErrors({ stop });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.field).toBe('stop');
    }
    for (const stop of ['150%', '0%', '-5%']) {
      const errors = parseErrors({ stop });
      expect(errors[0]!.message).toMatch(/porcentaje/);
    }
    const errors = parseErrors({ stop: '0 * atr(14)' });
    expect(errors[0]!.message).toMatch(/multiplicador/);
  });

  it('rechaza comparaciones encadenadas y operadores sueltos', () => {
    const errors = parseErrors({ entry: 'cierre > 3 > 2' });
    expect(errors[0]!.field).toBe('entry');
    expect(errors[0]!.message).toMatch(/>|sobra|esperaba/);
  });
});

describe('límites', () => {
  it('rechaza un campo de más de 500 caracteres sin colgarse', () => {
    const errors = parseErrors({ entry: 'cierre > '.padEnd(5_000, '1') });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('entry');
    expect(errors[0]!.message).toContain(`${RULES_FIELD_MAX_LENGTH}`);
    expect(errors[0]!.end).toBe(5_000);
  });

  it('rechaza una anidación de 100 niveles sin colgarse', () => {
    const errors = parseErrors({ entry: `${'('.repeat(100)}cierre > 3` });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/anidada|niveles/);
  });

  it('rechaza una cadena de «no» más larga que el tope de profundidad', () => {
    const errors = parseErrors({ entry: `${'no '.repeat(RULES_MAX_DEPTH + 10)}cierre > 3` });
    expect(errors[0]!.message).toMatch(/anidada|niveles/);
  });
});

describe('seguridad del módulo', () => {
  it('el analizador y la estrategia compilada no ejecutan código', () => {
    // El lenguaje se analiza, nunca se evalúa como código: la prueba lee
    // el fuente y busca las puertas de ejecución dinámica.
    const files = [
      new URL('./strategyRules.ts', import.meta.url),
      new URL('../main/backtest/strategies/custom.ts', import.meta.url),
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\beval\s*\(/);
      expect(source).not.toMatch(/\bFunction\s*\(/);
      expect(source).not.toMatch(/\bimport\s*\(/);
    }
  });
});

describe('metadatos para el editor', () => {
  it('exporta los indicadores documentados', () => {
    expect(INDICADORES.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        'sma',
        'ema',
        'rsi',
        'atr',
        'maximo',
        'minimo',
        'cruza_arriba',
        'cruza_abajo',
      ]),
    );
    for (const doc of INDICADORES) {
      expect(doc.signature.length).toBeGreaterThan(0);
      expect(doc.summary.length).toBeGreaterThan(0);
    }
  });

  it('exporta las palabras clave del lenguaje', () => {
    expect(PALABRAS_CLAVE).toEqual(
      expect.arrayContaining([
        'cierre',
        'apertura',
        'maximo',
        'minimo',
        'volumen',
        'sma',
        'ema',
        'rsi',
        'atr',
        'cruza_arriba',
        'cruza_abajo',
        'y',
        'o',
        'no',
        'ninguno',
      ]),
    );
  });
});
