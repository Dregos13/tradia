export const number = (value: number) =>
  new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(value);
export const time = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(value))
    : 'Sin actualización';
export const direction = (value: string) => (value === 'largo' ? '↑ Compra' : '↓ Venta');
export const timestamp = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('es-ES', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(value))
    : 'Sin actualización';
