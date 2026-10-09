import type { BrokerOrderStatus } from '../../../../shared/broker';
import tokens from '../../design/broker.tokens.json';
export const orderStatuses: Record<
  BrokerOrderStatus,
  { label: string; icon: string; token: keyof typeof tokens.color.orderStatus }
> = {
  pendiente: { label: 'Pendiente', icon: '◷', token: 'pending' },
  enviada: { label: 'Enviada', icon: '↗', token: 'sent' },
  parcial: { label: 'Ejecución parcial', icon: '◐', token: 'partial' },
  ejecutada: { label: 'Ejecutada', icon: '✓', token: 'filled' },
  cancelada: { label: 'Cancelada', icon: '⊘', token: 'cancelled' },
  rechazada: { label: 'Rechazada', icon: '✕', token: 'rejected' },
  huerfana: { label: 'Huérfana', icon: '⚠', token: 'orphaned' },
};
export const orderTypes = { market: 'Mercado', limit: 'Limitada', stop: 'Stop', oco: 'OCO' };
export const number = (value: number) =>
  value.toLocaleString('es-ES', { maximumFractionDigits: 2 });
export const price = (value: number | null) => (value === null ? '—' : `${number(value)} USD`);
export const time = (value: string) =>
  new Date(value).toLocaleString('es-ES', { timeZoneName: 'short' });
export function slippage(value: number | null) {
  if (value === null) return '— · pendiente de ejecución';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value))} pb · ${value > 0 ? 'desfavorable' : value < 0 ? 'favorable' : 'sin desviación'}`;
}
export function ordersTokenStylesheet() {
  const theme = (mode: 'light' | 'dark') =>
    Object.entries(tokens.color.orderStatus)
      .map(
        ([key, value]) =>
          `--order-${key}:${value[mode]};--order-${key}-surface:${value[`${mode}Surface`]};`,
      )
      .join('') +
    `--order-paper:${tokens.color.paper[mode]};--order-paper-surface:${tokens.color.paper[`${mode}Surface`]};`;
  return `.orders-surface{--orders-table-min:${tokens.size.ordersTableMin};${theme('light')}}@media(prefers-color-scheme:dark){.orders-surface{${theme('dark')}}}`;
}
