/**
 * Lenguaje de reglas seguro para las estrategias propias — misión «reglas».
 *
 * Las reglas de una ficha propia (`StrategyRules`: entry, exit, stop,
 * target) se escriben en un lenguaje pequeño en español que este módulo
 * **analiza, nunca ejecuta como código**: no hay `eval`, `Function` ni
 * import dinámico en ninguna parte. El resultado es un `StrategyProgram`
 * —un AST de datos puros, serializable— que el motor de backtest convierte
 * en una `Strategy` ejecutable con
 * `src/main/backtest/strategies/custom.ts` (`createCustomStrategy`).
 *
 * Gramática de `entry` y `exit` (expresiones booleanas):
 * - Comparaciones `>`, `<`, `>=`, `<=`, `=` entre expresiones numéricas.
 * - Lógica `y`, `o`, `no` (prioridad: `no` > `y` > `o`) y paréntesis.
 * - Aritmética `+`, `-`, `*`, `/` con paréntesis y signo unario.
 * - Números con punto o coma decimal (`12.5` y `12,5` valen lo mismo).
 * - Campos de la vela actual: `cierre`, `apertura`, `maximo`, `minimo`,
 *   `volumen`.
 * - Indicadores de las últimas n velas **incluida la actual**:
 *   `sma(n)`, `ema(n)`, `rsi(n)`, `atr(n)`. Y de las n velas **anteriores,
 *   sin la actual**: `maximo(n)` y `minimo(n)` —el canal de la propia vela
 *   no se cuenta, igual que en la ruptura Donchian clásica—.
 * - Cruces estrictos: `cruza_arriba(a, b)` (a <= b en la vela anterior y
 *   a > b en esta) y `cruza_abajo(a, b)` (a >= b antes y a < b ahora).
 * - Nombres de los parámetros de la ficha.
 *
 * Gramática de `stop` y `target`:
 * - `ninguno`: sin stop / sin objetivo.
 * - `N%`: porcentaje sobre el cierre de la señal (`5%`, `riesgo%`).
 * - `K * atr(n)`: múltiplo del ATR(`2 * atr(14)`, `stopAtr * atr(atrPeriod)`).
 *   K puede ser cualquier producto de números y parámetros.
 *
 * Límites de seguridad: cada campo admite 500 caracteres y 32 niveles de
 * anidación; los periodos son enteros de 1 a 500 o nombres de parámetro.
 *
 * Las palabras del lenguaje no distinguen mayúsculas ni acentos
 * (`SMA(20)`, `máximo(20)` funcionan). Los nombres de parámetro se
 * reconocen igual, pero las palabras del lenguaje ganan: un parámetro
 * llamado `cierre` o `sma` no se puede referenciar.
 */
import type { StrategyRules } from './strategy';

/** Tope de caracteres por campo de regla. */
export const RULES_FIELD_MAX_LENGTH = 500;
/** Tope de niveles de anidación (paréntesis, signos y «no» encadenados). */
export const RULES_MAX_DEPTH = 32;
export const RULES_MIN_PERIOD = 1;
export const RULES_MAX_PERIOD = 500;

/** Campos de la ficha que llevan regla. */
export type RulesFieldName = keyof StrategyRules;

/** Error de análisis con su posición en el campo (índices en base 0). */
export interface StrategyRulesError {
  field: RulesFieldName;
  message: string;
  start: number;
  end: number;
}

/** Campos de precio utilizables en las expresiones. */
export const CAMPOS_PRECIO = ['cierre', 'apertura', 'maximo', 'minimo', 'volumen'] as const;
export type CampoPrecio = (typeof CAMPOS_PRECIO)[number];

/** Indicadores con argumento de periodo (`maximo`/`minimo` son de canal: sin la vela actual). */
export const INDICATOR_NAMES = ['sma', 'ema', 'rsi', 'atr', 'maximo', 'minimo'] as const;
export type IndicatorName = (typeof INDICATOR_NAMES)[number];

/** Documentación de cada indicador y función, para la ayuda del editor. */
export interface IndicatorDoc {
  /** Nombre tal como se escribe en la regla. */
  name: string;
  /** Firma de ejemplo para la interfaz. */
  signature: string;
  /** Descripción corta en español. */
  summary: string;
}

