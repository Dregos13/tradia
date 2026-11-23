/**
 * Servicio del bróker de divisas y oro (OANDA) en el proceso principal.
 *
 * - Conexión por entorno ('practice' y 'live'), cada uno con su ranura
 *   cifrada en `secrets` (`FX_BROKER_SECRET_KEYS`). Antes de guardar se
 *   comprueba la forma del token y de la cuenta, que el número de
 *   cuenta sea del entorno (101- práctica, 001- real) y que el servidor
 *   de ESE entorno los acepte: un token de práctica no entra en la
 *   ranura real ni al revés. La cuenta real además exige la lista de
 *   comprobación del modo real completa.
 * - Órdenes: toda orden que abre riesgo pasa por la pasarela única del
 *   motor de riesgo (`submitSignal`) y después por los techos en euros
 *   (`checkFxOrder`). Sale a mercado con stop y objetivo adjuntos y se
 *   registra en `broker_orders_fx_<entorno>` (migración 021) con el
 *   mismo ciclo que las de Alpaca (pendiente → ejecutada/rechazada;
 *   un tiempo agotado se resuelve buscando por `clientOrderId`).
 * - Cerrar posiciones nunca se bloquea. La parada de emergencia cierra
 *   todas las posiciones de OANDA de los dos entornos.
 * - Conciliación: compara las órdenes registradas con las posiciones y
 *   órdenes abiertas que reporta OANDA (`reconcileBrokerState`).
 */
import {
  FX_BROKER_ENVIRONMENTS,
  FX_BROKER_SECRET_KEYS,
  FX_DEFAULT_LIMITS,
  FX_FIXED_CAPS,
  FX_INSTRUMENT_SPECS,
  FX_TEST_ORDER,
  fxCredentialsProblem,
  fxLimitsProblems,
  fxLiveConfirmationPhrase,
  type FxAccountSummary,
  type FxBrokerConnectRequest,
  type FxBrokerCredentials,
  type FxBrokerEnvironment,
  type FxBrokerInstrument,
  type FxBrokerStatus,
  type FxCloseRequest,
  type FxConfirmLiveRequest,
  type FxEnvironmentStatus,
  type FxLimits,
  type FxOrderRequest,
  type FxOrderResult,
  type FxPositionView,
  type FxReconcileSummary,
  type FxTestOrderRequest,
  type FxTestOrderResult,
  type FxTestStep,
} from '../../shared/fxBroker';
import type { JournalRecordInput } from '../../shared/journal';
import type { RiskDecision, SignalIntent, VetoReasonCode } from '../../shared/risk';
import type { BrokerSecretsStore } from '../broker/index';
import type { OandaAdapter, OandaPrice } from '../broker/oanda';
import { reconcileBrokerState } from '../broker/reconcile';
import type { BrokerRepository } from '../broker/repository';
import { BrokerError, isBrokerError } from '../broker/types';
import { accountToEur, checkFxOrder, eurPerQuoteOf, notionalEurPerUnitOf } from './guard';

/** Claves de settings donde vive el estado no secreto del servicio. */
export const FX_SETTINGS_KEYS = {
  limits: 'fxBroker.limits',
  liveConfirmed: 'fxBroker.liveConfirmed',
  dayStart: 'fxBroker.dayStart',
} as const;

/**
 * Vetos del motor que dependen del TAMAÑO que el motor calcula con el
 * capital de la cartera simulada (exposición, correlación,
 * apalancamiento, liquidez, número de posiciones y tamaño cero), más el
 * «solo análisis» de los pares no cotizados en USD, que es una regla de
 * la cartera interna (OANDA liquida USD/JPY en la divisa de la cuenta).
 * En OANDA el tamaño lo fijan los techos en euros (`checkFxOrder`),
 * mucho más estrictos, así que estos no aplican. El resto —parada,
 * stop, ratio beneficio/riesgo, cautela, pérdidas y drawdown, señal
 * inválida— se respetan siempre.
 */
const SIZE_DEPENDENT_VETOES: ReadonlySet<VetoReasonCode> = new Set<VetoReasonCode>([
  'SIZE_ZERO',
  'MAX_POSITIONS',
  'ASSET_EXPOSURE',
  'SECTOR_EXPOSURE',
  'CURRENCY_EXPOSURE',
  'CORRELATION',
  'LEVERAGE',
  'LIQUIDITY',
  'ANALYSIS_ONLY',
]);

