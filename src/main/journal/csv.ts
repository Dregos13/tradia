/**
 * Serialización del diario a CSV (fase 4), conforme a RFC 4180:
 *
 * - Cabecera fija en la primera fila y un registro por línea separados por
 *   CRLF.
 * - Los campos que contienen coma, comillas o salto de línea van entre
 *   comillas dobles; las comillas internas se duplican.
 * - UTF-8 con BOM al inicio para que Excel lo abra con la codificación
 *   correcta, y fechas en ISO 8601 tal como se persisten.
 *
 * Los campos compuestos (`datos_usados`, `errores`, `reglas`) viajan como
 * JSON dentro de su celda: conservan la entrada completa y se pueden
 * reprocesar. `estrategias` va legible («Nombre vN» separadas por «; »),
 * como las muestra la tabla del diario.
 */

import type { JournalEntry } from '../../shared/ipc';

/** Marca de orden de bytes UTF-8: Excel abre el CSV acentuado sin perderlo. */
export const CSV_BOM = '\uFEFF';

/**
 * Columnas del CSV del diario, en el orden de la cabecera. Lista estable:
 * la batería E2E la lee para comprobar la estructura del archivo.
 */
export const JOURNAL_CSV_COLUMNS = [
  'id',
  'fecha',
  'tipo',
  'activo',
  'estrategias',
  'resultado',
  'motivo',
  'datos_usados',
  'errores',
  'reglas',
  'senal_id',
] as const;

/** RFC 4180 §2.6-2.7: comillas obligatorias si hay coma, comilla o CRLF/LF. */
function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function entryToRow(entry: JournalEntry): string[] {
  return [
    String(entry.id),
    entry.createdAt,
    entry.type,
    entry.ticker ?? '',
    entry.strategies.map((s) => `${s.name} v${s.version}`).join('; '),
    entry.result ?? '',
    entry.reason,
    entry.dataUsed !== null ? JSON.stringify(entry.dataUsed) : '',
    entry.errors.length > 0 ? JSON.stringify(entry.errors) : '',
    entry.ruleChecks.length > 0 ? JSON.stringify(entry.ruleChecks) : '',
    entry.signalId !== null ? String(entry.signalId) : '',
  ];
}

/**
 * CSV completo del conjunto de entradas (ya filtradas y ordenadas por el
 * repositorio). Con la lista vacía devuelve solo la cabecera: el archivo
 * sigue siendo un CSV válido.
 */
export function journalEntriesToCsv(entries: readonly JournalEntry[]): string {
  const lines = [
    JOURNAL_CSV_COLUMNS.map(escapeField).join(','),
    ...entries.map((entry) => entryToRow(entry).map(escapeField).join(',')),
  ];
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