export const INDICADORES: readonly IndicatorDoc[] = [
  { name: 'sma', signature: 'sma(n)', summary: 'media simple del cierre de las últimas n velas' },
  {
    name: 'ema',
    signature: 'ema(n)',
    summary: 'media exponencial del cierre de las últimas n velas',
  },
  { name: 'rsi', signature: 'rsi(n)', summary: 'fuerza relativa de las últimas n velas (Wilder)' },
  {
    name: 'atr',
    signature: 'atr(n)',
    summary: 'rango verdadero medio de las últimas n velas (Wilder)',
  },
  {
    name: 'maximo',
    signature: 'maximo(n)',
    summary: 'máximo de las n velas anteriores, sin contar la actual',
  },
  {
    name: 'minimo',
    signature: 'minimo(n)',
    summary: 'mínimo de las n velas anteriores, sin contar la actual',
  },
  {
    name: 'cruza_arriba',
    signature: 'cruza_arriba(a, b)',
    summary: 'a estaba por debajo o igual que b y ahora la supera',
  },
  {
    name: 'cruza_abajo',
    signature: 'cruza_abajo(a, b)',
    summary: 'a estaba por encima o igual que b y ahora queda por debajo',
  },
];

/** Todas las palabras del lenguaje, para autocompletado del editor. */
export const PALABRAS_CLAVE: readonly string[] = [
  ...CAMPOS_PRECIO,
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
];

// ---------------------------------------------------------------------------
// Programa compilado (datos puros, serializables)
// ---------------------------------------------------------------------------

/** Argumento de periodo: literal entero o nombre de parámetro de la ficha. */
export type RulesPeriod = { kind: 'const'; value: number } | { kind: 'param'; name: string };

/** Expresión numérica tipada. */
export type RulesNumExpr =
  | { kind: 'num'; value: number }
  | { kind: 'field'; field: CampoPrecio }
  | { kind: 'param'; name: string }
  | { kind: 'indicator'; indicator: IndicatorName; period: RulesPeriod }
  | { kind: 'neg'; expr: RulesNumExpr }
  | { kind: 'arith'; op: '+' | '-' | '*' | '/'; left: RulesNumExpr; right: RulesNumExpr };

export type RulesCmpOp = '>' | '<' | '>=' | '<=' | '=';

/** Expresión booleana tipada. */
export type RulesBoolExpr =
  | { kind: 'cmp'; op: RulesCmpOp; left: RulesNumExpr; right: RulesNumExpr }
  | { kind: 'cross'; direction: 'up' | 'down'; left: RulesNumExpr; right: RulesNumExpr }
  | { kind: 'logic'; op: 'y' | 'o'; left: RulesBoolExpr; right: RulesBoolExpr }
  | { kind: 'not'; expr: RulesBoolExpr };

/** Nivel de stop u objetivo declarado en la regla. */
export type RulesLevel =
  | { kind: 'none' }
  | { kind: 'pct'; percent: RulesNumExpr }
  | { kind: 'atr'; mult: RulesNumExpr; period: RulesPeriod };

/** Programa compilado: lo que `createCustomStrategy` sabe ejecutar. */
export interface StrategyProgram {
  entry: RulesBoolExpr;
  exit: RulesBoolExpr;
  stop: RulesLevel;
  target: RulesLevel;
  /** Parámetros de la ficha que usan las reglas (ordenados, sin duplicados). */
  parameters: string[];
}

export type ParseStrategyRulesResult =
  { ok: true; program: StrategyProgram } | { ok: false; errors: StrategyRulesError[] };

// ---------------------------------------------------------------------------
// Analizador
// ---------------------------------------------------------------------------

class RulesParseError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = 'RulesParseError';
  }
}

const FIELD_LABEL: Record<RulesFieldName, string> = {
  entry: 'entrada',
  exit: 'salida',
  stop: 'stop',
  target: 'objetivo',
};

const CMP_OPS = new Set(['>', '<', '>=', '<=', '=']);
const ARITH_OPS = new Set(['+', '-', '*', '/']);
const CROSS_NAMES = new Set(['cruza_arriba', 'cruza_abajo']);
const FUNCTION_NAMES = new Set<string>([...INDICATOR_NAMES, ...CROSS_NAMES]);
const FIELD_NAMES = new Set<string>(CAMPOS_PRECIO);

