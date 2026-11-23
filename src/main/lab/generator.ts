/**
 * Generador de estrategias con IA del laboratorio.
 *
 * Pide a la CLI de IA del usuario un borrador en JSON (`prompt.ts`), lo
 * normaliza y lo valida con el MISMO analizador de reglas que usa el
 * motor. Si no compila, reintenta pasando los errores exactos a la IA
 * (hasta `maxAttempts`). Nunca devuelve como válido un borrador cuyas
 * reglas el motor no pueda ejecutar.
 */
import {
  isGeneratedStrategy,
  LAB_MAX_MARKETS,
  type GeneratedStrategy,
  type LabGenerateRequest,
  type LabGenerateResult,
} from '../../shared/lab';
import { normalizeFxPair } from '../../shared/fx';
import { parseStrategyRules } from '../../shared/strategyRules';
import type { StrategyParameterRange } from '../../shared/strategy';
import { buildLabPrompt, LAB_UNIVERSE } from './prompt';

/** Motor de texto: una CLI de IA en modo de una sola pasada. */
export interface LabTextEngine {
  label: string;
  complete(prompt: string): Promise<string>;
}

export interface StrategyGeneratorDeps {
  /** Motor vigente; null si no hay ninguna CLI disponible. */
  engine: () => LabTextEngine | null;
  /** Indicación para instalar o iniciar sesión cuando falta el motor. */
  missingHint?: () => string;
  maxAttempts?: number;
}

export interface StrategyGenerator {
  generate(request: LabGenerateRequest): Promise<LabGenerateResult>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const UNIVERSE = new Set<string>(LAB_UNIVERSE);

/** Saca el primer objeto JSON del texto (tolera bloques ``` y texto alrededor). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('la respuesta no contiene un objeto JSON');
  return JSON.parse(text.slice(start, end + 1));
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Normaliza la salida de la IA a la forma de `GeneratedStrategy`. Lo que
 * no tenga arreglo razonable se deja tal cual para que la validación lo
 * rechace con un mensaje concreto.
 */
export function normalizeDraft(raw: unknown): { draft: GeneratedStrategy; errors: string[] } {
  const errors: string[] = [];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rulesRaw = (typeof o.rules === 'object' && o.rules !== null ? o.rules : {}) as Record<
    string,
    unknown
  >;

  const markets: string[] = [];
  const rejected: string[] = [];
  for (const m of Array.isArray(o.markets) ? o.markets : []) {
    if (typeof m !== 'string') continue;
    const ticker = normalizeFxPair(m) ?? m.trim().toUpperCase();
    if (UNIVERSE.has(ticker)) {
      if (!markets.includes(ticker)) markets.push(ticker);
    } else rejected.push(m);
  }
  if (rejected.length > 0) {
    errors.push(
      `markets: ${rejected.join(', ')} no están disponibles; usa solo ${LAB_UNIVERSE.join(', ')}`,
    );
  }
  if (markets.length === 0) errors.push('markets: indica al menos un ticker de la lista');

  const parameters: Record<string, number> = {};
  if (typeof o.parameters === 'object' && o.parameters !== null) {
    for (const [k, v] of Object.entries(o.parameters)) {
      const n = num(v);
      if (n === null) errors.push(`parameters.${k}: debe ser un número`);
      else parameters[k] = n;
    }
  }
  const parameterRanges: Record<string, StrategyParameterRange> = {};
  if (typeof o.parameterRanges === 'object' && o.parameterRanges !== null) {
    for (const [k, v] of Object.entries(o.parameterRanges)) {
      if (!(k in parameters)) continue;
      const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
      const min = num(r.min);
      const max = num(r.max);
      const step = num(r.step);
      if (min !== null && max !== null && step !== null && min <= max && step > 0) {
        parameterRanges[k] = { min, max, step };
      }
    }
  }

  const draft: GeneratedStrategy = {
    name: str(o.name, 60) || 'Estrategia del laboratorio',
    hypothesis: str(o.hypothesis, 4_000),
    markets: markets.slice(0, LAB_MAX_MARKETS),
    rules: {
      entry: str(rulesRaw.entry, 500),
      exit: str(rulesRaw.exit, 500),
      stop: str(rulesRaw.stop, 500) || 'ninguno',
      target: str(rulesRaw.target, 500) || 'ninguno',
      entryShort: str(rulesRaw.entryShort, 500),
      exitShort: str(rulesRaw.exitShort, 500),
    },
    parameters,
    parameterRanges,
    regime: str(o.regime, 500),
    explanation: str(o.explanation, 4_000),
    risks: (Array.isArray(o.risks) ? o.risks : [])
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim().slice(0, 500))
      .slice(0, 6),
  };
  if (!draft.hypothesis) errors.push('hypothesis: explica por qué debería funcionar');
  return { draft, errors };
}

/** Errores de reglas en el formato que se le devuelve a la IA. */
export function validateDraft(draft: GeneratedStrategy): string[] {
  const errors: string[] = [];
  if (!isGeneratedStrategy(draft)) errors.push('el objeto no tiene la forma pedida');
  const parsed = parseStrategyRules(draft.rules, draft.parameters);
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      const fragment = draft.rules[e.field]?.slice(e.start, e.end) ?? '';
      errors.push(`rules.${e.field}: ${e.message}${fragment ? ` (en «${fragment}»)` : ''}`);
    }
  }
  return errors;
}

export function createStrategyGenerator(deps: StrategyGeneratorDeps): StrategyGenerator {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const generate = async (request: LabGenerateRequest): Promise<LabGenerateResult> => {
    const engine = deps.engine();
    if (engine === null) {
      return {
        ok: false,
        reason: 'sin-motor',
        engine: null,
        message:
          deps.missingHint?.() ??
          'No hay ninguna IA conectada. Instala Claude Code o Codex e inicia sesión.',
      };
    }
    let errors: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let text: string;
      try {
        text = await engine.complete(
          buildLabPrompt({
            idea: request.idea,
            previous: request.previous,
            feedback: request.feedback,
            errors,
          }),
        );
      } catch (error) {
        return {
          ok: false,
          reason: 'motor-error',
          engine: engine.label,
          // Los errores de la CLI vienen del adaptador de noticias con su
          // prefijo; aquí sobra.
          message: ((error as Error)?.message ?? String(error)).replace(/^LLM de noticias: /, ''),
        };
      }
      let raw: unknown;
      try {
        raw = extractJsonObject(text);
      } catch (error) {
        errors = [`la respuesta no era JSON válido: ${(error as Error).message}`];
        continue;
      }
      const normalized = normalizeDraft(raw);
      errors = [...normalized.errors, ...validateDraft(normalized.draft)];
      if (errors.length === 0) {
        return { ok: true, draft: normalized.draft, engine: engine.label, attempts: attempt };
      }
    }
    return {
      ok: false,
      reason: 'respuesta-invalida',
      engine: engine.label,
      message: `La IA no consiguió reglas válidas tras ${maxAttempts} intentos. Último problema: ${errors[0] ?? 'desconocido'}. Prueba a describir la idea con más detalle.`,
    };
  };

  return { generate };
}
