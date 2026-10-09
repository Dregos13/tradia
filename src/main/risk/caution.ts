/**
 * Modo cautela por calendario y mercado (fase 3) — módulo puro.
 *
 * `evaluateCaution` recibe un instante y un contexto ya reunido (eventos
 * del calendario, tickers en cartera y último VIX conocido) y devuelve el
 * `CautionState` del contrato: sin efecto, tamaño × 0,5 o bloqueo de
 * entradas nuevas, con la causa y el evento que la provoca. Sin Electron,
 * sin base de datos y sin reloj propio: quien llama lo inyecta todo a
 * través de `createCautionContextSource`.
 *
 * Reglas (supuestos del plan de fase; umbrales en `shared/risk`):
 * - `festivo`: bloqueo los días sin sesión de NYSE (festivo o fin de
 *   semana). Es estructural del día: no lleva `until`.
 * - `apertura`: bloqueo de los primeros `CAUTION_OPENING_MINUTES` minutos
 *   de la sesión de Nueva York.
 * - `alto-impacto`: bloqueo en los ±`CAUTION_HIGH_IMPACT_WINDOW_MINUTES`
 *   minutos alrededor de un evento de impacto 'alto' (FOMC, NFP, IPC,
 *   PCE, PIB…). Los tipos 'vencimiento' y 'resultados' no entran aquí:
 *   tienen su propia regla aunque 'vencimiento' se clasifique como 'alto'.
 * - `resultados`: bloqueo de entradas en el activo el día en que publica
 *   resultados, solo si ya está en cartera y la señal es sobre ese
 *   activo. Sin ticker (estado global de la pantalla) basta con que
 *   informe cualquier activo de la cartera.
 * - `vencimiento`: tamaño × `CAUTION_REDUCED_SIZE_FACTOR` todo el día del
 *   vencimiento (tercer viernes, o el día de negociación al que se
 *   traslade).
 * - `sesion-corta`: tamaño × 0,5 en sesiones de cierre anticipado
 *   (13:00 ET).
 * - `vix`: por encima de `CAUTION_VIX_REDUCE` reduce; por encima de
 *   `CAUTION_VIX_BLOCK` bloquea. Sin dato no hay regla.
 *
 * Cuando varias reglas aplican gana el efecto más restrictivo
 * ('bloquear' > 'reducir') y, a igualdad de efecto, la causa de menor
 * `CAUSE_PRECEDENCE` —así el banner muestra el evento con nombre antes
 * que la ventana de apertura—. Todas las horas se comparan como
 * instantes UTC: el calendario de mercado ya resuelve el huso de Nueva
 * York con `Intl`, también en las semanas de desfase del cambio de
 * horario EE. UU./Europa (mediados de marzo, finales de octubre).
 */

import type { CalendarEventKind, ImpactLevel } from '../../shared/ipc';
import {
  CAUTION_HIGH_IMPACT_WINDOW_MINUTES,
  CAUTION_OPENING_MINUTES,
  CAUTION_REDUCED_SIZE_FACTOR,
  CAUTION_VIX_BLOCK,
  CAUTION_VIX_REDUCE,
  type CautionCause,
  type CautionEffect,
  type CautionState,
} from '../../shared/risk';
import {
  NYSE_ZONE,
  getSession,
  nySessionDate,
  zonedToUtcMs,
  type InstantInput,
} from '../market/calendar';
import { addDays } from '../news/calendar/rules';

/**
 * Evento del calendario tal como lo consume el evaluador: la forma de
 * `CalendarEvent` y del gancho `risk:simulate-calendar-event` sin los
 * campos de persistencia (id, país, origen).
 */
export interface CautionEvent {
  kind: CalendarEventKind;
  title: string;
  /** Instante UTC (ISO 8601). */
  dateUtc: string;
  impact: ImpactLevel;
  /** Activo relacionado en eventos 'resultados'; ausente en macro. */
  asset?: string | null;
}

/** Contexto del mundo que necesita el evaluador para un instante. */
export interface CautionContext {
  /** Eventos próximos al instante y del día de sesión (macro y resultados). */
  events: readonly CautionEvent[];
  /** Tickers con posición abierta en la cartera (regla de resultados). */
  portfolioTickers: readonly string[];
  /** Último valor conocido del VIX (serie VIXCLS de market/macro); null si no hay dato. */
  vix: number | null;
}

/** Regla de cautela disparada, antes de elegir cuál se informa. */
export interface CautionCandidate {
  effect: CautionEffect;
  cause: CautionCause;
  /** Título del evento o motivo legible para el banner y el registro. */
  eventTitle: string;
  /** ISO 8601 del fin del efecto; null si es estructural del día. */
  until: string | null;
}