/** Minúsculas sin acentos: las palabras del lenguaje no las distinguen. */
function normalizeName(raw: string): string {
  return raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

interface Token {
  kind: 'num' | 'ident' | 'punct' | 'eof';
  text: string;
  /** Valor numérico cuando kind === 'num'. */
  num: number | null;
  start: number;
  end: number;
}

const TWO_CHAR_OPS = ['>=', '<='];
const ONE_CHAR_OPS = '(),+-*/><=%';

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return /\p{L}/u.test(ch) || ch === '_';
}

function isIdentChar(ch: string): boolean {
  return /\p{L}/u.test(ch) || /\p{N}/u.test(ch) || ch === '_';
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(ch)) {
      // La coma decimal pega a los dígitos: «12,5» es un número; «12, 5» son
      // un número y un separador de argumentos.
      const match = /^\d+([.,]\d+)?/.exec(source.slice(i))!;
      const text = match[0];
      i += text.length;
      tokens.push({
        kind: 'num',
        text,
        num: Number(text.replace(',', '.')),
        start,
        end: i,
      });
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < source.length && isIdentChar(source[j]!)) {
        j++;
      }
      const text = source.slice(i, j);
      i = j;
      tokens.push({ kind: 'ident', text, num: null, start, end: i });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ kind: 'punct', text: two, num: null, start, end: i + 2 });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch, num: null, start, end: i + 1 });
      i++;
      continue;
    }
    throw new RulesParseError(`carácter no válido «${ch}»`, start, start + 1);
  }
  tokens.push({ kind: 'eof', text: '', num: null, start: source.length, end: source.length });
  return tokens;
}

/** AST sin tipar (los paréntesis no dejan nodo: solo agrupan). */
type PExpr =
  | { t: 'num'; value: number; s: number; e: number }
  | { t: 'name'; name: string; s: number; e: number }
  | { t: 'ind'; name: IndicatorName; period: RulesPeriod; s: number; e: number }
  | { t: 'cross'; dir: 'up' | 'down'; left: PExpr; right: PExpr; s: number; e: number }
  | { t: 'un'; op: '-' | '+' | 'no'; x: PExpr; s: number; e: number }
  | { t: 'bin'; op: string; l: PExpr; r: PExpr; s: number; e: number };

interface ParseContext {
  tokens: Token[];
  pos: number;
  parameters: Record<string, number>;
  /** Nombre normalizado → nombre real del parámetro en la ficha. */
  paramByNorm: Map<string, string>;
}

function buildContext(source: string, parameters: Record<string, number>): ParseContext {
  const paramByNorm = new Map<string, string>();
  for (const name of Object.keys(parameters)) {
    const norm = normalizeName(name);
    if (!paramByNorm.has(norm)) {
      paramByNorm.set(norm, name);
    }
  }
  return { tokens: tokenize(source), pos: 0, parameters, paramByNorm };
}

function peek(ctx: ParseContext): Token {
  return ctx.tokens[ctx.pos]!;
}

function next(ctx: ParseContext): Token {
  return ctx.tokens[ctx.pos++]!;
}

function fail(message: string, start: number, end: number): never {
  throw new RulesParseError(message, start, end);
}

/** Nombre real del parámetro, o null si no existe (exacto o normalizado). */
function resolveParam(ctx: ParseContext, raw: string): string | null {
  if (Object.hasOwn(ctx.parameters, raw)) return raw;
  return ctx.paramByNorm.get(normalizeName(raw)) ?? null;
}

function isKeyword(ctx: ParseContext, word: string): boolean {
  const tok = peek(ctx);
  return tok.kind === 'ident' && normalizeName(tok.text) === word;
}

function describeToken(tok: Token): string {
  return tok.kind === 'eof' ? 'el final de la regla' : `«${tok.text}»`;
}

function expectClose(
  ctx: ParseContext,
  label: string | null,
  labelStart: number,
  labelEnd: number,
): void {
  const tok = peek(ctx);
  if (tok.kind === 'punct' && tok.text === ')') {
    next(ctx);
    return;
  }
  if (tok.kind === 'eof') {
    fail(
      label === null ? 'falta «)» para cerrar el grupo' : `falta «)» para cerrar «${label}»`,
      labelStart,
      labelEnd,
    );
  }
  fail('se esperaba «)»', tok.start, tok.end);
}

function expectEof(ctx: ParseContext): void {
  const tok = peek(ctx);
  if (tok.kind !== 'eof') {
    fail(`sobra texto a partir de aquí: ${describeToken(tok)}`, tok.start, tok.end);
  }
}

// — Expresiones (precedencia: o < y < no < comparación < + - < * / < unario < átomo)

