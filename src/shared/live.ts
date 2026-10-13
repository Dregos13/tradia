/**
 * Dominio del dinero real mínimo (fase 7) — contrato compartido.
 *
 * El modo real queda bloqueado hasta que la lista de comprobación de la
 * sección 18 del plan y docs/alcance.md §4.4 esté completa y los límites
 * confirmados por escrito. Reglas fijas:
 *
 * - Los requisitos automáticos los evalúa el proceso principal: la
 *   interfaz solo puede enviar las declaraciones y los límites.
 * - Los límites escritos nunca pueden superar los techos fijos de esta
 *   fase (`LIVE_FIXED_CAPS`); la frase de confirmación se genera con los
 *   valores exactos y se exige literal al activar.
 * - El modo real se suspende para órdenes nuevas si se activa la parada
 *   de emergencia, se pierde la conexión o deja de cumplirse un
 *   requisito automático; nunca se reactiva solo.
 * - Las claves live viven en su propia ranura de `secrets`
 *   (`LIVE_BROKER_SECRET_KEYS`) y jamás salen del proceso principal.
 *
 * **Corto con dinero real**: las estrategias propias pueden operar en
 * corto y ejecutarse en la cuenta real, pero con techos propios
 * (`LIVE_FIXED_SHORT_CAPS`), aparte de los del largo: nocional por
 * orden (`shortOrderUsd`), exposición corta total (`shortExposureUsd`),
 * posiciones cortas (`shortPositions`) y distancia máxima del stop de
 * protección sobre la entrada (`shortMaxStopPct`). Con los tres límites
 * a 0 —como quedan las cuentas migradas— el corto está desactivado;
 * habilitarlo exige confirmar una frase nueva que ya los incluye. La
 * pérdida en corto no tiene tope natural, así que cada corto real sale
 * siempre limitado (nunca a mercado) y con su stop de compra de
 * protección, y la parada de emergencia recompra los cortos abiertos.
 * Estos techos tampoco se escalan nunca de forma automática.
 *
 * El corto exige además sus **propios requisitos**
 * (`LIVE_SHORT_REQUIREMENTS`): la declaración de revisión legal y
 * fiscal específica de las ventas en corto (CNMV/MiFID II e IRPF) y la
 * evidencia automática de semanas de cortos en paper con la
 * conciliación cuadrada. Sin ellos no se guardan ni confirman límites
 * del corto mayores que 0 y ninguna entrada en corto real pasa la
 * guarda — siempre con el motivo «[corto-requisitos] …». Una cuenta con
 * límites del corto ya confirmados los conserva intactos, pero el corto
 * queda bloqueado hasta cumplir sus requisitos. El largo no cambia: los
 * siete requisitos de `LIVE_REQUIREMENTS` son exactamente los mismos.
 *
 * Persistencia: migración 011 (`live_checklist`, `live_limits`,
 * `live_mode`); la 016 añade los límites del corto a `live_limits`; la
 * 017 añade los requisitos del corto a `live_checklist` y la cuenta a
 * `reconcile_runs`.
 */

// ---------------------------------------------------------------------------
// Lista de comprobación (sección 18 del plan, §4.4 de alcance)
// ---------------------------------------------------------------------------

/** Los siete requisitos: cuatro automáticos y tres declaraciones. */
export const LIVE_REQUIREMENTS = [
  'validacion-fuera-muestra',
  'paper-continuo',
  'parada-probada',
  'alertas-activas',
  'claves-sin-retirada',
  'plan-contingencia',
  'revision-legal',
] as const;
/** Los siete requisitos del largo (y del modo real en general). */
export type LiveBaseRequirement = (typeof LIVE_REQUIREMENTS)[number];

/**
 * Requisitos propios del corto con dinero real, aparte de los siete del
 * largo: sin ellos no se guardan ni confirman límites del corto mayores
 * que 0 y ninguna entrada en corto real pasa la guarda. No alteran la
 * lista del largo — `allComplete` sigue midiendo solo los siete.
 */
export const LIVE_SHORT_REQUIREMENTS = ['revision-legal-corto', 'paper-cortos'] as const;
export type LiveShortRequirement = (typeof LIVE_SHORT_REQUIREMENTS)[number];

/** Cualquier requisito de la lista, del largo o del corto. */
export type LiveRequirement = LiveBaseRequirement | LiveShortRequirement;

