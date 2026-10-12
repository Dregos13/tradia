/**
 * Formato de fechas de sesión compartido — mismo texto en el proceso
 * principal y en el renderer.
 *
 * Las fechas de sesión viajan como 'YYYY-MM-DD' (día de mercado, sin
 * hora). Para mostrarlas se fijan al mediodía UTC, lejos de los bordes
 * de día de cualquier huso, y se formatean en el formato local corto
 * en español que usa la interfaz: «25 sept 2026». Así el motivo de una
 * estrategia, la franja global y los paneles muestran la misma fecha.
 */

/** «2026-09-25» → «25 sept 2026»; null → 'sin datos'; entrada inválida → tal cual. */
export function sessionDateLabel(date: string | null): string {
  if (date === null) return 'sin datos';
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('es-ES', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
}
