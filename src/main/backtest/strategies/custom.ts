/**
 * Estrategia propia: ejecuta un `StrategyProgram` compilado por
 * `parseStrategyRules` (`src/shared/strategyRules.ts`) — el lenguaje de
 * reglas en español de las estrategias que crea el usuario.
 *
 * El programa es un AST de datos: esta fábrica lo interpreta contra la
 * vista truncada de velas del motor. No hay ejecución de código en
 * ninguna parte; cada regla solo puede leer campos de la vela, indicadores
 * rodantes y los parámetros de la ficha.
 *
 * Modelo de ejecución (igual que las clásicas, y en corto al revés):
 * - Largo y corto: la señal se evalúa al cierre y la orden llena en la
 *   apertura siguiente; la `BarWindow` garantiza que nunca se ve el
 *   futuro. Con `entryShort`/`exitShort` la ficha abre y cierra cortos
 *   (`ctx.short`/`ctx.cover`); sin ellas opera solo en largo.
 * - Los indicadores `sma`/`ema`/`rsi`/`atr` se calculan sobre las últimas
 *   n velas incluida la actual; `maximo(n)`/`minimo(n)` son los canales de
 *   las n velas anteriores, sin la actual (convención Donchian).
 * - `cruza_arriba`/`cruza_abajo` son cruces estrictos entre la vela
 *   anterior y la actual, como el cruce de medias clásico.
 * - Stop `K * atr(n)`: trailing — en largo se recalcula cada cierre como
 *   `cierre − K × ATR(n)` y solo puede subir; en corto como
 *   `cierre + K × ATR(n)` y solo puede bajar (el stop dinámico del cruce
 *   de medias clásico, espejado). Stop `N%`: fijo a un N % bajo el cierre
 *   de la señal en largo, sobre él en corto. `ninguno`: sin protección.
 * - Objetivo `N%` o `K * atr(n)`: fijo sobre el cierre de la señal en
 *   largo, por debajo en corto.
 * - Si un nivel declarado no se puede calcular (ATR aún sin valor,
 *   resultado no positivo) la entrada se descarta, igual que las clásicas
 *   esperan a su ATR antes de comprar.
 * - Nunca hay largo y corto a la vez ni cambio de lado: con posición
 *   abierta solo se evalúa su salida, y si las reglas de entrada de largo
 *   y de corto se cumplen en la misma vela no se entra.
 * - Un operando sin dato (indicador en calentamiento, volumen ausente)
 *   hace falsa la comparación y el cruce: nunca inventa valores.
 */
import {
  RULES_MAX_PERIOD,
  RULES_MIN_PERIOD,
  type IndicatorName,
  type RulesBoolExpr,
  type RulesLevel,
  type RulesNumExpr,
  type RulesPeriod,
  type StrategyProgram,
} from '../../../shared/strategyRules';
import type {
  BuyOptions,
  EngineBar,
  PositionSide,
  ShortOptions,
  Strategy,
  StrategyContext,
  StrategyParams,
} from '../types';
import { resolveParams } from './params';
import {
  RollingEma,
  RollingPriorMax,
  RollingPriorMin,
  RollingSma,
  WilderAtr,
  WilderRsi,
} from './rolling';

/** Indicador incremental alimentado una vez por vela revelada. */
interface Feed {
  update(bar: EngineBar): void;
  value(): number | null;
}

function makeFeed(name: IndicatorName, period: number): Feed {
  switch (name) {
    case 'sma': {
      const i = new RollingSma(period);
      return { update: (bar) => i.push(bar.close), value: () => i.value };
    }
    case 'ema': {
      const i = new RollingEma(period);
      return { update: (bar) => i.push(bar.close), value: () => i.value };
    }
    case 'rsi': {
      const i = new WilderRsi(period);
      return { update: (bar) => i.push(bar.close), value: () => i.value };
    }
    case 'atr': {
      const i = new WilderAtr(period);
      return { update: (bar) => i.push(bar), value: () => i.value };
    }
    case 'maximo': {
      const i = new RollingPriorMax(period);
      return { update: (bar) => i.push(bar.high), value: () => i.value };
    }
    case 'minimo': {
      const i = new RollingPriorMin(period);
      return { update: (bar) => i.push(bar.low), value: () => i.value };
    }
  }
}

