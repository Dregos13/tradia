/**
 * Motivos de `data_status` en español llano.
 *
 * Las filas guardadas por versiones anteriores (y los mensajes internos de
 * los adaptadores) llevan texto técnico —«ticker 'EUR' no existe»,
 * «el proveedor 'tiingo' no devolvió datos para EUR», «[tiingo] credencial
 * rechazada (HTTP 401)»— que la interfaz muestra tal cual en «Por qué
 * ocurre» y que además puede ser falso (EUR existe; lo que pasa es que el
 * proveedor no lo cubre). `plainStatusReason` es el único punto de
 * traducción: se aplica al guardar el motivo (ingesta) y al leerlo
 * (frescura y cobertura de la lista), así las filas antiguas salen en
 * llano sin migración de base de datos.
 */
import { formatAssetSymbol, inferAssetClass } from '../../shared/fx';
import type { DataStatusState } from '../../shared/ipc';
import type { MarketDataErrorKind } from './providers/types';

/** Nombres legibles de los proveedores conocidos (franja y resumen de frescura). */
export const PROVIDER_LABELS: Record<string, string> = {
  tiingo: 'Tiingo',
  fred: 'FRED',
  simulated: 'Proveedor simulado',
  'macro-simulated': 'Proveedor macro simulado',
};

/** Nombre para mostrar de un id de proveedor; el id en bruto si no se conoce. */
export const providerLabel = (id: string): string => PROVIDER_LABELS[id] ?? id;

/** Id de proveedor citado en un motivo guardado: «[tiingo] …», «… 'tiingo'» o el nombre ya llano. */
const providerIdIn = (reason: string | null): string | null => {
  if (reason === null) return null;
  const bracketed = /^\[([a-z][a-z0-9-]*)\]/.exec(reason);
  if (bracketed && bracketed[1]! in PROVIDER_LABELS) return bracketed[1]!;
  for (const match of reason.matchAll(/'([a-z][a-z0-9-]*)'/g)) {
    if (match[1]! in PROVIDER_LABELS) return match[1]!;
  }
  // Motivos ya llanos («Proveedor simulado no tiene datos…») y los del
  // proveedor de desarrollo («fallo simulado del proveedor macro (…)»).
  if (/proveedor\s+macro|macro\s+simulad/i.test(reason)) return 'macro-simulated';
  if (/simulad/i.test(reason)) return 'simulated';
  if (/tiingo/i.test(reason)) return 'tiingo';
  if (/\bfred\b/i.test(reason)) return 'fred';
  return null;
};

/** Proveedor por defecto según el ámbito de la clave cuando el motivo no lo cita. */
const defaultProviderId = (key: string): string => {
  if (key.startsWith('provider:')) return key.slice('provider:'.length);
  if (key.startsWith('macro:')) return 'fred';
  return 'tiingo';
};

/** Sujeto del motivo: el ticker (con barra en divisas), la serie o el proveedor. */
const subjectFor = (key: string, label: string | undefined): string => {
  if (label !== undefined) return label;
  if (key.startsWith('ticker:')) {
    const ticker = key.slice('ticker:'.length);
    return formatAssetSymbol(ticker, inferAssetClass(ticker));
  }
  if (key.startsWith('macro:')) return key.slice('macro:'.length);
  if (key.startsWith('provider:')) return providerLabel(key.slice('provider:'.length));
  return key;
};

/**
 * Quita del motivo lo que no debe ver el usuario: el id entre corchetes
 * («[tiingo] …»), el detalle HTTP «(HTTP 429): …» con su cola, la referencia
 * al almacén de claves «(secrets['…'])» y las menciones 'id' del proveedor.
 * Devuelve null cuando nada queda aprovechable.
 */
