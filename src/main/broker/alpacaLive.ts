/**
 * Adaptador del broker Alpaca en modo LIVE — Fase 7 (capital mínimo real).
 *
 * Es el mismo núcleo REST v2 que el paper (`createAlpacaAdapter` en
 * `alpaca.ts`) pero con la URL FIJA `https://api.alpaca.markets` y dos
 * diferencias de seguridad:
 *
 * - Solo existe tras la puerta de la lista de comprobación del modo
 *   real: `isLiveGateOpen` se evalúa al construir el adaptador —sin la
 *   lista cumplida la factoría lanza `BrokerError` 'reject'— y de nuevo
 *   en cada `submitOrder`, de modo que un adaptador antiguo no puede
 *   enviar si la lista dejó de cumplirse.
 * - Las claves viven en su propia ranura de `secrets`
 *   (`LIVE_BROKER_SECRET_KEYS`), con el prefijo 'AK' de las cuentas live
 *   de Alpaca; el servicio (`src/main/live/broker.ts`) las valida contra
 *   `GET /v2/account` antes de guardarlas y nunca las devuelve.
 *
 * `paperOnly` es false y la cuenta llega con `paper: false`: toda la
 * tubería sabe que habla con dinero real. Fuera de la puerta, el
 * comportamiento es el del paper (mismos tipos de orden, mismos errores
 * tipados), así que las pruebas de contrato corren iguales contra el
 * servidor falso live (`__fixtures__/fake-server.ts`,
 * `createAlpacaLiveFakeFetch`).
 */
import { createAlpacaAdapter, type AlpacaBrokerDeps } from './alpaca';
import { BrokerError, type BrokerAdapter } from './types';

export const ALPACA_LIVE_ADAPTER_ID = 'alpaca-live';
/** Única URL admitida en live: el endpoint real de Alpaca. */
export const ALPACA_LIVE_BASE_URL = 'https://api.alpaca.markets';

export interface AlpacaLiveBrokerDeps extends AlpacaBrokerDeps {
  /**
   * Puerta de la lista de comprobación del modo real: devuelve true solo
   * con los siete requisitos cumplidos (la evalúa el servicio `live` en
   * el proceso principal). Se consulta al construir el adaptador y antes
   * de cada envío de orden.
   */
  isLiveGateOpen(): boolean;
}

const gateError = (clientOrderId?: string): BrokerError =>
  new BrokerError(
    'reject',
    'Alpaca live: la lista de comprobación del modo real no está completa; el envío está bloqueado',
    { adapter: ALPACA_LIVE_ADAPTER_ID, clientOrderId },
  );

export function createAlpacaLiveBroker(deps: AlpacaLiveBrokerDeps): BrokerAdapter {
  if (!deps.isLiveGateOpen()) {
    throw new BrokerError(
      'reject',
      'Alpaca live: la lista de comprobación del modo real no está completa; el adaptador no se crea',
      { adapter: ALPACA_LIVE_ADAPTER_ID },
    );
  }
  const adapter = createAlpacaAdapter(deps, {
    adapterId: ALPACA_LIVE_ADAPTER_ID,
    baseUrl: ALPACA_LIVE_BASE_URL,
    paper: false,
    label: 'live',
  });
  return {
    ...adapter,
    submitOrder: async (request) => {
      if (!deps.isLiveGateOpen()) throw gateError(request.clientOrderId);
      return adapter.submitOrder(request);
    },
  };
}