/** Motivos del veto del motor que valen para una orden de OANDA; vacío si pasa. */
export function fxApplicableVetoes(decision: RiskDecision): RiskDecision['reasons'] {
  if (decision.status !== 'vetada') return [];
  return decision.reasons.filter((reason) => !SIZE_DEPENDENT_VETOES.has(reason.code));
}

export interface FxSettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface FxBrokerServiceDeps {
  secrets: BrokerSecretsStore;
  repositories: Record<FxBrokerEnvironment, BrokerRepository>;
  /**
   * Crea el adaptador del entorno (real o simulado). Para 'live' lanza
   * si la lista de comprobación no está completa.
   */
  createAdapter(
    environment: FxBrokerEnvironment,
    getCredentials: () => Promise<FxBrokerCredentials | null>,
  ): OandaAdapter;
  /** Pasarela única del motor de riesgo; null si el motor no está disponible. */
  submitSignal(intent: SignalIntent): RiskDecision | null;
  isLiveGateOpen(): boolean;
  isKillSwitchActive(): boolean;
  isOnline(): boolean;
  settings: FxSettingsStore;
  /** true si el adaptador en uso es el bróker simulado (E2E). */
  isSimulated?(): boolean;
  recordJournal?(input: JournalRecordInput): void;
  broadcast?(channel: string, payload: unknown): void;
  now?(): number;
  logger?: { warn(message: string): void };
}

export interface FxBrokerService {
  getStatus(): Promise<FxBrokerStatus>;
  connect(request: FxBrokerConnectRequest): Promise<FxBrokerStatus>;
  disconnect(environment: FxBrokerEnvironment): Promise<FxBrokerStatus>;
  setLimits(limits: FxLimits): Promise<FxBrokerStatus>;
  confirmLive(request: FxConfirmLiveRequest): Promise<FxBrokerStatus>;
  placeOrder(request: FxOrderRequest): Promise<FxOrderResult>;
  closePosition(request: FxCloseRequest): Promise<FxBrokerStatus>;
  runTestOrder(request: FxTestOrderRequest): Promise<FxTestOrderResult>;
  reconcile(environment: FxBrokerEnvironment): Promise<FxReconcileSummary>;
  /** `risk:changed`: con la parada activa cierra todas las posiciones. */
  handleRiskChanged(payload: unknown): void;
  /** Reconecta los entornos con claves guardadas (live solo con la puerta abierta). */
  restore(): Promise<void>;
  /** Olvida los adaptadores (p. ej. al conmutar el bróker simulado). */
  resetAdapters(): void;
}

