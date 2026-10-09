/**
 * Dominio del motor de riesgo (fase 3) — contrato compartido.
 *
 * Ninguna señal ni orden sale sin pasar por la pasarela única
 * (`risk:submit-signal`). Este módulo define los tipos que cruzan el IPC y
 * los márgenes duros que ni la IA ni las estrategias pueden cambiar:
 * los límites solo se escriben por `risk:set-limits` desde la pantalla y
 * el resto de módulos recibe una instantánea congelada.
 *
 * Valores por defecto y márgenes: ver `docs/alcance.md` §4 (drawdown 10 %,
 * máx. 5 posiciones, 0,5 % por operación, ratio mínimo 1:2) y los
 * supuestos del plan de fase.
 */

// ---------------------------------------------------------------------------
// Señales
// ---------------------------------------------------------------------------

/** Dirección de la intención de señal (posición a abrir). */
export const SIGNAL_DIRECTIONS = ['largo', 'corto'] as const;
export type SignalDirection = (typeof SIGNAL_DIRECTIONS)[number];

/**
 * Quién emite la señal: 'estrategia' para las del motor, 'probador' para
 * las del probador de la pantalla «Riesgo» (marcadas como simulación) y
 * 'e2e' para los ganchos de prueba.
 */
export const SIGNAL_ORIGINS = ['estrategia', 'probador', 'e2e'] as const;
export type SignalOrigin = (typeof SIGNAL_ORIGINS)[number];

/**
 * Intención de señal sometida al motor. El stop es obligatorio (su
 * ausencia provoca veto `STOP_MISSING`, no un rechazo en el borde), igual
 * que una confianza fuera de 0–1 llega al motor (`SIGNAL_INVALID` y posible
 * parada por 'modelo-erratico'): la forma se valida en IPC, las reglas en
 * el motor.
 */
export interface SignalIntent {
  /** Activo sobre el que se quiere abrir posición. */
  ticker: string;
  direction: SignalDirection;
  /** Precio de entrada propuesto (> 0). */
  entry: number;
  /** Stop de protección; null equivale a «sin stop» y queda vetado. */
  stop: number | null;
  /** Objetivo de beneficio; null impide calcular el ratio (veto). */
  target: number | null;
  /** Confianza declarada por el modelo, en rango 0–1. */
  confidence: number;
  origin: SignalOrigin;
}

// ---------------------------------------------------------------------------
// Límites configurables y márgenes duros
// ---------------------------------------------------------------------------

/**
 * Límites de riesgo configurables por el usuario. Todos los porcentajes
 * son puntos porcentuales del capital (0,5 = 0,5 %); `maxCorrelation` es
 * el coeficiente de Pearson (−1..1) y `maxLeverage` un multiplicador.
 */
export interface RiskLimits {
  /** % del capital arriesgado por operación (margen duro 0,5–2). */
  riskPerTradePct: number;
  /** Ratio beneficio/riesgo mínimo admitido; no se puede bajar de 2. */
  minRewardRiskRatio: number;
  /** Pérdida máxima tolerada por periodo (% del capital). */
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxMonthlyLossPct: number;
  /** Drawdown máximo (%); alcanzarlo activa la parada de emergencia. */
  maxDrawdownPct: number;
  /** Posiciones abiertas simultáneas. */
  maxOpenPositions: number;
  /** Exposición máxima (% del capital) por activo. */
  maxAssetExposurePct: number;
  /** Exposición máxima (% del capital) por sector. */
  maxSectorExposurePct: number;
  /** Exposición máxima (% del capital) en divisas distintas de USD. */
  maxCurrencyExposurePct: number;
  /** Correlación máxima admitida entre posiciones (a 60 días). */
  maxCorrelation: number;
  /** Apalancamiento fijo 1x: los márgenes lo dejan inamovible. */
  maxLeverage: number;
  /** Tamaño máximo como % del volumen medio de 20 días. */
  maxLiquidityPct: number;
}

/** Valores prudentes por defecto (docs/alcance.md §4 y supuestos del plan). */
export const RISK_DEFAULTS: RiskLimits = {
  riskPerTradePct: 0.5,
  minRewardRiskRatio: 2,
  maxDailyLossPct: 2,
  maxWeeklyLossPct: 4,
  maxMonthlyLossPct: 6,
  maxDrawdownPct: 10,
  maxOpenPositions: 5,
  maxAssetExposurePct: 20,
  maxSectorExposurePct: 30,
  maxCurrencyExposurePct: 25,
  maxCorrelation: 0.7,
  maxLeverage: 1,
  maxLiquidityPct: 1,
};

