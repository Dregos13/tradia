/**
 * Plantillas de los avisos que salen por los canales de entrega.
 *
 * El texto sigue la tabla «Texto de notificaciones» de
 * `docs/diseno-fase-4.md`: la dirección se verbaliza (`compra`/`venta`),
 * la confianza se redondea a entero y todo aviso termina con la misma
 * línea de exención. Las mismas cadenas alimentan la notificación de
 * escritorio, el mensaje de Telegram y el correo.
 */

import type { RiskVeto, VetoReasonCode } from '../../shared/risk';
import { VETO_REASON_MESSAGES } from '../../shared/risk';
import type { Signal } from '../../shared/signals';
import type { DeliveryChannel, DeliveryEventKind } from '../../shared/journal';

/** Línea obligatoria al final de todo aviso (diseño de la fase). */
export const DELIVERY_DISCLAIMER = 'Aviso informativo: Tradia no ejecuta órdenes reales.';

export interface DeliveryText {
  title: string;
  body: string;
}

/** 'largo' → compra, 'corto' → venta (nunca el código interno). */
export function directionLabel(direction: Signal['direction']): string {
  return direction === 'corto' ? 'venta' : 'compra';
}

/** Confianza 0–1 como porcentaje entero para el aviso. */
export function confidencePct(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}

function formatValue(value: number | string | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return value;
}

/**
 * Valor observado dentro de `details`: la primera entrada numérica o de
 * texto que no sea el propio límite ni el marcador temporal `desde`.
 */
function observedDetail(details: Record<string, number | string>): number | string | undefined {
  for (const [key, value] of Object.entries(details)) {
    if (key !== 'limite' && key !== 'desde') return value;
  }
  return undefined;
}

/** Frase «observado X, límite Y» a partir de los detalles de una regla. */
export function ruleObservedVsLimit(details: Record<string, number | string>): string {
  return `observado ${formatValue(observedDetail(details))}, límite ${formatValue(details.limite)}`;
}

/** Título y cuerpo del aviso de una señal (aprobada/reducida o vetada). */
export function signalText(signal: Signal): { kind: DeliveryEventKind; text: DeliveryText } {
  const direction = directionLabel(signal.direction);
  if (signal.decision.status === 'vetada') {
    const first = signal.decision.reasons[0];
    const reason = signal.reason.endsWith('.') ? signal.reason : `${signal.reason}.`;
    const rule = first ? ` Regla: ${first.message}; ${ruleObservedVsLimit(first.details)}.` : '';
    return {
      kind: 'senal-vetada',
      text: {
        title: `Señal vetada · ${signal.ticker} ${direction}`,
        body: `${reason}${rule} ${DELIVERY_DISCLAIMER}`,
      },
    };
  }
  const risk =
    signal.decision.status === 'reducida'
      ? `aprobado con tamaño reducido (×${formatValue(signal.decision.sizeFactor)})`
      : 'aprobado';
  return {
    kind: 'senal-aprobada',
    text: {
      title: `Señal aprobada · ${signal.ticker} ${direction}`,
      body:
        `${signal.reason} Confianza: ${confidencePct(signal.confidence)} %. ` +
        `Riesgo: ${risk}; posición simulada de ${signal.decision.size}. ` +
        DELIVERY_DISCLAIMER,
    },
  };
}

/**
 * Códigos de veto que cuentan como «límite alcanzado»: los de pérdida por
 * periodo, drawdown y exposición. `KILL_SWITCH_ACTIVE` y `CAUTION_MODE`
 * tienen sus propios avisos (parada crítica) y las reglas por operación
 * solo aparecen en el aviso de señal vetada.
 */
export const LIMIT_VETO_CODES: readonly VetoReasonCode[] = [
  'DAILY_LOSS',
  'WEEKLY_LOSS',
  'MONTHLY_LOSS',
  'MAX_DRAWDOWN',
  'MAX_POSITIONS',
  'ASSET_EXPOSURE',
  'SECTOR_EXPOSURE',
  'CURRENCY_EXPOSURE',
  'CORRELATION',
  'LEVERAGE',
  'LIQUIDITY',
];

export function isLimitVeto(code: string): boolean {
  return (LIMIT_VETO_CODES as readonly string[]).includes(code);
}

/**
 * Aviso de límite alcanzado para un grupo de vetos del mismo activo. Con
 * varias reglas se lista cada una con su observado/límite; el efecto es
 * que la pasarela bloquea nuevas señales mientras el límite siga violado.
 */
export function limitText(ticker: string, vetoes: RiskVeto[]): DeliveryText {
  const lines = vetoes.map(
    (veto) =>
      `${VETO_REASON_MESSAGES[veto.code]}: ${formatValue(observedDetail(veto.details))} ` +
      `frente al límite ${formatValue(veto.details.limite)}.`,
  );
  const unique = [...new Set(lines)];
  const single = unique.length === 1;
  const name = vetoes[0] ? VETO_REASON_MESSAGES[vetoes[0].code] : 'límite';
  return {
    title: single ? `Límite alcanzado · ${name}` : `Límites alcanzados · ${ticker}`,
    body: `${unique.join(' ')} Se han bloqueado nuevas señales. ${DELIVERY_DISCLAIMER}`,
  };
}

/** Mensaje del botón «Enviar prueba» de cada canal externo. */
export function testText(channel: 'telegram' | 'correo'): DeliveryText {
  const label = channel === 'telegram' ? 'Telegram' : 'correo';
  return {
    title: `Prueba de Tradia · ${label}`,
    body: `Este es un mensaje de prueba del canal de ${label}. ${DELIVERY_DISCLAIMER}`,
  };
}

/** Etiqueta legible del canal para el diario y el log. */
export function channelLabel(channel: DeliveryChannel): string {
  switch (channel) {
    case 'telegram':
      return 'Telegram';
    case 'correo':
      return 'correo';
    default:
      return 'escritorio';
  }
}
