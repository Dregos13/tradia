/**
 * Bróker de divisas y oro (OANDA v20) — contrato compartido.
 *
 * Alpaca solo opera acciones de EE. UU.; las divisas y el oro van por un
 * bróker propio, OANDA, en dos entornos con su ranura de claves:
 *
 * - 'practice' (`api-fxpractice.oanda.com`): dinero simulado, el primer
 *   paso. Se conecta sin requisitos previos.
 * - 'live' (`api-fxtrade.oanda.com`): dinero real. Conectar exige la
 *   lista de comprobación del modo real completa, y operar además la
 *   frase escrita con los límites exactos (`fxLiveConfirmationPhrase`).
 *
 * Reglas fijas (ver docs/broker.md, «Divisas y oro con OANDA»):
 *
 * - Solo cuatro instrumentos: EUR/USD, USD/JPY, GBP/USD y oro (XAU/USD).
 * - Toda orden que abre riesgo pasa por la pasarela única del motor de
 *   riesgo (`risk.submitSignal`) y después por los techos de esta fase
 *   (`FX_FIXED_CAPS`), en euros y pensados para empezar con muy poco
 *   capital (desde 50 €). Lleva siempre stop y objetivo adjuntos.
 * - Cerrar posiciones nunca se bloquea: reduce riesgo. La parada de
 *   emergencia cierra todas las posiciones de OANDA en los dos entornos.
 * - El token y el número de cuenta viven cifrados en `secrets`
 *   (`FX_BROKER_SECRET_KEYS`) y jamás salen del proceso principal.
 *
 * Solo tipos, constantes y funciones puras: lo comparten main y renderer.
 */

// ---------------------------------------------------------------------------
// Entornos e instrumentos
// ---------------------------------------------------------------------------

/** Entornos de OANDA: cuenta de práctica (simulada) y cuenta real. */
export const FX_BROKER_ENVIRONMENTS = ['practice', 'live'] as const;
export type FxBrokerEnvironment = (typeof FX_BROKER_ENVIRONMENTS)[number];

/** Nombre legible de cada entorno para la interfaz. */
export const FX_ENVIRONMENT_LABELS: Record<FxBrokerEnvironment, string> = {
  practice: 'Cuenta de práctica (dinero simulado)',
  live: 'Cuenta real (dinero real)',
};

/** Instrumentos que la app opera en OANDA, en su forma guardada. */
export const FX_BROKER_INSTRUMENTS = ['EURUSD', 'USDJPY', 'GBPUSD', 'XAUUSD'] as const;
export type FxBrokerInstrument = (typeof FX_BROKER_INSTRUMENTS)[number];

export interface FxInstrumentSpec {
  /** Nombre del instrumento en OANDA ('EUR_USD'). */
  oanda: string;
  /** Nombre para mostrar ('EUR/USD', 'Oro (XAU/USD)'). */
  label: string;
  /** Moneda en que cotiza el precio (y en la que sale el P&L). */
  quote: 'USD' | 'JPY';
  /** Decimales que admite OANDA en los precios (displayPrecision). */
  pricePrecision: number;
  /**
   * Margen que retiene el bróker por unidad, como fracción del nominal
   * (apalancamiento minorista europeo: 1:30 en los pares principales y
   * 1:20 en el oro).
   */
  marginRate: number;
  /** Unidades máximas por orden en esta fase (techo fijo). */
  maxUnits: number;
  /** Qué es una unidad, en palabras sencillas. */
  unitLabel: string;
}

export const FX_INSTRUMENT_SPECS: Record<FxBrokerInstrument, FxInstrumentSpec> = {
  EURUSD: {
    oanda: 'EUR_USD',
    label: 'EUR/USD',
    quote: 'USD',
    pricePrecision: 5,
    marginRate: 1 / 30,
    maxUnits: 5_000,
    unitLabel: '1 unidad = 1 euro',
  },
  USDJPY: {
    oanda: 'USD_JPY',
    label: 'USD/JPY',
    quote: 'JPY',
    pricePrecision: 3,
    marginRate: 1 / 30,
    maxUnits: 5_000,
    unitLabel: '1 unidad = 1 dólar',
  },
  GBPUSD: {
    oanda: 'GBP_USD',
    label: 'GBP/USD',
    quote: 'USD',
    pricePrecision: 5,
    marginRate: 1 / 30,
    maxUnits: 5_000,
    unitLabel: '1 unidad = 1 libra',
  },
  XAUUSD: {
    oanda: 'XAU_USD',
    label: 'Oro (XAU/USD)',
    quote: 'USD',
    pricePrecision: 3,
    marginRate: 1 / 20,
    maxUnits: 2,
    unitLabel: '1 unidad = 1 onza de oro',
  },
};