interface EnvState {
  adapter: OandaAdapter | null;
  error: string | null;
  checkedAt: string | null;
  account: FxAccountSummary | null;
  positions: FxPositionView[];
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const maskAccount = (accountId: string): string => `•••-${accountId.slice(-3)}`;

/** Texto sencillo para quien empieza a partir de un error del bróker. */
function friendlyError(error: unknown, environment: FxBrokerEnvironment): string {
  if (isBrokerError(error)) {
    const where = environment === 'practice' ? 'de práctica' : 'real';
    switch (error.kind) {
      case 'auth':
        return `OANDA no aceptó el token o la cuenta. Comprueba que los dos son de tu cuenta ${where} (un token de práctica no sirve en la real, ni al revés).`;
      case 'network':
      case 'timeout':
        return 'No se pudo hablar con OANDA. Revisa tu conexión a internet y vuelve a intentarlo.';
      case 'rate-limit':
        return 'OANDA pide esperar unos segundos antes de la siguiente petición.';
      case 'server':
        return 'OANDA tiene un problema en este momento. Vuelve a intentarlo en unos minutos.';
      default:
        return error.message.replace(/^OANDA [^:]+: /, '');
    }
  }
  return errorMessage(error);
}

export function createFxBrokerService(deps: FxBrokerServiceDeps): FxBrokerService {
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();
  const logger = deps.logger ?? console;
  const envs: Record<FxBrokerEnvironment, EnvState> = {
    practice: { adapter: null, error: null, checkedAt: null, account: null, positions: [] },
    live: { adapter: null, error: null, checkedAt: null, account: null, positions: [] },
  };
  const lastReconcile: Partial<Record<FxBrokerEnvironment, FxReconcileSummary>> = {};
  let orderSeq = 0;

  // -------------------------------------------------------------------------
  // Ajustes no secretos
  // -------------------------------------------------------------------------

  const readJson = <T>(key: string): T | null => {
    const raw = deps.settings.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  const getLimits = (): FxLimits => {
    const saved = readJson<FxLimits>(FX_SETTINGS_KEYS.limits);
    return saved && fxLimitsProblems(saved).length === 0 ? saved : FX_DEFAULT_LIMITS;
  };
  const liveConfirmed = (): boolean => {
    const saved = readJson<{ phrase: string }>(FX_SETTINGS_KEYS.liveConfirmed);
    return saved !== null && saved.phrase === fxLiveConfirmationPhrase(getLimits());
  };
  /** Día de mercado (UTC) y valor de la cuenta al empezarlo, por entorno. */
  const dayStartNav = (environment: FxBrokerEnvironment, navEur: number): number => {
    const today = isoNow().slice(0, 10);
    const all =
      readJson<Record<string, { day: string; navEur: number }>>(FX_SETTINGS_KEYS.dayStart) ?? {};
    const entry = all[environment];
    if (entry && entry.day === today && Number.isFinite(entry.navEur)) return entry.navEur;
    all[environment] = { day: today, navEur };
    deps.settings.set(FX_SETTINGS_KEYS.dayStart, JSON.stringify(all));
    return navEur;
  };

  // -------------------------------------------------------------------------
  // Credenciales y adaptadores
  // -------------------------------------------------------------------------

  const readCredentials = async (
    environment: FxBrokerEnvironment,
  ): Promise<FxBrokerCredentials | null> => {
    const slot = FX_BROKER_SECRET_KEYS[environment];
    const [token, accountId] = await Promise.all([
      deps.secrets.getKey(slot.token),
      deps.secrets.getKey(slot.accountId),
    ]);
    return token && accountId ? { token, accountId } : null;
  };

  const hasCredentials = (environment: FxBrokerEnvironment): Promise<boolean> =>
    deps.secrets.hasKey(FX_BROKER_SECRET_KEYS[environment].token);

  const adapterFor = (environment: FxBrokerEnvironment): OandaAdapter => {
    const state = envs[environment];
    if (!state.adapter) {
      throw new BrokerError(
        'auth',
        environment === 'practice'
          ? 'Conecta primero tu cuenta de práctica de OANDA.'
          : 'Conecta primero tu cuenta real de OANDA.',
        { adapter: `oanda-${environment}` },
      );
    }
    return state.adapter;
  };

  const refresh = async (environment: FxBrokerEnvironment): Promise<void> => {
    const state = envs[environment];
    if (!state.adapter) return;
    try {
      const [details, positions] = await Promise.all([
        state.adapter.getAccountDetails(),
        state.adapter.listPositions(),
      ]);
      state.account = {
        accountMasked: maskAccount(details.accountId),
        currency: details.currency,
        balance: details.balance,
        nav: details.nav,
        marginUsed: details.marginUsed,
        unrealizedPnl: details.unrealizedPnl,
        openPositions: details.openPositionCount,
      };
      state.positions = positions.map((p) => {
        const instrument = p.ticker as FxBrokerInstrument;
        return {
          instrument,
          label: FX_INSTRUMENT_SPECS[instrument].label,
          side: p.side,
          units: p.quantity,
          avgPrice: p.avgEntryPrice,
          unrealizedPnl: p.unrealizedPnl,
        };
      });
      state.error = null;
      state.checkedAt = isoNow();
    } catch (error) {
      state.error = friendlyError(error, environment);
    }
  };

  const envStatus = async (environment: FxBrokerEnvironment): Promise<FxEnvironmentStatus> => {
    const state = envs[environment];
    return {
      environment,
      state: state.adapter
        ? state.error
          ? 'error'
          : 'conectada'
        : state.error
          ? 'error'
          : 'desconectada',
      hasCredentials: await hasCredentials(environment),
      account: state.adapter ? state.account : null,
      positions: state.adapter ? state.positions : [],
      error: state.error,
      checkedAt: state.checkedAt,
      simulated: deps.isSimulated?.() ?? false,
    };
  };

  const status = async (): Promise<FxBrokerStatus> => ({
    practice: await envStatus('practice'),
    live: await envStatus('live'),
    limits: getLimits(),
    caps: FX_FIXED_CAPS,
    liveConfirmed: liveConfirmed(),
    liveGateOpen: deps.isLiveGateOpen(),
    killSwitchActive: deps.isKillSwitchActive(),
    lastReconcile: { ...lastReconcile },
  });

  const changed = async (): Promise<FxBrokerStatus> => {
    const next = await status();
    deps.broadcast?.('fx-broker:changed', next);
    return next;
  };

  const journal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal?.(input);
    } catch (error) {
      logger.warn(`[fx-broker] no se pudo anotar en el Diario: ${errorMessage(error)}`);
    }
  };