/**
 * Umbrales de la evidencia de cortos en paper exigida por `paper-cortos`
 * (supuesto del plan): al menos 4 semanas entre el primer y el último
 * corto cerrado en paper, al menos 5 cortos cerrados y ningún descuadre
 * de conciliación de paper abierto. En constantes para cambiarlos fácil.
 */
export const LIVE_SHORT_PAPER_MIN_WEEKS = 4;
export const LIVE_SHORT_PAPER_MIN_TRADES = 5;

/**
 * Código de los rechazos por requisitos del corto sin cumplir; viaja en
 * el propio mensaje («[corto-requisitos] motivo») porque un error tipado
 * pierde sus propiedades propias al cruzar el IPC de Electron.
 */
export const LIVE_SHORT_ERROR_CODE = 'corto-requisitos';

/** Requisitos que solo el proceso principal puede evaluar. */
export const LIVE_AUTOMATIC_REQUIREMENTS = [
  'validacion-fuera-muestra',
  'paper-continuo',
  'parada-probada',
  'alertas-activas',
] as const satisfies readonly LiveBaseRequirement[];

/** Del corto, el requisito que solo el proceso principal puede evaluar. */
export const LIVE_SHORT_AUTOMATIC_REQUIREMENTS = [
  'paper-cortos',
] as const satisfies readonly LiveShortRequirement[];

/** Requisitos que el usuario declara por escrito (`live:declare`). */
export const LIVE_DECLARATION_REQUIREMENTS = [
  'claves-sin-retirada',
  'plan-contingencia',
  'revision-legal',
] as const satisfies readonly LiveBaseRequirement[];

/** Del corto, la declaración que el usuario suscribe por escrito. */
export const LIVE_SHORT_DECLARATION_REQUIREMENTS = [
  'revision-legal-corto',
] as const satisfies readonly LiveShortRequirement[];

export type LiveDeclarationRequirement =
  | (typeof LIVE_DECLARATION_REQUIREMENTS)[number]
  | (typeof LIVE_SHORT_DECLARATION_REQUIREMENTS)[number];

/** Todas las declaraciones que acepta `live:declare` (largo y corto). */
export const LIVE_ALL_DECLARATION_REQUIREMENTS = [
  ...LIVE_DECLARATION_REQUIREMENTS,
  ...LIVE_SHORT_DECLARATION_REQUIREMENTS,
] as const satisfies readonly LiveDeclarationRequirement[];

/**
 * Texto íntegro de cada declaración (es lo que guarda la base junto a la
 * fecha). El usuario la suscribe con su marca en la pantalla, no la
 * redacta a mano.
 */
export const LIVE_DECLARATION_TEXTS: Record<LiveDeclarationRequirement, string> = {
  'claves-sin-retirada': 'Declaro que estas claves no permiten retirar fondos.',
  'plan-contingencia': 'He revisado el plan para caída de internet, broker y equipo.',
  'revision-legal': 'He revisado con profesionales mis obligaciones legales y fiscales.',
  'revision-legal-corto':
    'Declaro que he revisado con un profesional la normativa aplicable a las ventas en corto ' +
    '(CNMV/MiFID II) y su fiscalidad (IRPF).',
};

/** Títulos finales de cada requisito (los de la pantalla «Dinero real»). */
export const LIVE_REQUIREMENT_TITLES: Record<LiveRequirement, string> = {
  'validacion-fuera-muestra': 'Validación fuera de muestra guardada',
  'paper-continuo':
    'Paper continuo durante al menos 3 meses, 30 operaciones y desviación dentro de ±30 %',
  'parada-probada': 'Parada de emergencia probada en los últimos 30 días',
  'alertas-activas': 'Canal externo de alertas activo y prueba correcta',
  'claves-sin-retirada': 'Claves live sin permiso de retirada',
  'plan-contingencia': 'Plan de contingencia documentado',
  'revision-legal': 'Revisión legal y fiscal con profesionales',
  'revision-legal-corto': 'Revisión legal y fiscal específica de las ventas en corto',
  'paper-cortos': 'Cortos en paper durante semanas con la conciliación cuadrada',
};

/** Estado de un requisito; 'revisar' cuando la evidencia pide atención. */
export const LIVE_REQUIREMENT_STATES = ['pendiente', 'cumplido', 'revisar'] as const;
export type LiveRequirementState = (typeof LIVE_REQUIREMENT_STATES)[number];

/** Origen del estado: calculado por main o declarado por el usuario. */
export type LiveRequirementKind = 'automatica' | 'declaracion';

