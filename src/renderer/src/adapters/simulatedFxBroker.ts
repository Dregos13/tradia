/**
 * Bróker de divisas (OANDA) falso para la vista previa en navegador y
 * las pruebas del renderer: mismas reglas de forma que el proceso
 * principal (token, cuenta y entorno), cuenta de práctica con 100 € y
 * una orden de prueba que abre y cierra 1 unidad de EUR/USD. Nunca
 * toca la red y la cuenta real queda siempre bloqueada.
 */
import {
  FX_DEFAULT_LIMITS,
  FX_FIXED_CAPS,
  FX_INSTRUMENT_SPECS,
  fxCredentialsProblem,
  fxLimitsProblems,
  fxLiveConfirmationPhrase,
  type FxBrokerEnvironment,
  type FxBrokerStatus,
  type FxEnvironmentStatus,
  type FxLimits,
  type FxPositionView,
} from '../../../shared/fxBroker';
import type { TradiaApi } from '../../../shared/ipc';

export function createSimulatedFxBroker(): TradiaApi['fxBroker'] {
  const listeners = new Set<(status: FxBrokerStatus) => void>();
  let limits: FxLimits = FX_DEFAULT_LIMITS;
  let confirmedPhrase: string | null = null;
  const envs: Record<
    FxBrokerEnvironment,
    { connected: boolean; error: string | null; balance: number; positions: FxPositionView[] }
  > = {
    practice: { connected: false, error: null, balance: 100, positions: [] },
    live: { connected: false, error: null, balance: 0, positions: [] },
  };
  const envStatus = (environment: FxBrokerEnvironment): FxEnvironmentStatus => {
    const env = envs[environment];
    return {
      environment,
      state: env.connected ? 'conectada' : env.error ? 'error' : 'desconectada',
      hasCredentials: env.connected,
      account: env.connected
        ? {
            accountMasked: '•••-001',
            currency: 'EUR',
            balance: env.balance,
            nav: env.balance,
            marginUsed: 0,
            unrealizedPnl: 0,
            openPositions: env.positions.length,
          }
        : null,
      positions: env.positions,
      error: env.error,
      checkedAt: env.connected ? new Date().toISOString() : null,
      simulated: true,
    };
  };
  const status = (): FxBrokerStatus => ({
    practice: envStatus('practice'),
    live: envStatus('live'),
    limits,
    caps: FX_FIXED_CAPS,
    liveConfirmed: confirmedPhrase === fxLiveConfirmationPhrase(limits),
    liveGateOpen: false,
    killSwitchActive: false,
    lastReconcile: {},
  });
  const emit = (): FxBrokerStatus => {
    const next = status();
    for (const listener of listeners) listener(next);
    return next;
  };
  return {
    status: async () => status(),
    connect: async (request) => {
      const env = envs[request.environment];
      const problem = fxCredentialsProblem(request);
      if (problem) env.error = problem;
      else if (request.environment === 'live') {
        env.error =
          'Completa la lista de comprobación de Dinero real antes de conectar la cuenta real.';
      } else {
        env.connected = true;
        env.error = null;
      }
      return emit();
    },
    disconnect: async (environment) => {
      envs[environment] = { ...envs[environment], connected: false, error: null, positions: [] };
      return emit();
    },
    setLimits: async (next) => {
      const problems = fxLimitsProblems(next);
      if (problems.length > 0) throw new Error(problems.join(' '));
      limits = next;
      return emit();
    },
    confirmLive: async ({ phrase }) => {
      if (phrase.trim() !== fxLiveConfirmationPhrase(limits)) {
        throw new Error('La frase no coincide. Escríbela exactamente como aparece.');
      }
      confirmedPhrase = phrase.trim();
      return emit();
    },
    placeOrder: async (request) => ({
      ok: false,
      reasons: [
        `En la vista previa no se envían órdenes de ${FX_INSTRUMENT_SPECS[request.instrument].label}.`,
      ],
      units: 0,
      riskEur: null,
      fillPrice: null,
      clientOrderId: null,
      status: status(),
    }),
    closePosition: async ({ environment, instrument }) => {
      envs[environment].positions = envs[environment].positions.filter(
        (p) => p.instrument !== instrument,
      );
      return emit();
    },
    testOrder: async ({ environment }) => {
      if (!envs[environment].connected) {
        return {
          ok: false,
          steps: [],
          summary: 'No hay cuenta conectada.',
          error: 'Conecta primero tu cuenta de práctica de OANDA.',
          buyPrice: null,
          closePrice: null,
          pnl: null,
          status: status(),
        };
      }
      envs[environment].balance =
        Math.round((envs[environment].balance - 0.0001) * 10_000) / 10_000;
      return {
        ok: true,
        steps: ['precio', 'riesgo', 'compra', 'cierre', 'conciliacion'],
        summary:
          'Todo funciona: se compró 1 € de EUR/USD a 1.08462, se cerró a 1.0845 y las cuentas cuadran. El pequeño resultado (-0.0001) es el diferencial entre compra y venta.',
        error: null,
        buyPrice: 1.08462,
        closePrice: 1.0845,
        pnl: -0.0001,
        status: emit(),
      };
    },
    reconcile: async (environment) => ({
      environment,
      at: new Date().toISOString(),
      ok: true,
      discrepancies: [],
      error: null,
    }),
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