/** true si el símbolo (en cualquier capitalización, con o sin barra) es operable en OANDA. */
export function toFxBrokerInstrument(symbol: unknown): FxBrokerInstrument | null {
  if (typeof symbol !== 'string') return null;
  const clean = symbol
    .trim()
    .toUpperCase()
    .replace(/[/_\-\s]/g, '');
  return (FX_BROKER_INSTRUMENTS as readonly string[]).includes(clean)
    ? (clean as FxBrokerInstrument)
    : null;
}

/** 'EUR_USD' (nombre OANDA) → 'EURUSD'; null si no es uno de los cuatro. */
export function fromOandaInstrument(name: unknown): FxBrokerInstrument | null {
  if (typeof name !== 'string') return null;
  const found = FX_BROKER_INSTRUMENTS.find((symbol) => FX_INSTRUMENT_SPECS[symbol].oanda === name);
  return found ?? null;
}

// ---------------------------------------------------------------------------
// Credenciales
// ---------------------------------------------------------------------------

/**
 * Ranuras cifradas de `secrets`: una por entorno, separadas de las de
 * Alpaca. Un token de práctica nunca se guarda en la ranura real (ni al
 * revés): el servicio lo rechaza antes de guardar.
 */
export const FX_BROKER_SECRET_KEYS: Record<
  FxBrokerEnvironment,
  { token: string; accountId: string }
> = {
  practice: {
    token: 'broker-oanda-practice-token',
    accountId: 'broker-oanda-practice-account',
  },
  live: {
    token: 'broker-oanda-live-token',
    accountId: 'broker-oanda-live-account',
  },
};

/**
 * Token personal de OANDA: dos bloques de 32 caracteres hexadecimales
 * separados por un guion (así lo genera «Manage API Access»).
 */
export const OANDA_TOKEN_PATTERN = /^[a-f0-9]{32}-[a-f0-9]{32}$/i;

/** Número de cuenta v20 de OANDA: '101-004-1234567-001'. */
export const OANDA_ACCOUNT_PATTERN = /^\d{3}-\d{3}-\d{1,12}-\d{3}$/;

/**
 * Prefijo del número de cuenta según el entorno: las cuentas de
 * práctica empiezan por '101-' y las reales por '001-'. Es la primera
 * barrera contra mezclar ranuras; la segunda es que el servidor de cada
 * entorno rechaza (401) un token del otro.
 */
export const OANDA_ACCOUNT_PREFIX: Record<FxBrokerEnvironment, string> = {
  practice: '101-',
  live: '001-',
};

/** Entorno al que pertenece un número de cuenta por su prefijo; null si ninguno. */
export function oandaEnvironmentOfAccount(accountId: string): FxBrokerEnvironment | null {
  const trimmed = accountId.trim();
  if (trimmed.startsWith(OANDA_ACCOUNT_PREFIX.practice)) return 'practice';
  if (trimmed.startsWith(OANDA_ACCOUNT_PREFIX.live)) return 'live';
  return null;
}

/** Credenciales tal como entran por `fx-broker:connect` (y viven en `secrets`). */
export interface FxBrokerCredentials {
  token: string;
  accountId: string;
}

export interface FxBrokerConnectRequest extends FxBrokerCredentials {
  environment: FxBrokerEnvironment;
}

/**
 * Motivo legible por el que unas credenciales no valen para el entorno;
 * null si la forma es correcta (la cuenta se verifica después contra
 * OANDA). Nunca incluye el token en el texto.
 */