  // -------------------------------------------------------------------------
  // Órdenes
  // -------------------------------------------------------------------------

  const newClientOrderId = (kind: string): string =>
    `tradia-fx-${kind}-${now().toString(36)}-${(++orderSeq).toString(36)}`;

  const pricesFor = async (
    adapter: OandaAdapter,
    instrument: FxBrokerInstrument,
  ): Promise<{ target: OandaPrice; eurUsd: number; usdJpy: number }> => {
    const prices = await adapter.getPrices([instrument, 'EURUSD', 'USDJPY']);
    const target = prices.get(instrument);
    const eurUsd = prices.get('EURUSD')?.mid;
    const usdJpy = prices.get('USDJPY')?.mid;
    if (!target || eurUsd === undefined || usdJpy === undefined) {
      throw new BrokerError('bad-data', 'OANDA no devolvió el precio actual.', {
        adapter: adapter.id,
      });
    }
    return { target, eurUsd, usdJpy };
  };

  /** Envía y registra la orden ya validada; resuelve un tiempo agotado por clientOrderId. */
  const sendAndRecord = async (
    environment: FxBrokerEnvironment,
    adapter: OandaAdapter,
    order: {
      clientOrderId: string;
      instrument: FxBrokerInstrument;
      side: 'buy' | 'sell';
      units: number;
      requestedPrice: number;
      stop: number | null;
      target: number | null;
    },
  ): Promise<{ fillPrice: number | null; error: string | null }> => {
    const repo = deps.repositories[environment];
    const requestedAt = isoNow();
    const { order: local } = repo.insertOrder({
      clientOrderId: order.clientOrderId,
      ticker: order.instrument,
      type: 'market',
      side: order.side,
      quantity: order.units,
      stopPrice: order.stop,
      limitPrice: order.target,
      requestedPrice: order.requestedPrice,
      requestedAt,
      status: 'pendiente',
      attempts: 1,
    });
    const finish = (
      fill: { price: number | null; at: string | null; units: number } | null,
      reason?: string,
    ) => {
      repo.updateOrder(
        local.id,
        fill && fill.price !== null
          ? {
              status: 'ejecutada',
              filledQuantity: fill.units,
              executedPrice: fill.price,
              executedAt: fill.at ?? isoNow(),
            }
          : { status: 'rechazada', rejectReason: reason ?? 'sin ejecución' },
        isoNow(),
      );
    };
    try {
      const remote = await adapter.submitOrder({
        clientOrderId: order.clientOrderId,
        ticker: order.instrument,
        type: 'market',
        side: order.side,
        quantity: order.units,
        stopLossOnFill: order.stop,
        takeProfitOnFill: order.target,
      });
      repo.updateOrder(local.id, { brokerOrderId: remote.brokerOrderId }, isoNow());
      finish({ price: remote.filledAvgPrice, at: remote.filledAt, units: remote.filledQuantity });
      return { fillPrice: remote.filledAvgPrice, error: null };
    } catch (error) {
      if (isBrokerError(error, 'timeout') || isBrokerError(error, 'network')) {
        // La orden pudo llegar: se busca por su id antes de darla por perdida.
        try {
          const found = await adapter.getOrderByClientId(order.clientOrderId);
          if (found && found.status === 'ejecutada') {
            repo.updateOrder(local.id, { brokerOrderId: found.brokerOrderId }, isoNow());
            finish({
              price: found.filledAvgPrice,
              at: found.filledAt,
              units: found.filledQuantity,
            });
            return { fillPrice: found.filledAvgPrice, error: null };
          }
          if (found === null) {
            finish(null, friendlyError(error, environment));
            return { fillPrice: null, error: friendlyError(error, environment) };
          }
        } catch {
          // Sigue sin saberse: la orden queda huérfana y la conciliación la mirará.
        }
        repo.updateOrder(
          local.id,
          { status: 'huerfana', rejectReason: errorMessage(error) },
          isoNow(),
        );
        return {
          fillPrice: null,
          error:
            'No se sabe si la orden llegó a OANDA. Revisa las posiciones y concilia antes de repetir.',
        };
      }
      finish(null, friendlyError(error, environment));
      return { fillPrice: null, error: friendlyError(error, environment) };
    }
  };