function parseOr(ctx: ParseContext, depth: number): PExpr {
  let left = parseAnd(ctx, depth);
  while (isKeyword(ctx, 'o')) {
    next(ctx);
    const right = parseAnd(ctx, depth);
    left = { t: 'bin', op: 'o', l: left, r: right, s: left.s, e: right.e };
  }
  return left;
}

function parseAnd(ctx: ParseContext, depth: number): PExpr {
  let left = parseNot(ctx, depth);
  while (isKeyword(ctx, 'y')) {
    next(ctx);
    const right = parseNot(ctx, depth);
    left = { t: 'bin', op: 'y', l: left, r: right, s: left.s, e: right.e };
  }
  return left;
}

function parseNot(ctx: ParseContext, depth: number): PExpr {
  if (isKeyword(ctx, 'no')) {
    const tok = next(ctx);
    checkDepth(depth + 1, tok);
    const x = parseNot(ctx, depth + 1);
    return { t: 'un', op: 'no', x, s: tok.start, e: x.e };
  }
  return parseCmp(ctx, depth);
}

function parseCmp(ctx: ParseContext, depth: number): PExpr {
  const left = parseAdd(ctx, depth);
  const tok = peek(ctx);
  if (tok.kind === 'punct' && CMP_OPS.has(tok.text)) {
    next(ctx);
    const right = parseAdd(ctx, depth);
    return { t: 'bin', op: tok.text, l: left, r: right, s: left.s, e: right.e };
  }
  return left;
}

function parseAdd(ctx: ParseContext, depth: number): PExpr {
  let left = parseMul(ctx, depth);
  for (;;) {
    const tok = peek(ctx);
    if (tok.kind === 'punct' && (tok.text === '+' || tok.text === '-')) {
      next(ctx);
      const right = parseMul(ctx, depth);
      left = { t: 'bin', op: tok.text, l: left, r: right, s: left.s, e: right.e };
      continue;
    }
    return left;
  }
}

function parseMul(ctx: ParseContext, depth: number): PExpr {
  let left = parseUnary(ctx, depth);
  for (;;) {
    const tok = peek(ctx);
    if (tok.kind === 'punct' && (tok.text === '*' || tok.text === '/')) {
      next(ctx);
      const right = parseUnary(ctx, depth);
      left = { t: 'bin', op: tok.text, l: left, r: right, s: left.s, e: right.e };
      continue;
    }
    return left;
  }
}

function parseUnary(ctx: ParseContext, depth: number): PExpr {
  const tok = peek(ctx);
  if (tok.kind === 'punct' && (tok.text === '-' || tok.text === '+')) {
    next(ctx);
    checkDepth(depth + 1, tok);
    const x = parseUnary(ctx, depth + 1);
    return { t: 'un', op: tok.text as '-' | '+', x, s: tok.start, e: x.e };
  }
  return parseAtom(ctx, depth);
}

function checkDepth(depth: number, tok: Token): void {
  if (depth > RULES_MAX_DEPTH) {
    fail(`expresión demasiado anidada (máximo ${RULES_MAX_DEPTH} niveles)`, tok.start, tok.end);
  }
}

function parseAtom(ctx: ParseContext, depth: number): PExpr {
  const tok = peek(ctx);
  if (tok.kind === 'num') {
    next(ctx);
    return { t: 'num', value: tok.num!, s: tok.start, e: tok.end };
  }
  if (tok.kind === 'punct' && tok.text === '(') {
    const open = next(ctx);
    checkDepth(depth + 1, open);
    const inner = parseOr(ctx, depth + 1);
    expectClose(ctx, null, open.start, open.end);
    return inner;
  }
  if (tok.kind === 'ident') {
    const name = next(ctx);
    const after = peek(ctx);
    if (after.kind === 'punct' && after.text === '(') {
      return parseCall(ctx, name, depth);
    }
    return { t: 'name', name: name.text, s: name.start, e: name.end };
  }
  fail(
    `se esperaba un número, un campo, un indicador, «no» o «(» y llegó ${describeToken(tok)}`,
    tok.start,
    tok.end,
  );
}