export function fxCredentialsProblem(request: FxBrokerConnectRequest): string | null {
  const token = request.token.trim();
  const account = request.accountId.trim();
  if (!OANDA_TOKEN_PATTERN.test(token)) {
    return 'El token no tiene la forma de OANDA: dos bloques de 32 letras y números separados por un guion.';
  }
  if (!OANDA_ACCOUNT_PATTERN.test(account)) {
    return 'El número de cuenta no tiene la forma de OANDA (por ejemplo, 101-004-1234567-001).';
  }
  const accountEnv = oandaEnvironmentOfAccount(account);
  if (accountEnv !== request.environment) {
    return request.environment === 'live'
      ? 'Esa cuenta es de práctica (empieza por 101-). En la ranura de dinero real solo vale una cuenta real (empieza por 001-).'
      : 'Esa cuenta es real (empieza por 001-). En la ranura de práctica solo vale una cuenta de práctica (empieza por 101-).';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Techos fijos y límites del usuario (en euros)
// ---------------------------------------------------------------------------

/**
 * Techos fijos para empezar con muy poco capital. Los límites que
 * escribe el usuario deben quedar dentro: el código nunca admite más.
 */
export const FX_FIXED_CAPS = {
  /** Capital mínimo con el que se puede empezar: 50 €. */
  capitalEurMin: 50,
  /**
   * Capital máximo comprometido en margen en esta fase: 500 €. Es la
   * garantía que retiene el bróker por las posiciones abiertas.
   */
  capitalEur: 500,
  /** Riesgo máximo por orden (lo que se pierde si salta el stop): 5 €. */
  riskPerOrderEur: 5,
  /** Riesgo mínimo configurable por orden: 0,10 €. */
  riskPerOrderEurMin: 0.1,
  /** Pérdida diaria máxima: 10 €. Al llegar no se abren más órdenes ese día. */
  dailyLossEur: 10,
  /** Pérdida diaria mínima configurable: 0,50 €. */
  dailyLossEurMin: 0.5,
  /** Posiciones abiertas a la vez: 2. */
  openPositions: 2,
} as const;
export type FxFixedCaps = typeof FX_FIXED_CAPS;

/** Límites del usuario (siempre dentro de los techos). */
export interface FxLimits {
  /** Capital máximo comprometido en margen (50–500 €). */
  capitalEur: number;
  /** Riesgo máximo por orden en euros (0,10–5 €). */
  riskPerOrderEur: number;
  /** Pérdida diaria máxima en euros (0,50–10 €). */
  dailyLossEur: number;
  /** Posiciones abiertas a la vez (1–2). */
  openPositions: number;
}

/** Límites de partida: lo mínimo para practicar con 50 €. */
export const FX_DEFAULT_LIMITS: FxLimits = {
  capitalEur: 50,
  riskPerOrderEur: 1,
  dailyLossEur: 3,
  openPositions: 1,
};

const isNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Motivos legibles por los que unos límites no valen; vacío si valen. */
export function fxLimitsProblems(limits: unknown): string[] {
  if (typeof limits !== 'object' || limits === null) return ['Faltan los límites.'];
  const v = limits as Record<string, unknown>;
  const problems: string[] = [];
  const caps = FX_FIXED_CAPS;
  if (!isNum(v.capitalEur) || v.capitalEur < caps.capitalEurMin || v.capitalEur > caps.capitalEur) {
    problems.push(`El capital debe estar entre ${caps.capitalEurMin} € y ${caps.capitalEur} €.`);
  }
  if (
    !isNum(v.riskPerOrderEur) ||
    v.riskPerOrderEur < caps.riskPerOrderEurMin ||
    v.riskPerOrderEur > caps.riskPerOrderEur
  ) {
    problems.push(
      `El riesgo por orden debe estar entre ${formatEur(caps.riskPerOrderEurMin)} y ${formatEur(caps.riskPerOrderEur)}.`,
    );
  }
  if (
    !isNum(v.dailyLossEur) ||
    v.dailyLossEur < caps.dailyLossEurMin ||
    v.dailyLossEur > caps.dailyLossEur
  ) {
    problems.push(
      `La pérdida diaria máxima debe estar entre ${formatEur(caps.dailyLossEurMin)} y ${formatEur(caps.dailyLossEur)}.`,
    );
  }
  if (
    !isNum(v.openPositions) ||
    !Number.isInteger(v.openPositions) ||
    v.openPositions < 1 ||
    v.openPositions > caps.openPositions
  ) {
    problems.push(`Las posiciones a la vez deben ser entre 1 y ${caps.openPositions}.`);
  }
  if (
    problems.length === 0 &&
    isNum(v.riskPerOrderEur) &&
    isNum(v.dailyLossEur) &&
    v.riskPerOrderEur > v.dailyLossEur
  ) {
    problems.push('El riesgo por orden no puede ser mayor que la pérdida diaria máxima.');
  }
  return problems;
}

/** Importe en euros con coma decimal: 1 → '1 €', 0.5 → '0,50 €'. */
export function formatEur(value: number): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',');
  return `${text} €`;
}

const phraseEur = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

/**
 * Frase que el usuario escribe para operar la cuenta real de OANDA;
 * cambia si cambia cualquier límite. Se compara tras recortar extremos.
 */
export function fxLiveConfirmationPhrase(limits: FxLimits): string {
  const positions =
    limits.openPositions === 1 ? '1 POSICIÓN' : `${limits.openPositions} POSICIONES`;
  return (
    `OPERO DIVISAS CON DINERO REAL: ${phraseEur(limits.capitalEur)} EUR, ` +
    `${phraseEur(limits.riskPerOrderEur)} EUR DE RIESGO POR ORDEN, ` +
    `${phraseEur(limits.dailyLossEur)} EUR DE PÉRDIDA DIARIA Y ${positions}`
  );
}

// ---------------------------------------------------------------------------
// Estado y operaciones (IPC)
// ---------------------------------------------------------------------------

export type FxConnectionState = 'desconectada' | 'conectada' | 'error';