/**
 * Orden en que se informa una causa cuando hay varias con el mismo
 * efecto: primero el cierre del día y los eventos con nombre propio,
 * después los umbrales persistentes (VIX) y por último la ventana de
 * apertura, que está activa siempre en sus 15 minutos.
 */
const CAUSE_PRECEDENCE: Record<CautionCause, number> = {
  festivo: 0,
  'alto-impacto': 1,
  resultados: 2,
  vix: 3,
  apertura: 4,
  'sesion-corta': 5,
  vencimiento: 6,
};

const MINUTE_MS = 60_000;
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Normaliza un instante. Misma convención que el calendario de mercado:
 * una cadena 'YYYY-MM-DD' sin hora es medianoche de ese día civil en
 * Nueva York, no en UTC.
 */
function toMs(input: InstantInput): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === 'number') return input;
  const bare = BARE_DATE_RE.exec(input);
  if (bare) {
    return zonedToUtcMs(Number(bare[1]), Number(bare[2]), Number(bare[3]), 0, 0, NYSE_ZONE);
  }
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new TypeError(`Instante no válido: ${input}`);
  return ms;
}

const normalizeTicker = (ticker: string | null | undefined): string | null =>
  ticker?.trim().toUpperCase() || null;

/** VIX con un decimal en el motivo legible. */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Todas las reglas de cautela que aplican en `at`, sin elegir ganadora.
 * El banner del diseño las usa para el «+{n} causas» cuando hay varias.
 *
 * `ticker` es el activo de la señal evaluada: la regla de resultados
 * solo bloquea entradas en ese activo. Sin `ticker` (vista global de la
 * pantalla) informa si algún activo de la cartera publica hoy.
 */
export function cautionCandidates(
  at: InstantInput,
  context: CautionContext,
  ticker?: string,
): CautionCandidate[] {
  const nowMs = toMs(at);
  const sessionDate = nySessionDate(nowMs);
  const session = getSession(nowMs);
  const portfolio = new Set(
    context.portfolioTickers.map(normalizeTicker).filter((t): t is string => t !== null),
  );
  const wanted = normalizeTicker(ticker);
  const candidates: CautionCandidate[] = [];

  if (session === null) {
    const dayOfWeek = new Date(`${sessionDate}T00:00:00.000Z`).getUTCDay();
    candidates.push({
      effect: 'bloquear',
      cause: 'festivo',
      eventTitle:
        dayOfWeek === 0 || dayOfWeek === 6
          ? 'Fin de semana (NYSE cerrada)'
          : 'Festivo de NYSE (mercado cerrado)',
      until: null,
    });
  } else {
    const openMs = Date.parse(session.opensAtUtc);
    const openingEndMs = openMs + CAUTION_OPENING_MINUTES * MINUTE_MS;
    if (nowMs >= openMs && nowMs < openingEndMs) {
      candidates.push({
        effect: 'bloquear',
        cause: 'apertura',
        eventTitle: `Apertura de NYSE (primeros ${CAUTION_OPENING_MINUTES} minutos)`,
        until: new Date(openingEndMs).toISOString(),
      });
    }
    if (session.earlyClose) {
      candidates.push({
        effect: 'reducir',
        cause: 'sesion-corta',
        eventTitle: 'Sesión corta (cierre anticipado a las 13:00 ET)',
        until: null,
      });
    }
  }

  const windowMs = CAUTION_HIGH_IMPACT_WINDOW_MINUTES * MINUTE_MS;
  let highImpact: { event: CautionEvent; distance: number } | null = null;
  for (const event of context.events) {
    const eventMs = Date.parse(event.dateUtc);
    if (Number.isNaN(eventMs)) continue;
    if (event.kind === 'resultados') {
      const asset = normalizeTicker(event.asset);
      if (
        asset !== null &&
        nySessionDate(eventMs) === sessionDate &&
        portfolio.has(asset) &&
        (wanted === null || wanted === asset)
      ) {
        candidates.push({
          effect: 'bloquear',
          cause: 'resultados',
          eventTitle: event.title,
          until: null,
        });
      }
      continue;
    }
    if (event.kind === 'vencimiento') {
      if (nySessionDate(eventMs) === sessionDate) {
        candidates.push({
          effect: 'reducir',
          cause: 'vencimiento',
          eventTitle: event.title,
          until: null,
        });
      }
      continue;
    }
    if (event.impact === 'alto') {
      const distance = Math.abs(nowMs - eventMs);
      if (distance <= windowMs && (highImpact === null || distance < highImpact.distance)) {
        highImpact = { event, distance };
      }
    }
  }
  if (highImpact !== null) {
    candidates.push({
      effect: 'bloquear',
      cause: 'alto-impacto',
      eventTitle: highImpact.event.title,
      until: new Date(Date.parse(highImpact.event.dateUtc) + windowMs).toISOString(),
    });
  }

  const vix = context.vix;
  if (vix !== null && Number.isFinite(vix)) {
    if (vix > CAUTION_VIX_BLOCK) {
      candidates.push({
        effect: 'bloquear',
        cause: 'vix',
        eventTitle: `VIX ${round1(vix)}`,
        until: null,
      });
    } else if (vix > CAUTION_VIX_REDUCE) {
      candidates.push({
        effect: 'reducir',
        cause: 'vix',
        eventTitle: `VIX ${round1(vix)}`,
        until: null,
      });
    }
  }

  return candidates;
}