function parseCall(ctx: ParseContext, nameTok: Token, depth: number): PExpr {
  const name = normalizeName(nameTok.text);
  next(ctx); // '('
  checkDepth(depth + 1, nameTok);

  if (CROSS_NAMES.has(name)) {
    const left = parseOr(ctx, depth + 1);
    const sep = peek(ctx);
    if (!(sep.kind === 'punct' && sep.text === ',')) {
      fail(`«${name}» espera dos expresiones separadas por una coma`, sep.start, sep.end);
    }
    next(ctx);
    const right = parseOr(ctx, depth + 1);
    const close = peek(ctx);
    expectClose(ctx, name, nameTok.start, nameTok.end);
    return {
      t: 'cross',
      dir: name === 'cruza_arriba' ? 'up' : 'down',
      left,
      right,
      s: nameTok.start,
      e: close.end,
    };
  }

  if ((INDICATOR_NAMES as readonly string[]).includes(name)) {
    const arg = peek(ctx);
    let period: RulesPeriod;
    if (arg.kind === 'num') {
      next(ctx);
      if (!Number.isInteger(arg.num!)) {
        fail(`el periodo de «${name}» debe ser un entero (${arg.text})`, arg.start, arg.end);
      }
      if (arg.num! < RULES_MIN_PERIOD || arg.num! > RULES_MAX_PERIOD) {
        fail(
          `el periodo ${arg.text} de «${name}» está fuera de rango: debe ser un entero de ${RULES_MIN_PERIOD} a ${RULES_MAX_PERIOD}`,
          arg.start,
          arg.end,
        );
      }
      period = { kind: 'const', value: arg.num! };
    } else if (arg.kind === 'ident' && !RESERVED.has(normalizeName(arg.text))) {
      next(ctx);
      const pname = resolveParam(ctx, arg.text);
      if (pname === null) {
        fail(
          `«${arg.text}» no es un campo, un indicador ni un parámetro de la ficha`,
          arg.start,
          arg.end,
        );
      }
      const value = ctx.parameters[pname]!;
      if (!Number.isInteger(value) || value < RULES_MIN_PERIOD || value > RULES_MAX_PERIOD) {
        fail(
          `el parámetro «${pname}» (${value}) no es un periodo válido para «${name}»: debe ser un entero de ${RULES_MIN_PERIOD} a ${RULES_MAX_PERIOD}`,
          arg.start,
          arg.end,
        );
      }
      period = { kind: 'param', name: pname };
    } else {
      fail(
        `«${name}» espera un periodo: un entero de ${RULES_MIN_PERIOD} a ${RULES_MAX_PERIOD} o un parámetro`,
        arg.start,
        arg.end,
      );
    }
    const after = peek(ctx);
    if (after.kind === 'punct' && after.text === ',') {
      fail(`«${name}» espera un solo argumento: el periodo`, after.start, after.end);
    }
    const close = peek(ctx);
    expectClose(ctx, name, nameTok.start, nameTok.end);
    return { t: 'ind', name: name as IndicatorName, period, s: nameTok.start, e: close.end };
  }

  if (resolveParam(ctx, nameTok.text) !== null) {
    fail(
      `«${nameTok.text}» es un parámetro de la ficha, no una función`,
      nameTok.start,
      nameTok.end,
    );
  }
  if (FIELD_NAMES.has(name)) {
    fail(`«${nameTok.text}» es un campo, no una función`, nameTok.start, nameTok.end);
  }
  fail(
    `«${nameTok.text}» no es una función del lenguaje ni un parámetro de la ficha`,
    nameTok.start,
    nameTok.end,
  );
}

const RESERVED = new Set<string>(['y', 'o', 'no', 'ninguno', ...FUNCTION_NAMES, ...CAMPOS_PRECIO]);

// — Tipado: del AST crudo a expresiones numéricas/booleanas -----------------

function resolveName(ctx: ParseContext, x: Extract<PExpr, { t: 'name' }>): RulesNumExpr {
  const norm = normalizeName(x.name);
  if (FIELD_NAMES.has(norm)) {
    return { kind: 'field', field: norm as CampoPrecio };
  }
  if (norm === 'y' || norm === 'o' || norm === 'no') {
    fail(`«${x.name}» es un operador de condiciones: no puede aparecer aquí`, x.s, x.e);
  }
  if (norm === 'ninguno') {
    fail('«ninguno» solo se puede usar en el stop o en el objetivo', x.s, x.e);
  }
  if (FUNCTION_NAMES.has(norm)) {
    fail(`«${x.name}» es una función: úsala con paréntesis, por ejemplo «${norm}(20)»`, x.s, x.e);
  }
  const pname = resolveParam(ctx, x.name);
  if (pname !== null) {
    return { kind: 'param', name: pname };
  }
  fail(`«${x.name}» no es un campo, un indicador ni un parámetro de la ficha`, x.s, x.e);
}