/** Nivel ya resuelto con los parámetros de la corrida. */
type ResolvedLevel =
  { kind: 'none' } | { kind: 'pct'; value: number } | { kind: 'atr'; mult: number; period: number };

interface CrossOperand {
  left: number | null;
  right: number | null;
}

interface TickerState {
  seen: number;
  feeds: Map<string, Feed>;
  /** Estado de cada nodo `cross` del programa, en orden de recorrido. */
  cross: { prev: CrossOperand | null; cur: CrossOperand | null }[];
}

interface EvalEnv {
  bar: EngineBar;
  params: StrategyParams;
  feeds: Map<string, Feed>;
}

/** Centinela: el nivel está declarado pero no se puede calcular hoy. */
const INVALID_LEVEL = Symbol('nivel-invalido');
type LevelPrice = number | null | typeof INVALID_LEVEL;

function fieldValue(
  bar: EngineBar,
  field: 'cierre' | 'apertura' | 'maximo' | 'minimo' | 'volumen',
) {
  const value =
    field === 'apertura'
      ? bar.open
      : field === 'maximo'
        ? bar.high
        : field === 'minimo'
          ? bar.low
          : field === 'volumen'
            ? bar.volume
            : bar.close;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function walkNum(expr: RulesNumExpr, visit: (node: RulesNumExpr) => void): void {
  visit(expr);
  switch (expr.kind) {
    case 'neg':
      walkNum(expr.expr, visit);
      return;
    case 'arith':
      walkNum(expr.left, visit);
      walkNum(expr.right, visit);
      return;
  }
}

function walkBool(
  expr: RulesBoolExpr,
  visitBool: (node: RulesBoolExpr) => void,
  visitNum: (node: RulesNumExpr) => void,
): void {
  visitBool(expr);
  switch (expr.kind) {
    case 'cmp':
    case 'cross':
      walkNum(expr.left, visitNum);
      walkNum(expr.right, visitNum);
      return;
    case 'logic':
      walkBool(expr.left, visitBool, visitNum);
      walkBool(expr.right, visitBool, visitNum);
      return;
    case 'not':
      walkBool(expr.expr, visitBool, visitNum);
      return;
  }
}

/**
 * Crea la estrategia ejecutable de un programa de reglas ya analizado.
 * `parameters` son los de la ficha: `init` los fusiona con los de la
 * corrida (la sensibilidad los sobreescribe, como en las clásicas).
 */
export function createCustomStrategy(
  program: StrategyProgram,
  parameters: Record<string, number>,
): Strategy {
  // Nodos cruzados e indicadores del programa, recolectados una vez: el
  // AST es inmutable entre corridas y cada `init` solo rehace el estado.
  const crossNodes: Extract<RulesBoolExpr, { kind: 'cross' }>[] = [];
  const periodRefs: { name: IndicatorName; period: RulesPeriod }[] = [];
  const crossIndex = new Map<RulesBoolExpr, number>();
  const visitBool = (node: RulesBoolExpr): void => {
    if (node.kind === 'cross' && !crossIndex.has(node)) {
      crossIndex.set(node, crossNodes.length);
      crossNodes.push(node);
    }
  };
  const visitNum = (node: RulesNumExpr): void => {
    if (node.kind === 'indicator') {
      periodRefs.push({ name: node.indicator, period: node.period });
    }
  };
  walkBool(program.entry, visitBool, visitNum);
  walkBool(program.exit, visitBool, visitNum);
  if (program.entryShort !== null) walkBool(program.entryShort, visitBool, visitNum);
  if (program.exitShort !== null) walkBool(program.exitShort, visitBool, visitNum);
  for (const level of [program.stop, program.target]) {
    if (level.kind === 'atr') {
      periodRefs.push({ name: 'atr', period: level.period });
      walkNum(level.mult, visitNum);
    } else if (level.kind === 'pct') {
      walkNum(level.percent, visitNum);
    }
  }

  let params: StrategyParams = { ...parameters };
  let feedSpecs: { key: string; name: IndicatorName; period: number }[] = [];
  let stopSpec: ResolvedLevel = { kind: 'none' };
  let targetSpec: ResolvedLevel = { kind: 'none' };
  let states = new Map<string, TickerState>();

  const feedKey = (name: IndicatorName, period: number): string => `${name}:${period}`;

  const resolvePeriod = (period: RulesPeriod): number | null => {
    const value = period.kind === 'const' ? period.value : params[period.name];
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    return value;
  };

  /** Evalúa un escalar (solo números/parámetros/aritmética) con los params vigentes. */
  const evalScalar = (expr: RulesNumExpr): number | null => {
    switch (expr.kind) {
      case 'num':
        return expr.value;
      case 'param': {
        const value = params[expr.name];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      }
      case 'neg': {
        const value = evalScalar(expr.expr);
        return value === null ? null : -value;
      }
      case 'arith': {
        const l = evalScalar(expr.left);
        const r = evalScalar(expr.right);
        if (l === null || r === null) return null;
        const value =
          expr.op === '+' ? l + r : expr.op === '-' ? l - r : expr.op === '*' ? l * r : l / r;
        return Number.isFinite(value) ? value : null;
      }
      default:
        return null;
    }
  };

  const resolveLevel = (level: RulesLevel, label: string): ResolvedLevel => {
    switch (level.kind) {
      case 'none':
        return { kind: 'none' };
      case 'pct': {
        const value = evalScalar(level.percent);
        if (value === null) {
          throw new RangeError(
            `estrategia propia: el porcentaje del ${label} no se puede calcular`,
          );
        }
        if (label === 'stop' ? !(value > 0 && value < 100) : !(value > 0)) {
          throw new RangeError(
            label === 'stop'
              ? `estrategia propia: el porcentaje del stop debe estar entre 0 y 100 (${value})`
              : `estrategia propia: el porcentaje del objetivo debe ser mayor que 0 (${value})`,
          );
        }
        return { kind: 'pct', value };
      }
      case 'atr': {
        const mult = evalScalar(level.mult);
        if (mult === null || mult <= 0) {
          throw new RangeError(
            `estrategia propia: el multiplicador de atr del ${label} debe ser > 0 (${String(mult)})`,
          );
        }
        const period = resolvePeriod(level.period);
        if (period === null || period < RULES_MIN_PERIOD || period > RULES_MAX_PERIOD) {
          throw new RangeError(
            `estrategia propia: el periodo del ${label} debe ser un entero de ${RULES_MIN_PERIOD} a ${RULES_MAX_PERIOD}`,
          );
        }
        return { kind: 'atr', mult, period };
      }
    }
  };

  const evalNum = (expr: RulesNumExpr, env: EvalEnv): number | null => {
    switch (expr.kind) {
      case 'num':
        return expr.value;
      case 'field':
        return fieldValue(env.bar, expr.field);
      case 'param': {
        const value = env.params[expr.name];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      }
      case 'indicator': {
        const period = resolvePeriod(expr.period);
        if (period === null) return null;
        return env.feeds.get(feedKey(expr.indicator, period))?.value() ?? null;
      }
      case 'neg': {
        const value = evalNum(expr.expr, env);
        return value === null ? null : -value;
      }
      case 'arith': {
        const l = evalNum(expr.left, env);
        const r = evalNum(expr.right, env);
        if (l === null || r === null) return null;
        const value =
          expr.op === '+' ? l + r : expr.op === '-' ? l - r : expr.op === '*' ? l * r : l / r;
        return Number.isFinite(value) ? value : null;
      }
    }
  };

  const evalBool = (expr: RulesBoolExpr, env: EvalEnv, st: TickerState): boolean => {
    switch (expr.kind) {
      case 'cmp': {
        const l = evalNum(expr.left, env);
        const r = evalNum(expr.right, env);
        if (l === null || r === null) return false;
        switch (expr.op) {
          case '>':
            return l > r;
          case '<':
            return l < r;
          case '>=':
            return l >= r;
          case '<=':
            return l <= r;
          case '=':
            return l === r;
        }
        return false;
      }
      case 'cross': {
        const s = st.cross[crossIndex.get(expr)!]!;
        const prev = s.prev;
        const cur = s.cur;
        if (prev === null || cur === null) return false;
        const { left: pl, right: pr } = prev;
        const { left: cl, right: cr } = cur;
        if (pl === null || pr === null || cl === null || cr === null) return false;
        return expr.direction === 'up' ? pl <= pr && cl > cr : pl >= pr && cl < cr;
      }
      case 'logic': {
        // Sin cortocircuito: el contrato evalúa siempre las dos ramas.
        const l = evalBool(expr.left, env, st);
        const r = evalBool(expr.right, env, st);
        return expr.op === 'y' ? l && r : l || r;
      }
      case 'not':
        return !evalBool(expr.expr, env, st);
    }
  };

  /**
   * Precio de un nivel con la regla aplicada al lado: en largo el stop va
   * bajo el cierre y el objetivo encima; en corto, al revés.
   */
  const levelPrice = (
    level: ResolvedLevel,
    env: EvalEnv,
    side: 'stop' | 'target',
    direction: PositionSide,
  ): LevelPrice => {
    // -1 el nivel queda bajo el cierre (stop en largo, objetivo en corto);
    // +1 por encima (objetivo en largo, stop en corto).
    const sign = (side === 'stop') === (direction === 'largo') ? -1 : 1;
    switch (level.kind) {
      case 'none':
        return null;
      case 'pct': {
        const price = env.bar.close * (1 + (sign * level.value) / 100);
        return Number.isFinite(price) ? price : INVALID_LEVEL;
      }
      case 'atr': {
        const atr = env.feeds.get(feedKey('atr', level.period))?.value() ?? null;
        if (atr === null) return INVALID_LEVEL;
        const price = env.bar.close + sign * level.mult * atr;
        return Number.isFinite(price) ? price : INVALID_LEVEL;
      }
    }
  };

  const evaluate = (
    ctx: StrategyContext,
    ticker: string,
    st: TickerState,
    bar: EngineBar,
  ): void => {
    const env: EvalEnv = { bar, params, feeds: st.feeds };
    const position = ctx.position(ticker);
    if (position === null) {
      const wantLong = evalBool(program.entry, env, st);
      const wantShort = program.entryShort !== null && evalBool(program.entryShort, env, st);
      // Las dos entradas cumplidas en la misma vela: no se entra.
      if (wantLong === wantShort) return;
      const direction: PositionSide = wantLong ? 'largo' : 'corto';
      const stop = levelPrice(stopSpec, env, 'stop', direction);
      const target = levelPrice(targetSpec, env, 'target', direction);
      if (stop === INVALID_LEVEL || target === INVALID_LEVEL) return;
      const options: BuyOptions | ShortOptions = {};
      if (stop !== null) {
        if (stop <= 0) return;
        options.stop = stop;
      }
      if (target !== null) {
        if (target <= 0) return;
        options.target = target;
      }
      if (wantLong) {
        ctx.buy(ticker, options);
      } else {
        ctx.short(ticker, options);
      }
      return;
    }
    if (position.side === 'largo') {
      if (evalBool(program.exit, env, st)) {
        ctx.sell(ticker);
        return;
      }
      // Stop ATR dinámico: solo sube, como el del cruce de medias clásico.
      if (stopSpec.kind === 'atr') {
        const atr = st.feeds.get(feedKey('atr', stopSpec.period))?.value() ?? null;
        if (atr !== null) {
          const trail = bar.close - stopSpec.mult * atr;
          if (trail > 0 && (position.stopPrice === null || trail > position.stopPrice)) {
            ctx.setStop(ticker, trail);
          }
        }
      }
      return;
    }
    // Posición en corto: solo se evalúa su salida (no hay cambio de lado).
    if (program.exitShort !== null && evalBool(program.exitShort, env, st)) {
      ctx.cover(ticker);
      return;
    }
    // Stop ATR dinámico del corto: solo baja, espejo del largo.
    if (stopSpec.kind === 'atr') {
      const atr = st.feeds.get(feedKey('atr', stopSpec.period))?.value() ?? null;
      if (atr !== null) {
        const trail = bar.close + stopSpec.mult * atr;
        if (trail > 0 && (position.stopPrice === null || trail < position.stopPrice)) {
          ctx.setStop(ticker, trail);
        }
      }
    }
  };

  return {
    init(raw: StrategyParams) {
      params = resolveParams(parameters, raw);
      // Los periodos se resuelven con los parámetros ya fusionados: un
      // parámetro-periodo inválido invalida toda la corrida, como en las
      // clásicas.
      const specs = new Map<string, { key: string; name: IndicatorName; period: number }>();
      for (const ref of periodRefs) {
        const value = resolvePeriod(ref.period);
        if (value === null || value < RULES_MIN_PERIOD || value > RULES_MAX_PERIOD) {
          const detail =
            ref.period.kind === 'param'
              ? `el parámetro «${ref.period.name}» (${String(params[ref.period.name])})`
              : `el periodo ${String(value)}`;
          throw new RangeError(
            `estrategia propia: ${detail} no es un periodo válido para «${ref.name}»: debe ser un entero de ${RULES_MIN_PERIOD} a ${RULES_MAX_PERIOD}`,
          );
        }
        const key = feedKey(ref.name, value);
        if (!specs.has(key)) {
          specs.set(key, { key, name: ref.name, period: value });
        }
      }
      feedSpecs = [...specs.values()];
      stopSpec = resolveLevel(program.stop, 'stop');
      targetSpec = resolveLevel(program.target, 'objetivo');
      states = new Map();
    },
    onBar(ctx: StrategyContext) {
      for (const ticker of ctx.tickers()) {
        const w = ctx.bars(ticker);
        let st = states.get(ticker);
        if (st === undefined) {
          st = {
            seen: 0,
            feeds: new Map(feedSpecs.map((spec) => [spec.key, makeFeed(spec.name, spec.period)])),
            cross: crossNodes.map(() => ({ prev: null, cur: null })),
          };
          states.set(ticker, st);
        }
        while (st.seen < w.length) {
          const bar = w.at(st.seen);
          for (const feed of st.feeds.values()) {
            feed.update(bar);
          }
          // Los operandos de cada cruce se calculan en TODA vela revelada
          // —igual que las clásicas capturan el valor previo al alimentar
          // sus medias—: así «la vela anterior» es siempre la última del
          // activo, también al salir del calentamiento.
          const env: EvalEnv = { bar, params, feeds: st.feeds };
          for (let i = 0; i < crossNodes.length; i++) {
            const s = st.cross[i]!;
            s.prev = s.cur;
            s.cur = {
              left: evalNum(crossNodes[i]!.left, env),
              right: evalNum(crossNodes[i]!.right, env),
            };
          }
          st.seen++;
          if (st.seen === w.length && bar.date === ctx.date && !ctx.warmup) {
            evaluate(ctx, ticker, st, bar);
          }
        }
      }
    },
  };
}