/**
 * Estado de cautela en `at`: gana el efecto más restrictivo entre las
 * reglas disparadas y, a igualdad, la causa de menor precedencia.
 */
export function evaluateCaution(
  at: InstantInput,
  context: CautionContext,
  ticker?: string,
): CautionState {
  const candidates = cautionCandidates(at, context, ticker);
  const chosen =
    firstByPrecedence(candidates, 'bloquear') ?? firstByPrecedence(candidates, 'reducir');
  if (chosen === null) {
    return {
      active: false,
      effect: 'ninguno',
      sizeFactor: 1,
      cause: null,
      eventTitle: null,
      until: null,
    };
  }
  return {
    active: true,
    effect: chosen.effect,
    sizeFactor: chosen.effect === 'bloquear' ? 0 : CAUTION_REDUCED_SIZE_FACTOR,
    cause: chosen.cause,
    eventTitle: chosen.eventTitle,
    until: chosen.until,
  };
}

function firstByPrecedence(
  candidates: readonly CautionCandidate[],
  effect: CautionEffect,
): CautionCandidate | null {
  let best: CautionCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.effect !== effect) continue;
    if (best === null || CAUSE_PRECEDENCE[candidate.cause] < CAUSE_PRECEDENCE[best.cause]) {
      best = candidate;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Adaptador inyectable: reúne el contexto desde los servicios reales
// ---------------------------------------------------------------------------

export interface CautionContextDeps {
  /**
   * Eventos del calendario entre dos fechas civiles UTC ('YYYY-MM-DD',
   * inclusive). En la app lo sirve `CalendarRepository.listInRange` /
   * `CalendarService.list` de `news/calendar`.
   */
  listEvents(desde: string, hasta: string): readonly CautionEvent[];
  /** Tickers con posición abierta en la cartera simulada; [] por defecto. */
  getPortfolioTickers?(): readonly string[];
  /** Último valor conocido del VIX (VIXCLS); null por defecto. */
  getVix?(): number | null;
}

/**
 * Fuente del contexto de cautela: las fuentes reales más un bolsillo de
 * eventos simulados para el gancho E2E `risk:simulate-calendar-event`.
 */
export interface CautionContextSource {
  /** Contexto del instante `at` (ms epoch): eventos reales + simulados. */
  context(at: number): CautionContext;
  /** Atajo: reúne el contexto de `at` y lo evalúa (con ticker opcional). */
  evaluate(at: InstantInput, ticker?: string): CautionState;
  /** Inyecta un evento simulado que participa en las evaluaciones. */
  addSimulatedEvent(event: CautionEvent): void;
  /** Descarta los eventos simulados acumulados. */
  clearSimulatedEvents(): void;
}

/**
 * Crea la fuente de contexto del evaluador. Los eventos se piden para el
 * día civil UTC del instante y el anterior y el siguiente, así la
 * ventana de ±30 minutos y la comparación por día de Nueva York siempre
 * tienen los eventos que pueden tocar.
 */
export function createCautionContextSource(deps: CautionContextDeps): CautionContextSource {
  const simulated: CautionEvent[] = [];

  const context = (at: number): CautionContext => {
    const day = new Date(at).toISOString().slice(0, 10);
    return {
      events: [...deps.listEvents(addDays(day, -1), addDays(day, 1)), ...simulated],
      portfolioTickers: deps.getPortfolioTickers?.() ?? [],
      vix: deps.getVix?.() ?? null,
    };
  };

  return {
    context,
    evaluate: (at, ticker) => evaluateCaution(at, context(toMs(at)), ticker),
    addSimulatedEvent: (event) => {
      simulated.push(event);
    },
    clearSimulatedEvents: () => {
      simulated.length = 0;
    },
  };
}