function toNum(ctx: ParseContext, x: PExpr): RulesNumExpr {
  switch (x.t) {
    case 'num':
      return { kind: 'num', value: x.value };
    case 'name':
      return resolveName(ctx, x);
    case 'ind':
      return { kind: 'indicator', indicator: x.name, period: x.period };
    case 'cross':
      fail(
        'un cruce es una condición (verdadero/falso): no puede ir dentro de una operación ni de una comparación',
        x.s,
        x.e,
      );
      break;
    case 'un':
      if (x.op === 'no') {
        fail('«no» solo se aplica a una condición, no a un número', x.s, x.e);
      }
      if (x.op === '-') {
        return { kind: 'neg', expr: toNum(ctx, x.x) };
      }
      return toNum(ctx, x.x);
    case 'bin':
      if (ARITH_OPS.has(x.op)) {
        return {
          kind: 'arith',
          op: x.op as '+' | '-' | '*' | '/',
          left: toNum(ctx, x.l),
          right: toNum(ctx, x.r),
        };
      }
      if (x.op === 'y' || x.op === 'o') {
        fail(
          `«${x.op}» une condiciones: no puede ir dentro de una operación con números`,
          x.s,
          x.e,
        );
      }
      fail(
        `la comparación «${x.op}» produce verdadero o falso: no puede ir dentro de una operación`,
        x.s,
        x.e,
      );
  }
}

function toBool(ctx: ParseContext, x: PExpr): RulesBoolExpr {
  switch (x.t) {
    case 'bin':
      if (x.op === 'y' || x.op === 'o') {
        return { kind: 'logic', op: x.op, left: toBool(ctx, x.l), right: toBool(ctx, x.r) };
      }
      if (CMP_OPS.has(x.op)) {
        return {
          kind: 'cmp',
          op: x.op as RulesCmpOp,
          left: toNum(ctx, x.l),
          right: toNum(ctx, x.r),
        };
      }
      break;
    case 'un':
      if (x.op === 'no') {
        return { kind: 'not', expr: toBool(ctx, x.x) };
      }
      break;
    case 'cross':
      return {
        kind: 'cross',
        direction: x.dir,
        left: toNum(ctx, x.left),
        right: toNum(ctx, x.right),
      };
  }
  // Cualquier otra cosa (número, campo, parámetro, indicador) se resuelve
  // primero para dar el error correcto si el nombre no existe.
  toNum(ctx, x);
  fail(
    'esto es un número, pero la regla debe ser una condición: compara con «>», «<», «>=», «<=» o «=», o usa «cruza_arriba»/«cruza_abajo»',
    x.s,
    x.e,
  );
}

// — Nivel (stop / target): «ninguno» | «N%» | «K * atr(n)» -------------------

/** Solo números, parámetros y aritmética: nada de campos ni indicadores. */
function toScalar(ctx: ParseContext, x: PExpr): RulesNumExpr {
  switch (x.t) {
    case 'num':
      return { kind: 'num', value: x.value };
    case 'name': {
      const norm = normalizeName(x.name);
      if (FIELD_NAMES.has(norm)) {
        fail(`«${x.name}» es un campo: aquí solo se admiten números y parámetros`, x.s, x.e);
      }
      if (FUNCTION_NAMES.has(norm)) {
        fail(`«${x.name}» es una función: aquí solo se admiten números y parámetros`, x.s, x.e);
      }
      if (norm === 'ninguno') {
        fail('«ninguno» se escribe solo, sin operaciones', x.s, x.e);
      }
      const pname = resolveParam(ctx, x.name);
      if (pname === null) {
        fail(`«${x.name}» no es un campo, un indicador ni un parámetro de la ficha`, x.s, x.e);
      }
      return { kind: 'param', name: pname };
    }
    case 'un':
      if (x.op === '-') {
        return { kind: 'neg', expr: toScalar(ctx, x.x) };
      }
      if (x.op === '+') {
        return toScalar(ctx, x.x);
      }
      break;
    case 'bin':
      if (ARITH_OPS.has(x.op)) {
        return {
          kind: 'arith',
          op: x.op as '+' | '-' | '*' | '/',
          left: toScalar(ctx, x.l),
          right: toScalar(ctx, x.r),
        };
      }
      break;
  }
  fail('aquí solo se admiten números y parámetros', x.s, x.e);
}

