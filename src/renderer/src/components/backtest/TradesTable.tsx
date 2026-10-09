import { useState } from 'react';
import type { TradeDto } from '../../../../shared/backtest';
import { number } from '../strategies/model';
import { ReportTable } from './ReportTable';
const reasons: Record<TradeDto['exitReason'], string> = {
  signal: 'Señal',
  stop: 'Stop',
  target: 'Objetivo',
  delisted: 'Baja del activo',
  'end-of-data': 'Fin de datos',
};
export function TradesTable({ trades }: { trades: TradeDto[] }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(trades.length / 20));
  return (
    <section className="strategy-section">
      <h3>Operaciones</h3>
      {trades.length ? (
        <>
          <ReportTable
            caption={`Operaciones cerradas · página ${page + 1} de ${pages}`}
            headers={[
              'Activo',
              'Señal',
              'Entrada',
              'Salida',
              'Precio entrada',
              'Precio salida',
              'Acciones',
              'Comisión',
              'Slippage',
              'PnL neto',
              'Motivo',
            ]}
            rows={trades
              .slice(page * 20, (page + 1) * 20)
              .map((t) => [
                t.ticker,
                t.signalDate,
                t.entryDate,
                t.exitDate,
                number(t.entryPrice, ' USD'),
                number(t.exitPrice, ' USD'),
                number(t.shares),
                number(t.commission, ' USD'),
                number(t.slippage, ' USD'),
                number(t.pnl, ' USD'),
                reasons[t.exitReason],
              ])}
          />
          <nav className="strategy-actions" aria-label="Paginación de operaciones">
            <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </button>
            <p role="status">
              Página {page + 1} de {pages} · {trades.length} operaciones
            </p>
            <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              Siguiente
            </button>
          </nav>
          <p>
            Precios de ejecución incluyen spread y slippage; comisión y slippage se muestran por
            separado.
          </p>
        </>
      ) : (
        <p>Aún no hay operaciones. Revisa el periodo y las reglas de entrada desde la ficha.</p>
      )}
    </section>
  );
}