/** Cuenta de OANDA tal como la ve la interfaz (sin token). */
export interface FxAccountSummary {
  /** Número de cuenta enmascarado ('•••-001'). */
  accountMasked: string;
  /** Divisa de la cuenta ('EUR', 'USD'). */
  currency: string;
  /** Saldo (efectivo) en la divisa de la cuenta. */
  balance: number;
  /** Valor de la cuenta con lo no realizado (NAV). */
  nav: number;
  /** Margen retenido por las posiciones abiertas. */
  marginUsed: number;
  /** Resultado no realizado de las posiciones abiertas. */
  unrealizedPnl: number;
  openPositions: number;
}

/** Posición abierta para la tabla de la interfaz. */
export interface FxPositionView {
  instrument: FxBrokerInstrument;
  label: string;
  side: 'long' | 'short';
  units: number;
  avgPrice: number;
  unrealizedPnl: number | null;
}

/** Estado de un entorno (`fx-broker:status`). */
export interface FxEnvironmentStatus {
  environment: FxBrokerEnvironment;
  state: FxConnectionState;
  /** Hay token y cuenta guardados (cifrados) en la ranura del entorno. */
  hasCredentials: boolean;
  account: FxAccountSummary | null;
  positions: FxPositionView[];
  /** Motivo legible del último fallo; null si no hay. */
  error: string | null;
  checkedAt: string | null;
  /** Usa el bróker simulado (solo E2E). */
  simulated: boolean;
}

/** Última conciliación app ↔ OANDA de un entorno. */
export interface FxReconcileSummary {
  environment: FxBrokerEnvironment;
  at: string;
  ok: boolean;
  /** Descuadres legibles en español; vacío si cuadró. */
  discrepancies: string[];
  error: string | null;
}

export interface FxBrokerStatus {
  practice: FxEnvironmentStatus;
  live: FxEnvironmentStatus;
  limits: FxLimits;
  caps: FxFixedCaps;
  /** Límites confirmados con la frase para la cuenta real. */
  liveConfirmed: boolean;
  /** Lista de comprobación del modo real completa (puerta de la cuenta real). */
  liveGateOpen: boolean;
  /** Parada de emergencia activa: no se abre ninguna orden. */
  killSwitchActive: boolean;
  lastReconcile: Partial<Record<FxBrokerEnvironment, FxReconcileSummary>>;
}

/** Petición de una orden a mercado con stop y objetivo adjuntos. */
export interface FxOrderRequest {
  environment: FxBrokerEnvironment;
  instrument: FxBrokerInstrument;
  side: 'buy' | 'sell';
  /**
   * Tamaño: en unidades (`units`) o en euros de riesgo (`riskEur`, el
   * proceso principal calcula las unidades con la distancia al stop).
   */
  size: { units: number } | { riskEur: number };
  /** Precio del stop de protección (obligatorio). */
  stopPrice: number;
  /** Precio del objetivo (obligatorio). */
  targetPrice: number;
}

export interface FxOrderResult {
  ok: boolean;
  /** Motivos del rechazo (motor de riesgo, techos o bróker); vacío si ok. */
  reasons: string[];
  /** Unidades enviadas; 0 si no salió. */
  units: number;
  /** Euros que se pierden si salta el stop; null si no se calculó. */
  riskEur: number | null;
  /** Precio medio de ejecución; null si no se ejecutó. */
  fillPrice: number | null;
  clientOrderId: string | null;
  status: FxBrokerStatus;
}

/** Orden mínima de prueba: 1 unidad de EUR/USD, se abre y se cierra. */
export const FX_TEST_ORDER = {
  instrument: 'EURUSD' as FxBrokerInstrument,
  units: 1,
  /** Stop a 0,20 % y objetivo a 0,40 % del precio (ratio 2:1). */
  stopPct: 0.2,
  targetPct: 0.4,
} as const;

export interface FxTestOrderRequest {
  environment: FxBrokerEnvironment;
  confirm: true;
}

export type FxTestStep = 'precio' | 'riesgo' | 'compra' | 'cierre' | 'conciliacion';

export interface FxTestOrderResult {
  ok: boolean;
  /** Pasos completados, en orden. */
  steps: FxTestStep[];
  /** Explicación sencilla de lo que pasó. */
  summary: string;
  error: string | null;
  buyPrice: number | null;
  closePrice: number | null;
  /** Resultado de abrir y cerrar en la divisa de la cuenta (el diferencial). */
  pnl: number | null;
  status: FxBrokerStatus;
}

export interface FxConfirmLiveRequest {
  phrase: string;
}

export interface FxCloseRequest {
  environment: FxBrokerEnvironment;
  instrument: FxBrokerInstrument;
}

/** Solo E2E: el bróker simulado sustituye a OANDA en los dos entornos. */
export interface FxSimulatedBrokerRequest {
  enabled: boolean;
}