/** Margen duro [min, max] de un límite, ambos inclusive. */
export interface RiskBound {
  min: number;
  max: number;
}

/**
 * Márgenes duros de cada límite: `risk:set-limits` rechaza cualquier valor
 * fuera de ellos y la pantalla los usa para el error en línea. El
 * apalancamiento queda fijado a 1x con min = max = 1.
 */
export const RISK_BOUNDS: Record<keyof RiskLimits, RiskBound> = {
  riskPerTradePct: { min: 0.5, max: 2 },
  minRewardRiskRatio: { min: 2, max: 10 },
  maxDailyLossPct: { min: 0.5, max: 5 },
  maxWeeklyLossPct: { min: 1, max: 10 },
  maxMonthlyLossPct: { min: 2, max: 15 },
  maxDrawdownPct: { min: 2, max: 25 },
  maxOpenPositions: { min: 1, max: 10 },
  maxAssetExposurePct: { min: 5, max: 40 },
  maxSectorExposurePct: { min: 10, max: 60 },
  maxCurrencyExposurePct: { min: 5, max: 50 },
  maxCorrelation: { min: 0.1, max: 0.9 },
  maxLeverage: { min: 1, max: 1 },
  maxLiquidityPct: { min: 0.1, max: 5 },
};

/** Un límite fuera de sus márgenes duros. */
export interface RiskLimitViolation {
  key: keyof RiskLimits;
  value: number;
  min: number;
  max: number;
}

/**
 * Límites que violan sus márgenes duros (lista vacía = todo en regla).
 * Función pura: la usa la pantalla para el error en línea y el proceso
 * principal para rechazar `risk:set-limits`.
 */