/** Una fila de la lista de comprobación (`live_checklist`). */
export interface LiveChecklistItem {
  requirement: LiveRequirement;
  kind: LiveRequirementKind;
  title: string;
  state: LiveRequirementState;
  /** Evidencia legible calculada por main ('34 operaciones · desviación −4 %'). */
  evidence: string | null;
  /** Texto declarado por el usuario (LIVE_DECLARATION_TEXTS); null sin declarar. */
  declaration: string | null;
  /** Nota o enlace local opcional de la declaración (p. ej. la ruta del plan). */
  declarationDetail: string | null;
  /** Última evaluación automática o fecha de la declaración (ISO 8601). */
  markedAt: string | null;
}

/**
 * Estado de los requisitos propios del corto (`LIVE_SHORT_REQUIREMENTS`).
 * Solo bloquea el corto con dinero real; el largo mide `allComplete`
 * de la lista de los siete, que no cambia.
 */
export interface LiveShortChecklist {
  items: LiveChecklistItem[];
  completedCount: number;
  total: number;
  /** true solo con los dos requisitos del corto cumplidos. */
  allComplete: boolean;
  /**
   * Motivo legible del bloqueo del corto (lo que falta para habilitarlo);
   * null si `allComplete`. Es el texto que acompaña a
   * «[corto-requisitos]» en los rechazos.
   */
  blockReason: string | null;
}

/** La lista completa que ve la pantalla «Dinero real» (`live:checklist`). */
export interface LiveChecklist {
  items: LiveChecklistItem[];
  completedCount: number;
  total: number;
  /** true solo con los siete requisitos cumplidos. */
  allComplete: boolean;
  /** Requisitos propios del corto con dinero real (bloqueo aparte). */
  short: LiveShortChecklist;
  /**
   * Límites guardados en `live_limits`, confirmados o no: la pantalla
   * recupera el borrador al volver (limits null si nunca se guardaron).
   */
  limits: LiveLimitsState;
  /** Instante de la última evaluación en el proceso principal (ISO 8601). */
  evaluatedAt: string | null;
}

