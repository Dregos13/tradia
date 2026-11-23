/**
 * Guarda de techos de divisas y oro (OANDA) — evaluación pura.
 *
 * Se consulta antes de cada orden que abre riesgo, DESPUÉS de la
 * pasarela única del motor de riesgo (`risk.submitSignal`): el motor
 * decide si la idea es aceptable (ratio, cautela, parada, límites de
 * la cartera) y esta guarda decide cuánto se puede arriesgar con el
 * poco capital de esta fase. Todo en euros.
 *
 * Reglas, en este orden:
 * 1. Parada de emergencia activa o sin conexión → no se abre nada.
 * 2. Cuenta real: lista de comprobación completa y límites confirmados
 *    con la frase escrita.
 * 3. Stop y objetivo obligatorios y en el lado correcto del precio.
 * 4. Una posición por instrumento y no más de `openPositions` a la vez.
 * 5. Tamaño: las unidades pedidas, o las que caben en los euros de
 *    riesgo pedidos con la distancia al stop. Nunca más de
 *    `maxUnits` del instrumento ni de lo que permite el riesgo por
 *    orden del usuario (≤ `FX_FIXED_CAPS.riskPerOrderEur`).
 * 6. Margen: el retenido por lo abierto más el de esta orden no pasa
 *    del capital del usuario (≤ 500 €).
 * 7. Pérdida del día (desde el valor de la cuenta al empezar el día)
 *    por debajo del límite diario.
 */
import {
  FX_FIXED_CAPS,
  FX_INSTRUMENT_SPECS,
  formatEur,
  type FxBrokerEnvironment,
  type FxBrokerInstrument,
  type FxLimits,
} from '../../shared/fxBroker';

export interface FxGuardInput {
  environment: FxBrokerEnvironment;
  instrument: FxBrokerInstrument;
  side: 'buy' | 'sell';
  size: { units: number } | { riskEur: number };
  /** Precio al que se ejecutaría (ask en compra, bid en venta). */
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  /** Euros que vale 1 unidad de la moneda cotizada del instrumento. */
  eurPerQuote: number;
  /** Euros de nominal por unidad del instrumento (para el margen). */
  notionalEurPerUnit: number;
  limits: FxLimits;
  liveGateOpen: boolean;
  liveConfirmed: boolean;
  killSwitchActive: boolean;
  online: boolean;
  /** Margen retenido ahora mismo, en euros. */
  marginUsedEur: number;
  /** Valor actual de la cuenta (NAV) en euros. */
  navEur: number;
  /** Valor de la cuenta al empezar el día, en euros; null si no se conoce. */
  dayStartNavEur: number | null;
  /** Instrumentos con posición abierta. */
  openInstruments: readonly FxBrokerInstrument[];
}