  /** Registra un cierre hecho en OANDA para que la conciliación cuadre. */
  const recordClose = (
    environment: FxBrokerEnvironment,
    instrument: FxBrokerInstrument,
    side: 'long' | 'short',
    units: number,
    price: number | null,
  ): void => {
    if (units <= 0 || price === null) return;
    const at = isoNow();
    deps.repositories[environment].insertOrder({
      clientOrderId: newClientOrderId('cierre'),
      ticker: instrument,
      type: 'market',
      side: side === 'long' ? 'sell' : 'buy',
      quantity: units,
      filledQuantity: units,
      requestedPrice: price,
      executedPrice: price,
      requestedAt: at,
      executedAt: at,
      status: 'ejecutada',
      attempts: 1,
    });
  };

  const placeOrder = async (request: FxOrderRequest): Promise<FxOrderResult> => {
    const { environment, instrument } = request;
    const spec = FX_INSTRUMENT_SPECS[instrument];
    const rejected = async (
      reasons: string[],
      riskEur: number | null = null,
    ): Promise<FxOrderResult> => ({
      ok: false,
      reasons,
      units: 0,
      riskEur,
      fillPrice: null,
      clientOrderId: null,
      status: await status(),
    });
    let adapter: OandaAdapter;
    try {
      adapter = adapterFor(environment);
    } catch (error) {
      return rejected([errorMessage(error)]);
    }
    if (deps.isKillSwitchActive()) {
      return rejected(['La parada de emergencia está activa: no se abren órdenes.']);
    }
    let prices: Awaited<ReturnType<typeof pricesFor>>;
    let details: Awaited<ReturnType<OandaAdapter['getAccountDetails']>>;
    let positions: Awaited<ReturnType<OandaAdapter['listPositions']>>;
    try {
      [prices, details, positions] = await Promise.all([
        pricesFor(adapter, instrument),
        adapter.getAccountDetails(),
        adapter.listPositions(),
      ]);
    } catch (error) {
      return rejected([friendlyError(error, environment)]);
    }
    if (!prices.target.tradeable) {
      return rejected([
        `${spec.label} no cotiza ahora mismo (mercado cerrado). Prueba en horario de mercado.`,
      ]);
    }
    const entry = request.side === 'buy' ? prices.target.ask : prices.target.bid;

    // Pasarela única del motor de riesgo: la idea tiene que ser aceptable
    // (stop, ratio, cautela, parada, límites de la cartera) antes de que
    // los techos decidan cuánto arriesgar.
    const decision = deps.submitSignal({
      ticker: instrument,
      direction: request.side === 'buy' ? 'largo' : 'corto',
      entry,
      stop: request.stopPrice,
      target: request.targetPrice,
      confidence: 1,
      origin: 'probador',
    });
    if (decision === null) {
      return rejected(['El motor de riesgo no está disponible: no se envían órdenes sin él.']);
    }
    const vetoes = fxApplicableVetoes(decision);
    if (vetoes.length > 0) {
      return rejected(vetoes.map((r) => `Motor de riesgo: ${r.message}`));
    }

    const navEur = accountToEur(details.nav, details.currency, prices.eurUsd);
    const marginEur = accountToEur(details.marginUsed, details.currency, prices.eurUsd);
    if (navEur === null || marginEur === null) {
      return rejected([
        `La cuenta está en ${details.currency}; Tradia solo admite cuentas en EUR o USD.`,
      ]);
    }
    const guard = checkFxOrder({
      environment,
      instrument,
      side: request.side,
      size: request.size,
      entryPrice: entry,
      stopPrice: request.stopPrice,
      targetPrice: request.targetPrice,
      eurPerQuote: eurPerQuoteOf(instrument, prices.eurUsd, prices.usdJpy),
      notionalEurPerUnit: notionalEurPerUnitOf(instrument, entry, prices.eurUsd, prices.usdJpy),
      limits: getLimits(),
      liveGateOpen: deps.isLiveGateOpen(),
      liveConfirmed: liveConfirmed(),
      killSwitchActive: deps.isKillSwitchActive(),
      online: deps.isOnline(),
      marginUsedEur: marginEur,
      navEur,
      dayStartNavEur: dayStartNav(environment, navEur),
      openInstruments: [...new Set(positions.map((p) => p.ticker as FxBrokerInstrument))],
    });
    if (!guard.ok) return rejected(guard.reasons);
    // El motor puede reducir el tamaño por cautela (p. ej. a la mitad):
    // el mismo factor se aplica a las unidades de OANDA; nunca se envía más.
    const factor =
      decision.status === 'reducida' && decision.sizeFactor > 0 && decision.sizeFactor < 1
        ? decision.sizeFactor
        : 1;
    const units = Math.max(1, Math.floor(guard.units * factor));

    const clientOrderId = newClientOrderId('orden');
    const sent = await sendAndRecord(environment, adapter, {
      clientOrderId,
      instrument,
      side: request.side,
      units,
      requestedPrice: entry,
      stop: request.stopPrice,
      target: request.targetPrice,
    });
    await refresh(environment);
    journal({
      type: 'operacion',
      mode: environment === 'live' ? 'live' : 'paper',
      ticker: instrument,
      reason: sent.error
        ? `OANDA ${environment === 'live' ? 'real' : 'práctica'}: orden de ${units} uds de ${spec.label} no ejecutada — ${sent.error}`
        : `OANDA ${environment === 'live' ? 'real' : 'práctica'}: ${request.side === 'buy' ? 'compra' : 'venta'} de ${units} uds de ${spec.label} a ${sent.fillPrice} con stop ${request.stopPrice} y objetivo ${request.targetPrice}`,
      dataUsed: { clientOrderId, riskEur: guard.riskEur, marginEur: guard.marginEur },
    });
    const next = await changed();
    return {
      ok: sent.error === null,
      reasons: sent.error ? [sent.error] : [],
      units,
      riskEur: guard.riskEur,
      fillPrice: sent.fillPrice,
      clientOrderId,
      status: next,
    };
  };