const cleanResidual = (text: string): string | null => {
  const cleaned = text
    .replace(/\s*\(secrets\[[^\]]*\]\)/g, '')
    .replace(/\s*\(HTTP\s*\d+\)(?::.*)?$/g, '')
    .replace(/\s+(?:en|de|del|para|con)\s+'[a-z][a-z0-9_-]*'/g, '')
    .replace(/'([a-z][a-z0-9-]*)'/g, (_all, id: string) =>
      id in PROVIDER_LABELS ? PROVIDER_LABELS[id]! : `'${id}'`,
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Si quedan marcas técnicas ('…' o '[…]') el motivo no es presentable.
  if (cleaned === '' || /['[\]]/.test(cleaned)) return null;
  return cleaned;
};

export interface StatusReasonInput {
  /** Clave de `data_status`: 'ticker:EUR', 'macro:DFF' o 'provider:tiingo'. */
  key: string;
  /** Estado del dato; 'sin-cobertura' produce siempre su frase propia. */
  state: DataStatusState;
  /** Motivo guardado o a guardar (técnico o ya llano); null si no hay. */
  reason: string | null;
  /** Sujeto legible cuando la clave no lo da (p. ej. el nombre de la serie). */
  label?: string;
  /** Proveedor que generó el motivo, cuando quien escribe lo conoce. */
  providerId?: string;
}

/**
 * Convierte el motivo de un estado de datos en una frase en español llano:
 * sin comillas, sin ids internos de proveedor ni detalles HTTP.
 *
 * - Sin cobertura (o el motivo dice que el proveedor no tiene el dato):
 *   «Tiingo no tiene datos de EUR.»
 * - Clave: «No hay clave de Tiingo guardada.» / «Tiingo rechazó la clave
 *   guardada.» / el motivo de clave con caracteres no válidos.
 * - Cuota: «La cuota de Tiingo está agotada por hoy.»
 * - Red: «No se pudo conectar con Tiingo.»; servidor: «El servicio de
 *   Tiingo devolvió un error.»
 * - Datos rechazados o malformados: «Tiingo devolvió datos que no se
 *   pudieron usar.»
 * - Motivos ya llanos («falta la vela del 7 oct 2026; último dato: …»)
 *   pasan intactos; los llanos con el id citado («esperando la vela del
 *   8 oct en 'tiingo'») se limpian.
 */
export function plainStatusReason(input: StatusReasonInput): string | null {
  const subject = subjectFor(input.key, input.label);
  const provider = providerLabel(
    input.providerId ?? providerIdIn(input.reason) ?? defaultProviderId(input.key),
  );

  if (input.state === 'sin-cobertura') return `${provider} no tiene datos de ${subject}.`;

  const raw = input.reason;
  if (raw === null || raw === '') return null;

  // Pistas de tipo que quedan en el texto: «kind: …» la escribe el
  // servicio macro y «(kind)» los fallos del proveedor simulado.
  const prefixed = /^(auth|rate-limit|not-found|network|bad-data):\s+/.exec(raw);
  const simulated = /fallo simulado del proveedor(?:\s+macro)?\s*\(([\w-]+)\)/.exec(raw);
  const kind = (prefixed?.[1] ?? simulated?.[1]) as MarketDataErrorKind | undefined;
  const text = raw
    .replace(/^(auth|rate-limit|not-found|network|bad-data):\s+/, '')
    .replace(/^\[[a-z][a-z0-9-]*\]\s+/, '');

  if (
    kind === 'not-found' ||
    /no devolvió datos|\bno existe\b|no encontrado|sin datos para|sin cotización|no está en el catálogo/i.test(
      text,
    )
  ) {
    return `${provider} no tiene datos de ${subject}.`;
  }

  if (kind === 'auth' || /credencial|clave|api[_ ]?key/i.test(text)) {
    if (/caracteres no válidos|vuelve a pegarla/i.test(text)) {
      return `La clave de ${provider} guardada tiene caracteres no válidos; vuelve a pegarla en Ajustes.`;
    }
    if (/sin clave|no hay clave|sin credencial/i.test(text)) {
      return `No hay clave de ${provider} guardada.`;
    }
    return `${provider} rechazó la clave guardada.`;
  }

  if (kind === 'rate-limit' || /cuota|límite de peticiones|\b429\b/i.test(text)) {
    return `La cuota de ${provider} está agotada por hoy.`;
  }

  if (/servidor|\b5\d\d\b/i.test(text)) {
    return `El servicio de ${provider} devolvió un error.`;
  }
  if (kind === 'network' || /transporte|tiempo de espera|fallo de red|sin conexión/i.test(text)) {
    // 'sin conexión a internet' es el estado local, no un fallo del
    // proveedor: el texto ya es llano y se conserva en el paso final.
    if (/sin conexión/i.test(text)) {
      return cleanResidual(text) ?? 'No hay conexión a internet.';
    }
    return `No se pudo conectar con ${provider}.`;
  }

  if (/error inesperado/i.test(text)) {
    return 'Error inesperado al actualizar los datos.';
  }

  if (
    kind === 'bad-data' ||
    /no es JSON|respuesta (inesperada|sin)|fila (de|FX)|petición rechazada|inválido|rechazadas/i.test(
      text,
    )
  ) {
    return `${provider} devolvió datos que no se pudieron usar.`;
  }

  // Motivo ya llano (o casi): se conserva, quitando la cita del proveedor.
  return cleanResidual(text) ?? `${provider} no pudo entregar los datos de ${subject}.`;
}