/** Declaración enviada por `live:declare`: marcar (confirmed) o desmarcar. */
export interface LiveDeclareRequest {
  requirement: LiveDeclarationRequirement;
  /** true suscribe la declaración con fecha; false la retira. */
  confirmed: boolean;
  /** Nota o enlace local opcional (p. ej. ruta del plan de contingencia). */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Límites escritos y techos fijos
// ---------------------------------------------------------------------------

/**
 * Techos fijos del corto con dinero real, aparte de los del largo. En
 * corto la pérdida no tiene tope natural, así que los techos son aún más
 * conservadores y la puerta exige además orden limitada y stop de compra
 * de protección. El corto nace desactivado (límites a 0 en las cuentas
 * migradas) y habilitarlo exige escribir una frase de confirmación nueva
 * que ya los incluye. Ningún escalado automático los sube nunca.
 */
export const LIVE_FIXED_SHORT_CAPS = {
  /** Nocional máximo de una entrada en corto: 100 USD. */
  shortOrderUsd: 100,
  /** Exposición corta total abierta, al precio actual: 200 USD. */
  shortExposureUsd: 200,
  /** Posiciones cortas abiertas simultáneas: 1. */
  shortPositions: 1,
  /**
   * Distancia máxima del stop de compra de protección sobre la entrada,
   * en % (en corto el stop queda por encima): 5 %.
   */
  shortMaxStopPct: 5,
} as const;
export type LiveFixedShortCaps = typeof LIVE_FIXED_SHORT_CAPS;

/**
 * Techos fijos de esta fase: el código nunca admite más capital real que
 * estos valores, y los límites escritos del usuario solo pueden ser
 * iguales o menores. Los tres del corto son los de
 * `LIVE_FIXED_SHORT_CAPS`, repetidos aquí para que la validación y la
 * interfaz indexen por nombre de límite. El escalado queda para la fase 8.
 */
export const LIVE_FIXED_CAPS = {
  /** Capital total en real: máximo 1 000 USD. */
  capitalUsd: 1_000,
  /** Nocional máximo por orden: 200 USD. */
  orderUsd: 200,
  /** Pérdida diaria máxima: 20 USD. */
  dailyLossUsd: 20,
  /** Posiciones abiertas simultáneas (largos y cortos): 2. */
  openPositions: 2,
  /** Nocional máximo de una entrada en corto: 100 USD. */
  shortOrderUsd: LIVE_FIXED_SHORT_CAPS.shortOrderUsd,
  /** Exposición corta total abierta, al precio actual: 200 USD. */
  shortExposureUsd: LIVE_FIXED_SHORT_CAPS.shortExposureUsd,
  /** Posiciones cortas abiertas simultáneas: 1. */
  shortPositions: LIVE_FIXED_SHORT_CAPS.shortPositions,
} as const;
export type LiveFixedCaps = typeof LIVE_FIXED_CAPS;

/**
 * Límites escritos por el usuario (`live_limits`): los del largo > 0 y ≤
 * el techo; los del corto ≥ 0 y ≤ el techo —a 0 el corto queda
 * desactivado (los tres deben ser > 0 para que una entrada en corto
 * pueda pasar la puerta).
 */
export interface LiveLimits {
  capitalUsd: number;
  orderUsd: number;
  dailyLossUsd: number;
  openPositions: number;
  /** Nocional máximo de una entrada en corto; 0 = corto desactivado. */
  shortOrderUsd: number;
  /** Exposición corta total abierta al precio actual; 0 = desactivado. */
  shortExposureUsd: number;
  /** Posiciones cortas abiertas simultáneas; 0 = desactivado. */
  shortPositions: number;
}

/**
 * Entrada de `live:set-limits`: los cuatro límites del largo son
 * obligatorios; los del corto son opcionales —ausentes valen 0 y el
 * corto queda desactivado— así una interfaz que aún no expone sus
 * campos guarda con el corto cerrado, nunca abierto por defecto.
 */
export interface LiveLimitsInput {
  capitalUsd: number;
  orderUsd: number;
  dailyLossUsd: number;
  openPositions: number;
  shortOrderUsd?: number;
  shortExposureUsd?: number;
  shortPositions?: number;
}

/**
 * Respuesta de `live:set-limits`: los límites guardados y la frase de
 * confirmación generada con los valores exactos. La frase se exige
 * literal al activar (`live:activate`), no en este paso.
 */
export interface LiveLimitsState {
  limits: LiveLimits | null;
  /** Frase generada con los valores exactos; null si no hay límites. */
  confirmationPhrase: string | null;
  /** Los límites confirmados por escrito valen para activar. */
  confirmed: boolean;
  savedAt: string | null;
}

const liveUsd = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

/**
 * Frase exacta que el usuario escribe en el diálogo de activación; cambia
 * si cambia cualquier límite —largo o corto— (p. ej. «ACTIVO DINERO REAL
 * CON 500 USD, 100 USD POR ORDEN, 10 USD DE PÉRDIDA DIARIA Y 1 POSICIÓN;
 * CORTO 50 USD POR ORDEN, 100 USD DE EXPOSICIÓN Y 1 POSICIÓN EN CORTO»).
 * La comparación ignora solo espacios sobrantes en los extremos.
 */
export function liveConfirmationPhrase(limits: LiveLimitsInput): string {
  const positions =
    limits.openPositions === 1 ? '1 POSICIÓN' : `${limits.openPositions} POSICIONES`;
  const shortPositionsCount = limits.shortPositions ?? 0;
  const shortPositions =
    shortPositionsCount === 1
      ? '1 POSICIÓN EN CORTO'
      : `${shortPositionsCount} POSICIONES EN CORTO`;
  return (
    `ACTIVO DINERO REAL CON ${liveUsd(limits.capitalUsd)} USD, ` +
    `${liveUsd(limits.orderUsd)} USD POR ORDEN, ` +
    `${liveUsd(limits.dailyLossUsd)} USD DE PÉRDIDA DIARIA Y ${positions}; ` +
    `CORTO ${liveUsd(limits.shortOrderUsd ?? 0)} USD POR ORDEN, ` +
    `${liveUsd(limits.shortExposureUsd ?? 0)} USD DE EXPOSICIÓN Y ${shortPositions}`
  );
}

/** true si la frase escrita coincide con la esperada (tras recortar extremos). */
export function livePhraseMatches(typed: string, limits: LiveLimits): boolean {
  return typed.trim() === liveConfirmationPhrase(limits);
}

// ---------------------------------------------------------------------------
// Estado del modo real
// ---------------------------------------------------------------------------

/**
 * Estados del modo real: 'bloqueado' mientras falte un requisito o los
 * límites por confirmar; 'listo' cuando todo está vigente pero aún no se
 * activó; 'activo' operando; 'suspendido' si estaba activo y saltó la
 * parada, se perdió la conexión o venció un requisito automático (en
 * 'suspendido' no se envían órdenes nuevas y la franja sigue visible).
 */
export const LIVE_MODE_STATES = ['bloqueado', 'listo', 'activo', 'suspendido'] as const;
export type LiveModeState = (typeof LIVE_MODE_STATES)[number];

/** Causas por las que el modo activo se suspende (o un intento se rechaza). */
export const LIVE_SUSPENSION_REASONS = [
  'sin-conexion',
  'parada-emergencia',
  'requisito-vencido',
] as const;
export type LiveSuspensionReason = (typeof LIVE_SUSPENSION_REASONS)[number];

/** Ranura de claves live del almacén `secrets` (separada de la de paper). */
export const LIVE_BROKER_SECRET_KEYS = {
  apiKeyId: 'broker-alpaca-live-key-id',
  apiSecret: 'broker-alpaca-live-secret',
} as const;

/** Estado completo del modo real (`live:state`, evento `live:changed`). */
export interface LiveState {
  mode: LiveModeState;
  /** Motivo de la suspensión; null si no está suspendido. */
  suspension: { reason: LiveSuspensionReason; detail: string } | null;
  /** Claves live guardadas en su ranura (la app no las muestra). */
  hasCredentials: boolean;
  /** Cuenta live enmascarada para la franja ('•••• 4821'); null sin conexión. */
  accountMasked: string | null;
  /** Límites escritos confirmados por escrito; null sin confirmar. */
  limits: LiveLimits | null;
  /** Techos fijos de la fase (constantes, no configurables). */
  caps: LiveFixedCaps;
  /**
   * Estado de los requisitos propios del corto real: con
   * `allComplete` en false el corto está bloqueado y `blockReason` dice
   * qué falta. No afecta al largo.
   */
  short: { allComplete: boolean; blockReason: string | null };
  /** Última prueba de humo; null si nunca se ejecutó. */
  smokeTest: LiveSmokeTestResult | null;
  activatedAt: string | null;
  suspendedAt: string | null;
  updatedAt: string;
}

/**
 * Respuesta de `live:activate`: nunca lanza por requisitos pendientes —
 * devuelve la lista exacta de motivos para que la pantalla la muestre.
 * Una frase que no coincide también es un rechazo (`reason` en motivos).
 */
export interface LiveActivateResult {
  activated: boolean;
  /** Requisitos aún pendientes (vacío si el fallo fue otro). */
  pendingRequirements: LiveRequirement[];
  /** Motivos legibles del rechazo ('Solo hay 24 de 30 operaciones requeridas.'). */
  reasons: string[];
  state: LiveState;
}

/** Petición de `live:activate`: la frase de confirmación escrita. */
export interface LiveActivateRequest {
  /** Debe coincidir con `liveConfirmationPhrase(limits)` tras recortar extremos. */
  phrase: string;
}

/** Petición de `live:connect`: claves de la cuenta live (prefijo AK). */
export interface LiveConnectRequest {
  apiKeyId: string;
  apiSecret: string;
}

/** Resultado de `live:test-kill-switch` (la acción «Probar parada»). */
export interface LiveKillSwitchTestResult {
  ok: boolean;
  /** Motivo legible del fallo; null si la prueba pasó. */
  error: string | null;
  /** Instante de la prueba (ISO 8601); es la evidencia de 'parada-probada'. */
  testedAt: string | null;
}

// ---------------------------------------------------------------------------
// Prueba de humo con el importe mínimo
// ---------------------------------------------------------------------------

/** Importe fijo de la prueba: compra fraccionaria de 1 USD sobre SPY. */
export const LIVE_SMOKE_TICKER = 'SPY';
export const LIVE_SMOKE_NOTIONAL_USD = 1;

/** Pasos de la prueba de humo, en orden. */
export const LIVE_SMOKE_STEPS = ['compra-enviada', 'posicion-cerrada', 'conciliacion-ok'] as const;
export type LiveSmokeStep = (typeof LIVE_SMOKE_STEPS)[number];

/** Estados de la prueba (el panel los muestra tal cual). */
export const LIVE_SMOKE_STATES = [
  'no-ejecutada',
  'en-curso',
  'cerrada-conciliada',
  'fallida-posicion-abierta',
  'fallida-sin-posicion',
] as const;
export type LiveSmokeState = (typeof LIVE_SMOKE_STATES)[number];

/** Petición de `live:smoke-test`: confirmación breve explícita. */
export interface LiveSmokeTestRequest {
  confirm: true;
}

/**
 * Resultado de la prueba de humo (persistido en `live_mode.prueba_humo`
 * como JSON y detallado en el Diario). Una posición abierta que no se pudo
 * cerrar nunca se oculta: el estado lo dice.
 */
export interface LiveSmokeTestResult {
  state: LiveSmokeState;
  /** Instante en que se completó cada paso (null mientras no llegue). */
  steps: { step: LiveSmokeStep; at: string | null }[];
  ticker: string;
  notionalUsd: number;
  /**
   * Precio limit con el que salió la compra (la prueba envía una
   * limitada con tope sobre la referencia y los techos, nunca una
   * orden de mercado a ciegas); null si no llegó a enviarse. Es el
   * «límite de protección», NO la referencia: puede superarla hasta el
   * margen de slippage y es contra `referencePrice` contra lo que se
   * mide el slippage.
   */
  requestedPrice: number | null;
  /**
   * Último cierre usado como referencia para dimensionar la fracción y
   * medir el slippage; null si la prueba no llegó a tener precio.
   */
  referencePrice: number | null;
  buyExecutedPrice: number | null;
  sellExecutedPrice: number | null;
  /** Instantáneos de ejecución de cada pata (ISO 8601); null si no ejecutó. */
  buyExecutedAt: string | null;
  sellExecutedAt: string | null;
  /** Slippage de la compra en puntos básicos (positivo = desfavorable). */
  slippageBps: number | null;
  /** Ejecución de conciliación de la prueba (`reconcile_runs.id`). */
  reconcileRunId: number | null;
  /** Descuadres abiertos tras la conciliación (0 cuando cuadró). */
  discrepancies: number | null;
  /** Paso que falló, si lo hubo. */
  failedStep: LiveSmokeStep | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Estado del escalado (informativo; subir techos es fase 8)
// ---------------------------------------------------------------------------

/** Umbrales de evidencia para que el escalado pueda plantearse. */
export const LIVE_SCALING_MIN_WEEKS = 8;
export const LIVE_SCALING_MIN_TRADES = 30;

/** Estados del panel «Estado del escalado»; nunca accionable en esta fase. */
export const LIVE_SCALING_STATES = ['bloqueado', 'en-evidencia', 'elegible'] as const;
export type LiveScalingState = (typeof LIVE_SCALING_STATES)[number];

/**
 * Estado del escalado (`live:scaling`): informa con datos si los
 * resultados reales respaldan el backtest. No existe acción para subir
 * los techos en esta fase; 'elegible' solo lo marca para evaluación.
 */
export interface LiveScalingStatus {
  state: LiveScalingState;
  /** Semanas con modo real activo contabilizadas. */
  liveWeeks: number;
  /** Operaciones reales conciliadas. */
  liveTrades: number;
  /** Semanas dentro del margen real vs backtest. */
  weeksInMargin: number;
  /** Desviación frente al backtest en puntos porcentuales; null sin base. */
  deviationPct: number | null;
  /** Drawdown actual en % del capital real. */
  drawdownPct: number | null;
  /** Motivo legible del estado. */
  reason: string;
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Ganchos E2E (solo TRADIA_E2E y sin empaquetar)
// ---------------------------------------------------------------------------

/**
 * Petición del gancho `live:seed-progress`: siembra la evidencia que
 * evalúan los requisitos automáticos (meses de paper, operaciones,
 * prueba final, parada y alertas) sin tocar las declaraciones.
 */
export interface LiveSeedProgressRequest {
  /** Meses de paper continuo a simular (≥ 3 cumple 'paper-continuo'). */
  paperMonths?: number;
  /** Operaciones paper registradas (≥ 30 cumple la muestra). */
  paperTrades?: number;
  /** Desviación frente al backtest en % (dentro de ±30 cumple). */
  deviationPct?: number;
  /** Cortos cerrados en paper a simular (≥ 5 cumple la muestra del corto). */
  paperShortTrades?: number;
  /** Semanas entre el primer y el último corto en paper (≥ 4 cumple). */
  paperShortWeeks?: number;
  /** Marca la prueba final (validación fuera de muestra) como ejecutada. */
  finalTestDone?: boolean;
  /** Registra una prueba de parada reciente (hoy si no se da fecha). */
  killSwitchTested?: boolean;
  /** Registra un envío de prueba correcto por un canal externo. */
  alertsTested?: boolean;
}

/** Petición del gancho `live:use-simulated-broker`: broker real simulado. */
export interface LiveSimulatedBrokerRequest {
  enabled: boolean;
}