/** Evalúa un escalar (num/param/aritmética) con los parámetros de la ficha. */
function evalScalar(expr: RulesNumExpr, parameters: Record<string, number>): number | null {
  switch (expr.kind) {
    case 'num':
      return expr.value;
    case 'param': {
      const value = parameters[expr.name];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    case 'neg': {
      const value = evalScalar(expr.expr, parameters);
      return value === null ? null : -value;
    }
    case 'arith': {
      const l = evalScalar(expr.left, parameters);
      const r = evalScalar(expr.right, parameters);
      if (l === null || r === null) return null;
      const value =
        expr.op === '+' ? l + r : expr.op === '-' ? l - r : expr.op === '*' ? l * r : l / r;
      return Number.isFinite(value) ? value : null;
    }
    default:
      return null;
  }
}

/** true si la expresión numérica solo usa números, parámetros y aritmética. */
function isScalarExpr(expr: RulesNumExpr): boolean {
  switch (expr.kind) {
    case 'num':
    case 'param':
      return true;
    case 'neg':
      return isScalarExpr(expr.expr);
    case 'arith':
      return isScalarExpr(expr.left) && isScalarExpr(expr.right);
    default:
      return false;
  }
}

/** Descompone una cadena de multiplicaciones en sus factores. */
function flattenProduct(expr: RulesNumExpr, out: RulesNumExpr[]): void {
  if (expr.kind === 'arith' && expr.op === '*') {
    flattenProduct(expr.left, out);
    flattenProduct(expr.right, out);
    return;
  }
  out.push(expr);
}

function parseLevel(ctx: ParseContext, field: 'stop' | 'target'): RulesLevel {
  const label = FIELD_LABEL[field];
  const tok = peek(ctx);
  if (tok.kind === 'ident' && normalizeName(tok.text) === 'ninguno') {
    next(ctx);
    expectEof(ctx);
    return { kind: 'none' };
  }

  const expr = parseOr(ctx, 0);
  const after = peek(ctx);
  if (after.kind === 'punct' && after.text === '%') {
    next(ctx);
    expectEof(ctx);
    const percent = toScalar(ctx, expr);
    const value = evalScalar(percent, ctx.parameters);
    if (value === null) {
      fail(`el porcentaje del ${label} no se puede calcular`, expr.s, expr.e);
    }
    if (field === 'stop' ? !(value > 0 && value < 100) : !(value > 0)) {
      fail(
        field === 'stop'
          ? `el porcentaje del stop debe estar entre 0 y 100, sin llegar a ellos (${value})`
          : `el porcentaje del objetivo debe ser mayor que 0 (${value})`,
        expr.s,
        expr.e,
      );
    }
    return { kind: 'pct', percent };
  }

  expectEof(ctx);
  if (
    expr.t === 'cross' ||
    (expr.t === 'un' && expr.op === 'no') ||
    (expr.t === 'bin' && (CMP_OPS.has(expr.op) || expr.op === 'y' || expr.op === 'o'))
  ) {
    fail(`el ${label} debe ser «N%», «K * atr(n)» o «ninguno», no una condición`, expr.s, expr.e);
  }
  const num = toNum(ctx, expr);
  const factors: RulesNumExpr[] = [];
  flattenProduct(num, factors);
  const atrFactors = factors.filter((f) => f.kind === 'indicator' && f.indicator === 'atr');
  const rest = factors.filter((f) => !(f.kind === 'indicator' && f.indicator === 'atr'));
  if (atrFactors.length !== 1 || !rest.every(isScalarExpr)) {
    fail(`el ${label} debe ser «N%», «K * atr(n)» o «ninguno»`, expr.s, expr.e);
  }
  const atr = atrFactors[0] as Extract<RulesNumExpr, { kind: 'indicator' }>;
  const mult: RulesNumExpr =
    rest.length === 0
      ? { kind: 'num', value: 1 }
      : rest
          .slice(1)
          .reduce<RulesNumExpr>(
            (acc, f) => ({ kind: 'arith', op: '*', left: acc, right: f }),
            rest[0]!,
          );
  const multValue = evalScalar(mult, ctx.parameters);
  if (multValue === null) {
    fail(`el multiplicador del ${label} no se puede calcular`, expr.s, expr.e);
  }
  if (multValue <= 0) {
    fail(
      `el multiplicador de atr del ${label} debe ser mayor que 0 (${multValue})`,
      expr.s,
      expr.e,
    );
  }
  return { kind: 'atr', mult, period: atr.period };
}

// — Punto de entrada ---------------------------------------------------------

function parseField(
  field: RulesFieldName,
  raw: unknown,
  parameters: Record<string, number>,
): RulesBoolExpr | RulesLevel {
  const source = typeof raw === 'string' ? raw : '';
  const label = FIELD_LABEL[field];
  if (source.trim().length === 0) {
    const hint =
      field === 'entry' || field === 'exit'
        ? `la regla de ${label} está vacía: escribe una condición (por ejemplo, «cierre > sma(20)»)`
        : `el campo de ${label} está vacío: escribe «ninguno», un porcentaje como «5%» o un múltiplo como «2 * atr(14)»`;
    fail(hint, 0, 0);
  }
  if (source.length > RULES_FIELD_MAX_LENGTH) {
    fail(
      `el campo supera el máximo de ${RULES_FIELD_MAX_LENGTH} caracteres`,
      RULES_FIELD_MAX_LENGTH,
      source.length,
    );
  }
  const ctx = buildContext(source, parameters);
  if (field === 'stop' || field === 'target') {
    return parseLevel(ctx, field);
  }
  const expr = parseOr(ctx, 0);
  // Primero el tipado: un nombre desconocido se señala en su posición en
  // vez de llegar como «sobra texto» a final de campo.
  const bool = toBool(ctx, expr);
  expectEof(ctx);
  return bool;
}

function collectParamsNum(expr: RulesNumExpr, out: Set<string>): void {
  switch (expr.kind) {
    case 'param':
      out.add(expr.name);
      return;
    case 'indicator':
      if (expr.period.kind === 'param') out.add(expr.period.name);
      return;
    case 'neg':
      collectParamsNum(expr.expr, out);
      return;
    case 'arith':
      collectParamsNum(expr.left, out);
      collectParamsNum(expr.right, out);
      return;
  }
}

function collectParamsBool(expr: RulesBoolExpr, out: Set<string>): void {
  switch (expr.kind) {
    case 'cmp':
    case 'cross':
      collectParamsNum(expr.left, out);
      collectParamsNum(expr.right, out);
      return;
    case 'logic':
      collectParamsBool(expr.left, out);
      collectParamsBool(expr.right, out);
      return;
    case 'not':
      collectParamsBool(expr.expr, out);
      return;
  }
}

/**
 * Analiza las cuatro reglas de una ficha propia y devuelve el programa
 * compilado o la lista de errores (uno por campo, el primero encontrado).
 *
 * Puro y determinista: no lee archivos ni variables de entorno, así que el
 * mismo resultado sirve al proceso principal y al renderer (validación en
 * vivo del editor).
 */
export function parseStrategyRules(
  rules: StrategyRules,
  parameters: Record<string, number>,
): ParseStrategyRulesResult {
  const params = parameters ?? {};
  const errors: StrategyRulesError[] = [];
  const parsed = {} as {
    entry?: RulesBoolExpr;
    exit?: RulesBoolExpr;
    stop?: RulesLevel;
    target?: RulesLevel;
  };
  for (const field of ['entry', 'exit', 'stop', 'target'] as const) {
    try {
      const result = parseField(field, rules[field], params);
      if (field === 'stop' || field === 'target') {
        parsed[field] = result as RulesLevel;
      } else {
        parsed[field] = result as RulesBoolExpr;
      }
    } catch (error) {
      if (error instanceof RulesParseError) {
        errors.push({ field, message: error.message, start: error.start, end: error.end });
        continue;
      }
      throw error;
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const used = new Set<string>();
  collectParamsBool(parsed.entry!, used);
  collectParamsBool(parsed.exit!, used);
  for (const level of [parsed.stop!, parsed.target!]) {
    if (level.kind === 'pct') {
      collectParamsNum(level.percent, used);
    } else if (level.kind === 'atr') {
      collectParamsNum(level.mult, used);
      if (level.period.kind === 'param') used.add(level.period.name);
    }
  }
  return {
    ok: true,
    program: {
      entry: parsed.entry!,
      exit: parsed.exit!,
      stop: parsed.stop!,
      target: parsed.target!,
      parameters: [...used].sort(),
    },
  };
}