export type FxGuardResult =
  | { ok: true; units: number; riskEur: number; marginEur: number }
  | { ok: false; reasons: string[] };

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function checkFxOrder(input: FxGuardInput): FxGuardResult {
  const reasons: string[] = [];
  const spec = FX_INSTRUMENT_SPECS[input.instrument];
  const limits = input.limits;

  if (input.killSwitchActive) {
    return { ok: false, reasons: ['La parada de emergencia está activa: no se abren órdenes.'] };
  }
  if (!input.online) {
    return { ok: false, reasons: ['Sin conexión verificada: no se abren órdenes.'] };
  }
  if (input.environment === 'live') {
    if (!input.liveGateOpen) {
      reasons.push('La lista de comprobación del modo real no está completa.');
    }
    if (!input.liveConfirmed) {
      reasons.push('Confirma tus límites con la frase escrita antes de operar con dinero real.');
    }
    if (reasons.length > 0) return { ok: false, reasons };
  }

  const { entryPrice, stopPrice, targetPrice } = input;
  const positive = (n: number): boolean => Number.isFinite(n) && n > 0;
  if (![entryPrice, stopPrice, targetPrice].every(positive)) {
    return { ok: false, reasons: ['Faltan el precio, el stop o el objetivo.'] };
  }
  const buy = input.side === 'buy';
  if (buy ? !(stopPrice < entryPrice) : !(stopPrice > entryPrice)) {
    reasons.push(
      buy
        ? 'En una compra el stop va por debajo del precio actual.'
        : 'En una venta el stop va por encima del precio actual.',
    );
  }
  if (buy ? !(targetPrice > entryPrice) : !(targetPrice < entryPrice)) {
    reasons.push(
      buy
        ? 'En una compra el objetivo va por encima del precio actual.'
        : 'En una venta el objetivo va por debajo del precio actual.',
    );
  }
  if (reasons.length > 0) return { ok: false, reasons };

  if (input.openInstruments.includes(input.instrument)) {
    reasons.push(`Ya tienes una posición abierta en ${spec.label}. Ciérrala antes de abrir otra.`);
  }
  if (input.openInstruments.length >= limits.openPositions) {
    reasons.push(
      `Ya tienes ${input.openInstruments.length} posición(es) abierta(s): tu límite es ${limits.openPositions}.`,
    );
  }

  // Euros que se pierden por unidad si salta el stop.
  const riskPerUnitEur = Math.abs(entryPrice - stopPrice) * input.eurPerQuote;
  const riskCap = Math.min(limits.riskPerOrderEur, FX_FIXED_CAPS.riskPerOrderEur);
  let units: number;
  if ('units' in input.size) {
    units = input.size.units;
    if (!Number.isInteger(units) || units < 1) {
      return { ok: false, reasons: ['Las unidades deben ser un número entero desde 1.'] };
    }
  } else {
    const wanted = input.size.riskEur;
    if (!positive(wanted)) {
      return { ok: false, reasons: ['Los euros de riesgo deben ser mayores que 0.'] };
    }
    units = Math.floor(Math.min(wanted, riskCap) / riskPerUnitEur);
    if (units < 1) {
      reasons.push(
        `Con ese stop, 1 unidad ya arriesga ${formatEur(round2(riskPerUnitEur))}: más que ${formatEur(Math.min(wanted, riskCap))}. Acerca el stop o sube el riesgo.`,
      );
      return { ok: false, reasons };
    }
  }
  if (units > spec.maxUnits) {
    reasons.push(`El máximo por orden en ${spec.label} es de ${spec.maxUnits} unidades.`);
  }
  const riskEur = units * riskPerUnitEur;
  if (riskEur > riskCap + 1e-9) {
    reasons.push(
      `Esta orden arriesga ${formatEur(round2(riskEur))} y tu límite por orden es ${formatEur(riskCap)}.`,
    );
  }
  const marginEur = units * input.notionalEurPerUnit * spec.marginRate;
  const capital = Math.min(limits.capitalEur, FX_FIXED_CAPS.capitalEur);
  if (input.marginUsedEur + marginEur > capital + 1e-9) {
    reasons.push(
      `La garantía que retiene el bróker pasaría a ${formatEur(round2(input.marginUsedEur + marginEur))} y tu capital es ${formatEur(capital)}.`,
    );
  }
  if (marginEur > input.navEur - input.marginUsedEur) {
    reasons.push(
      `Tu cuenta no tiene garantía libre suficiente: esta orden necesita ${formatEur(round2(marginEur))}.`,
    );
  }
  if (input.dayStartNavEur !== null) {
    const lost = input.dayStartNavEur - input.navEur;
    const dailyCap = Math.min(limits.dailyLossEur, FX_FIXED_CAPS.dailyLossEur);
    if (lost >= dailyCap) {
      reasons.push(
        `Hoy ya llevas ${formatEur(round2(lost))} de pérdida y tu límite diario es ${formatEur(dailyCap)}. Mañana se puede volver a operar.`,
      );
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, units, riskEur: round2(riskEur), marginEur: round2(marginEur) };
}

/**
 * Euros que vale 1 unidad de la moneda cotizada de un instrumento, con
 * los precios medios de EUR/USD y USD/JPY.
 */
export function eurPerQuoteOf(
  instrument: FxBrokerInstrument,
  eurUsd: number,
  usdJpy: number,
): number {
  return FX_INSTRUMENT_SPECS[instrument].quote === 'JPY' ? 1 / (usdJpy * eurUsd) : 1 / eurUsd;
}

/** Nominal en euros de 1 unidad del instrumento al precio dado. */
export function notionalEurPerUnitOf(
  instrument: FxBrokerInstrument,
  price: number,
  eurUsd: number,
  usdJpy: number,
): number {
  if (instrument === 'EURUSD') return 1;
  if (instrument === 'USDJPY') return 1 / eurUsd;
  return price * eurPerQuoteOf(instrument, eurUsd, usdJpy);
}

/** Importe en la divisa de la cuenta → euros (cuentas en EUR o USD). */
export function accountToEur(amount: number, currency: string, eurUsd: number): number | null {
  if (currency === 'EUR') return amount;
  if (currency === 'USD') return amount / eurUsd;
  return null;
}