export function riskLimitViolations(limits: RiskLimits): RiskLimitViolation[] {
  const violations: RiskLimitViolation[] = [];
  for (const key of Object.keys(RISK_BOUNDS) as (keyof RiskLimits)[]) {
    const bound = RISK_BOUNDS[key];
    const value = limits[key];
    if (!Number.isFinite(value) || value < bound.min || value > bound.max) {
      violations.push({ key, value, min: bound.min, max: bound.max });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Motivos de veto
// ---------------------------------------------------------------------------

/**
 * Códigos estables de las reglas del motor. Mayúsculas porque forman parte
 * del contrato persistido (`risk_vetoes.codigo`) y del filtro del registro.
 */
export const VETO_REASON_CODES = [
  // Parada de emergencia: detiene cualquier señal mientras esté activa.
  'KILL_SWITCH_ACTIVE',
  // Reglas por operación.
  'STOP_MISSING',
  'STOP_WRONG_SIDE',
  'RR_TOO_LOW',
  'SIZE_ZERO',
  // Límites de pérdida y drawdown.
  'DAILY_LOSS',
  'WEEKLY_LOSS',
  'MONTHLY_LOSS',
  'MAX_DRAWDOWN',
  // Límites de exposición.
  'MAX_POSITIONS',
  'ASSET_EXPOSURE',
  'SECTOR_EXPOSURE',
  'CURRENCY_EXPOSURE',
  'CORRELATION',
  'LEVERAGE',
  'LIQUIDITY',
  // Modo cautela por calendario/mercado.
  'CAUTION_MODE',
  // La señal no es válida (p. ej. confianza fuera de 0–1).
  'SIGNAL_INVALID',
] as const;
export type VetoReasonCode = (typeof VETO_REASON_CODES)[number];

/** Motivo legible en español de cada código; es lo que ve el usuario. */
export const VETO_REASON_MESSAGES: Record<VetoReasonCode, string> = {
  KILL_SWITCH_ACTIVE: 'Parada activa',
  STOP_MISSING: 'La señal no tiene stop de protección',
  STOP_WRONG_SIDE: 'El stop está del lado contrario de la entrada',
  RR_TOO_LOW: 'Beneficio/riesgo por debajo del mínimo',
  SIZE_ZERO: 'El tamaño calculado es cero',
  DAILY_LOSS: 'Pérdida diaria máxima alcanzada',
  WEEKLY_LOSS: 'Pérdida semanal máxima alcanzada',
  MONTHLY_LOSS: 'Pérdida mensual máxima alcanzada',
  MAX_DRAWDOWN: 'Drawdown máximo alcanzado',
  MAX_POSITIONS: 'Número máximo de posiciones abiertas alcanzado',
  ASSET_EXPOSURE: 'Exposición máxima por activo superada',
  SECTOR_EXPOSURE: 'Exposición máxima por sector superada',
  CURRENCY_EXPOSURE: 'Exposición máxima por divisa superada',
  CORRELATION: 'Correlación máxima entre posiciones superada',
  LEVERAGE: 'Apalancamiento máximo superado',
  LIQUIDITY: 'La posición supera el límite de liquidez',
  CAUTION_MODE: 'Modo cautela',
  SIGNAL_INVALID: 'Señal inválida',
};

// ---------------------------------------------------------------------------
// Decisión del motor
// ---------------------------------------------------------------------------

/** Resultado de evaluar una señal: aprobada, reducida por cautela o vetada. */
export const RISK_DECISION_STATUSES = ['aprobada', 'reducida', 'vetada'] as const;
export type RiskDecisionStatus = (typeof RISK_DECISION_STATUSES)[number];

/** Una regla incumplida (o aplicada, en 'reducida') con su motivo y valores. */
export interface RiskDecisionReason {
  code: VetoReasonCode;
  /** Motivo legible (VETO_REASON_MESSAGES[code]). */
  message: string;
  /** Valores que explican la regla: límite, valor real, evento, factor… */
  details: Record<string, number | string>;
}

/** Lo que devuelve `risk:submit-signal`. */
export interface RiskDecision {
  status: RiskDecisionStatus;
  /** Tamaño calculado en unidades enteras (0 cuando está vetada). */
  size: number;
  /** Factor aplicado al tamaño por cautela (1 normal, p. ej. 0,5 reducido). */
  sizeFactor: number;
  /** Capital arriesgado si el stop salta, en la divisa de la cuenta. */
  riskAmount: number;
  /** Exposición nominal de la posición resultante, en la divisa de la cuenta. */
  notional: number;
  /** Reglas incumplidas (o la de cautela en 'reducida'); vacío en 'aprobada'. */
  reasons: RiskDecisionReason[];
  /** Instante de la decisión (ISO 8601). */
  decidedAt: string;
}

/** Decisiones que se escriben en `risk_vetoes` (las aprobadas no se registran). */
export type LoggedRiskDecision = Exclude<RiskDecisionStatus, 'aprobada'>;

/**
 * Fila del registro de vetos: una entrada por regla incumplida de cada
 * señal (una señal puede generar varias filas).
 */
export interface RiskVeto {
  id: number;
  /** Instantánea de la señal evaluada. */
  signal: SignalIntent;
  ticker: string;
  decision: LoggedRiskDecision;
  /** Regla incumplida (código estable del contrato). */
  code: VetoReasonCode;
  /** Motivo legible en español. */
  message: string;
  /** Valores que explican el veto (límite y valor real). */
  details: Record<string, number | string>;
  /** Tamaño calculado antes del veto. */
  size: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Parada de emergencia (kill switch)
// ---------------------------------------------------------------------------

/**
 * Causas de la parada: 'manual' la pulsa el usuario; las demás son los
 * disparadores automáticos de los supuestos (pérdida anómala, dato
 * anómalo, más de 60 s sin conexión y comportamiento errático del modelo).
 */
export const KILL_SWITCH_CAUSES = [
  'manual',
  'perdida-anomala',
  'dato-anomalo',
  'sin-conexion',
  'modelo-erratico',
] as const;
export type KillSwitchCause = (typeof KILL_SWITCH_CAUSES)[number];

/** Quién ejecutó la acción sobre la parada. */
export const KILL_SWITCH_ACTORS = ['usuario', 'automatico'] as const;
export type KillSwitchActor = (typeof KILL_SWITCH_ACTORS)[number];

/** Motivo legible de cada causa, para el banner y la notificación. */
export const KILL_SWITCH_CAUSE_MESSAGES: Record<KillSwitchCause, string> = {
  manual: 'Parada activada por el usuario',
  'perdida-anomala': 'Pérdida anómala detectada',
  'dato-anomalo': 'Dato de mercado anómalo',
  'sin-conexion': 'Pérdida de conexión',
  'modelo-erratico': 'Comportamiento errático del modelo',
};

/**
 * Estado de la parada de emergencia. La reanudación siempre es manual con
 * confirmación explícita; nunca se reactiva sola.
 */
export interface KillSwitchState {
  active: boolean;
  /** Causa de la última activación (null si nunca se activó). */
  cause: KillSwitchCause | null;
  /** Quién la activó. */
  actor: KillSwitchActor | null;
  /** Instantánea de la última activación (ISO 8601). */
  activatedAt: string | null;
  /** Detalle legible de la causa (qué umbral o dato la disparó). */
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Modo cautela
// ---------------------------------------------------------------------------

/** Efecto de la cautela sobre la señal: nada, reducir el tamaño o bloquear. */
export const CAUTION_EFFECTS = ['ninguno', 'reducir', 'bloquear'] as const;
export type CautionEffect = (typeof CAUTION_EFFECTS)[number];

/** Causas del modo cautela (calendario, VIX y apertura de NY). */
export const CAUTION_CAUSES = [
  'alto-impacto',
  'resultados',
  'vencimiento',
  'festivo',
  'sesion-corta',
  'vix',
  'apertura',
] as const;
export type CautionCause = (typeof CAUTION_CAUSES)[number];

/** Estado del modo cautela tal como lo muestra la pantalla. */
export interface CautionState {
  /** true cuando hay un efecto activo (effect ≠ 'ninguno'). */
  active: boolean;
  effect: CautionEffect;
  /** Factor aplicado al tamaño (1 sin cautela, 0,5 reducido, 0 bloqueado). */
  sizeFactor: number;
  /** Causa de la cautela activa. */
  cause: CautionCause | null;
  /** Título del evento que la provoca (p. ej. 'IPC EE. UU.'). */
  eventTitle: string | null;
  /** Hasta cuándo aplica (ISO 8601); null si es estructural del día. */
  until: string | null;
}

// ---------------------------------------------------------------------------
// Constantes operativas (umbrales de los supuestos del plan)
// ---------------------------------------------------------------------------

/** Minutos antes y después de un dato de impacto alto que bloquea entradas. */
export const CAUTION_HIGH_IMPACT_WINDOW_MINUTES = 30;
/** Factor de tamaño en vencimientos, sesiones cortas y VIX alto. */
export const CAUTION_REDUCED_SIZE_FACTOR = 0.5;
/** VIX por encima: reduce el tamaño; por encima del bloqueo: veta. */
export const CAUTION_VIX_REDUCE = 30;
export const CAUTION_VIX_BLOCK = 40;
/** Minutos tras la apertura de NY en los que se bloquean entradas. */
export const CAUTION_OPENING_MINUTES = 15;

/** Pérdida diaria ≥ factor × límite → parada automática. */
export const KILL_SWITCH_DAILY_LOSS_FACTOR = 1.5;
/** Salto de precio anómalo (%) que dispara la parada. */
export const KILL_SWITCH_PRICE_JUMP_PCT = 20;
/** Segundos sin conexión que disparan la parada automática. */
export const KILL_SWITCH_OFFLINE_SECONDS = 60;
/** Señales por hora que delatan un modelo errático. */
export const KILL_SWITCH_MAX_SIGNALS_PER_HOUR = 20;
/** Señales inválidas seguidas que delatan un modelo errático. */
export const KILL_SWITCH_MAX_INVALID_SIGNALS = 5;

/** Ventana de días para la correlación de Pearson entre posiciones. */
export const CORRELATION_WINDOW_DAYS = 60;
/** Días del volumen medio usado por el límite de liquidez. */
export const LIQUIDITY_AVG_VOLUME_DAYS = 20;

/** Tope del parámetro `limit` de `risk:list-vetoes`. */
export const RISK_VETOES_MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Vista agregada (evento risk:changed)
// ---------------------------------------------------------------------------

/** Estado completo del dominio; es el payload del evento `risk:changed`. */
export interface RiskOverview {
  limits: RiskLimits;
  killSwitch: KillSwitchState;
  caution: CautionState;
}