  const closeInstrument = async (
    environment: FxBrokerEnvironment,
    instrument: FxBrokerInstrument,
  ): Promise<{ units: number; price: number | null; pnl: number | null }> => {
    const adapter = adapterFor(environment);
    const before = (await adapter.listPositions()).filter((p) => p.ticker === instrument);
    const result = await adapter.closePosition(instrument);
    for (const position of before) {
      recordClose(environment, instrument, position.side, position.quantity, result.fillPrice);
    }
    return { units: result.units, price: result.fillPrice, pnl: result.realizedPnl };
  };

  const reconcile = async (environment: FxBrokerEnvironment): Promise<FxReconcileSummary> => {
    const at = isoNow();
    let summary: FxReconcileSummary;
    try {
      const adapter = adapterFor(environment);
      const [brokerPositions, brokerOpenOrders] = await Promise.all([
        adapter.listPositions(),
        adapter.listOrders({ openOnly: true }),
      ]);
      const comparison = reconcileBrokerState(
        {
          appOrders: deps.repositories[environment].listOrders({ limit: 500 }),
          brokerPositions,
          brokerOpenOrders,
        },
        // Los precios de divisas tienen 3–5 decimales: tolerancia de una milésima.
        { nowMs: now(), priceTolerance: 0.001 },
      );
      summary = {
        environment,
        at,
        ok: comparison.discrepancies.length === 0,
        discrepancies: comparison.discrepancies.map((d) => d.detail.replace(/broker/g, 'OANDA')),
        error: null,
      };
    } catch (error) {
      summary = {
        environment,
        at,
        ok: false,
        discrepancies: [],
        error: friendlyError(error, environment),
      };
    }
    lastReconcile[environment] = summary;
    return summary;
  };

  const closeAll = async (cause: string): Promise<void> => {
    for (const environment of FX_BROKER_ENVIRONMENTS) {
      const adapter = envs[environment].adapter;
      if (!adapter) continue;
      const positions = await adapter.listPositions();
      for (const instrument of new Set(positions.map((p) => p.ticker as FxBrokerInstrument))) {
        try {
          await closeInstrument(environment, instrument);
          journal({
            type: 'operacion',
            mode: environment === 'live' ? 'live' : 'paper',
            ticker: instrument,
            reason: `Parada de emergencia (${cause}): posición de ${FX_INSTRUMENT_SPECS[instrument].label} cerrada en OANDA.`,
          });
        } catch (error) {
          logger.warn(
            `[fx-broker] no se pudo cerrar ${instrument} tras la parada: ${errorMessage(error)}`,
          );
        }
      }
      await refresh(environment);
    }
    await changed();
  };

  return {
    getStatus: async () => {
      await Promise.all(FX_BROKER_ENVIRONMENTS.map((env) => refresh(env)));
      return status();
    },

    connect: async (request) => {
      const { environment } = request;
      const state = envs[environment];
      const problem = fxCredentialsProblem(request);
      if (problem) {
        state.error = problem;
        return changed();
      }
      if (environment === 'live' && !deps.isLiveGateOpen()) {
        state.error =
          'Completa la lista de comprobación de Dinero real antes de conectar la cuenta real.';
        return changed();
      }
      const creds: FxBrokerCredentials = {
        token: request.token.trim(),
        accountId: request.accountId.trim(),
      };
      try {
        const adapter = deps.createAdapter(environment, async () => creds);
        const details = await adapter.getAccountDetails();
        if (details.accountId !== creds.accountId) {
          throw new Error('OANDA devolvió otra cuenta distinta de la indicada.');
        }
        if (details.currency !== 'EUR' && details.currency !== 'USD') {
          throw new Error(
            `La cuenta está en ${details.currency}; Tradia solo admite cuentas en EUR o USD.`,
          );
        }
        const slot = FX_BROKER_SECRET_KEYS[environment];
        await deps.secrets.setKey(slot.token, creds.token);
        await deps.secrets.setKey(slot.accountId, creds.accountId);
        state.adapter = deps.createAdapter(environment, () => readCredentials(environment));
        state.error = null;
        await refresh(environment);
      } catch (error) {
        let reason = friendlyError(error, environment);
        reason = reason.split(creds.token).join('[oculto]');
        state.error = reason;
      }
      return changed();
    },

    disconnect: async (environment) => {
      const slot = FX_BROKER_SECRET_KEYS[environment];
      await deps.secrets.deleteKey(slot.token);
      await deps.secrets.deleteKey(slot.accountId);
      envs[environment] = {
        adapter: null,
        error: null,
        checkedAt: null,
        account: null,
        positions: [],
      };
      return changed();
    },

    setLimits: async (limits) => {
      const problems = fxLimitsProblems(limits);
      if (problems.length > 0) throw new Error(problems.join(' '));
      deps.settings.set(FX_SETTINGS_KEYS.limits, JSON.stringify(limits));
      return changed();
    },

    confirmLive: async (request) => {
      const expected = fxLiveConfirmationPhrase(getLimits());
      if (request.phrase.trim() !== expected) {
        throw new Error('La frase no coincide. Escríbela exactamente como aparece.');
      }
      deps.settings.set(
        FX_SETTINGS_KEYS.liveConfirmed,
        JSON.stringify({ phrase: expected, at: isoNow() }),
      );
      return changed();
    },

    placeOrder,

    closePosition: async ({ environment, instrument }) => {
      await closeInstrument(environment, instrument);
      await refresh(environment);
      return changed();
    },

    runTestOrder: async ({ environment }) => {
      const steps: FxTestStep[] = [];
      const done = async (
        ok: boolean,
        summary: string,
        error: string | null,
        extra: Partial<FxTestOrderResult> = {},
      ): Promise<FxTestOrderResult> => ({
        ok,
        steps: [...steps],
        summary,
        error,
        buyPrice: null,
        closePrice: null,
        pnl: null,
        ...extra,
        status: await changed(),
      });
      let adapter: OandaAdapter;
      try {
        adapter = adapterFor(environment);
      } catch (error) {
        return done(false, 'No hay cuenta conectada.', errorMessage(error));
      }
      let price: OandaPrice;
      try {
        price = (await pricesFor(adapter, FX_TEST_ORDER.instrument)).target;
      } catch (error) {
        return done(
          false,
          'No se pudo leer el precio de EUR/USD.',
          friendlyError(error, environment),
        );
      }
      steps.push('precio');
      const stop = price.ask * (1 - FX_TEST_ORDER.stopPct / 100);
      const target = price.ask * (1 + FX_TEST_ORDER.targetPct / 100);
      const order = await placeOrder({
        environment,
        instrument: FX_TEST_ORDER.instrument,
        side: 'buy',
        size: { units: FX_TEST_ORDER.units },
        stopPrice: stop,
        targetPrice: target,
      });
      if (!order.ok) {
        if (order.clientOrderId === null) {
          return done(
            false,
            'La orden de prueba no pasó los controles de riesgo.',
            order.reasons.join(' '),
          );
        }
        steps.push('riesgo');
        return done(false, 'OANDA no ejecutó la orden de prueba.', order.reasons.join(' '));
      }
      steps.push('riesgo', 'compra');
      let closed: Awaited<ReturnType<typeof closeInstrument>>;
      try {
        closed = await closeInstrument(environment, FX_TEST_ORDER.instrument);
      } catch (error) {
        return done(
          false,
          'Se compró 1 € de EUR/USD pero no se pudo cerrar: ciérralo desde la tabla de posiciones.',
          friendlyError(error, environment),
          { buyPrice: order.fillPrice },
        );
      }
      steps.push('cierre');
      const rec = await reconcile(environment);
      if (rec.ok) steps.push('conciliacion');
      await refresh(environment);
      const pnl = closed.pnl;
      journal({
        type: 'operacion',
        mode: environment === 'live' ? 'live' : 'paper',
        ticker: FX_TEST_ORDER.instrument,
        reason: `Orden de prueba OANDA ${environment === 'live' ? 'real' : 'práctica'}: 1 unidad de EUR/USD comprada a ${order.fillPrice} y cerrada a ${closed.price}.`,
      });
      return done(
        rec.ok,
        rec.ok
          ? `Todo funciona: se compró 1 € de EUR/USD a ${order.fillPrice}, se cerró a ${closed.price} y las cuentas cuadran. El pequeño resultado${pnl === null ? '' : ` (${pnl.toFixed(4).replace('.', ',')})`} es el diferencial entre compra y venta.`
          : 'La compra y el cierre se hicieron, pero la conciliación encontró diferencias.',
        rec.ok ? null : (rec.error ?? rec.discrepancies.join(' ')),
        { buyPrice: order.fillPrice, closePrice: closed.price, pnl },
      );
    },

    reconcile: async (environment) => {
      const summary = await reconcile(environment);
      await changed();
      return summary;
    },

    handleRiskChanged: (payload) => {
      const overview = payload as {
        killSwitch?: { active?: boolean; cause?: string | null };
      } | null;
      if (overview && typeof overview === 'object' && overview.killSwitch?.active === true) {
        void closeAll(`causa: ${overview.killSwitch.cause ?? 'desconocida'}`).catch(
          (error: unknown) => {
            logger.warn(`[fx-broker] el cierre tras la parada falló: ${errorMessage(error)}`);
          },
        );
      }
    },

    restore: async () => {
      for (const environment of FX_BROKER_ENVIRONMENTS) {
        if (!(await hasCredentials(environment))) continue;
        if (environment === 'live' && !deps.isLiveGateOpen()) continue;
        try {
          envs[environment].adapter = deps.createAdapter(environment, () =>
            readCredentials(environment),
          );
          await refresh(environment);
        } catch (error) {
          envs[environment].error = friendlyError(error, environment);
        }
      }
    },

    resetAdapters: () => {
      for (const environment of FX_BROKER_ENVIRONMENTS) {
        envs[environment] = {
          adapter: null,
          error: null,
          checkedAt: null,
          account: null,
          positions: [],
        };
      }
    },
  };
}
