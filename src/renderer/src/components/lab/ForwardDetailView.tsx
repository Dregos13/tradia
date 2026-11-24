import { useCallback, useEffect, useState } from 'react';

import type { ForwardDetail } from '../../../../shared/lab';
import { EquityChart } from './EquityChart';
import {
  EXIT_LABEL,
  isHourlyStart,
  longDate,
  money,
  ORDER_LABEL,
  pct,
  price,
  shortDate,
  signedMoney,
  signedPct,
  tone,
  when,
} from './format';

/** Velas de 1 hora en un año de divisas (24 h × 5 días × 52 semanas). */
const HOURS_PER_YEAR = 24 * 5 * 52;

export function ForwardDetailView({ id }: { id: number }) {
  const [detail, setDetail] = useState<ForwardDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await window.tradia.forward.get(id));
    } catch (cause) {
      setError((cause as Error)?.message ?? 'No se pudo cargar la prueba.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p role="alert" className="lab-error">
        {error}{' '}
        <button type="button" className="lab-link" onClick={() => void load()}>
          Reintentar
        </button>
      </p>
    );
  }
  if (detail === undefined) {
    return (
      <p role="status" aria-busy="true" className="lab-muted">
        Repitiendo la estrategia sobre las velas reales…
      </p>
    );
  }
  if (detail === null) {
    return (
      <p role="alert">
        Esta prueba ya no existe. <a href="#laboratorio">Volver al laboratorio</a>
      </p>
    );
  }

  const { test } = detail;
  const live = test.status === 'activa';
  const started = detail.sessions > 0;
  const hourly = isHourlyStart(test.startDate);
  const unit = hourly ? 'horas' : 'sesiones';
  const idle =
    started &&
    detail.tradeCount === 0 &&
    detail.positions.length === 0 &&
    detail.pendingOrders.length === 0;
  const edge =
    detail.benchmarkReturnPct === null ? null : detail.returnPct - detail.benchmarkReturnPct;
  const expected =
    detail.backtestAnnualPct !== null && started
      ? Math.pow(1 + detail.backtestAnnualPct, detail.sessions / (hourly ? HOURS_PER_YEAR : 252)) -
        1
      : null;

  const stop = async () => {
    setStopping(true);
    try {
      await window.tradia.forward.stop(test.id);
      setConfirmStop(false);
      await load();
    } catch (cause) {
      setError((cause as Error)?.message ?? 'No se pudo detener la prueba.');
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="lab-detail">
      <nav className="lab-crumbs" aria-label="Ruta">
        <a href="#laboratorio">Laboratorio</a>
        <span aria-hidden="true">/</span>
        <span>Prueba en vivo</span>
      </nav>

      <header className="lab-detail-head">
        <div>
          <h2>{test.strategyName}</h2>
          <p className="lab-detail-meta">
            v{test.version} congelada · {test.markets.join(' · ')} ·{' '}
            {hourly
              ? 'velas de 1 hora · desde ' + when(test.startDate)
              : 'desde ' + longDate(test.startDate)}
            {!live && test.stoppedAt && ` hasta ${longDate(test.stoppedAt)}`}
            {detail.dataKind === 'simulated' && ' · datos simulados'}
          </p>
        </div>
        <div className="lab-detail-actions">
          <a className="button" href={`#estrategias/${test.strategyId}`}>
            Ver ficha
          </a>
          {live &&
            (confirmStop ? (
              <span className="lab-confirm">
                <span>¿Detener? El resultado quedará fijo hoy.</span>
                <button
                  type="button"
                  className="button danger"
                  disabled={stopping}
                  onClick={() => void stop()}
                >
                  Detener
                </button>
                <button type="button" className="button" onClick={() => setConfirmStop(false)}>
                  Cancelar
                </button>
              </span>
            ) : (
              <button type="button" className="button" onClick={() => setConfirmStop(true)}>
                Detener prueba
              </button>
            ))}
        </div>
      </header>

      {detail.backtestAnnualPct !== null && detail.backtestAnnualPct < 0 && live && (
        <p className="lab-call" data-tone="bad" role="note">
          <strong>Ojo: en el histórico esta estrategia perdía dinero</strong>
          {`Perdía ${signedPct(detail.backtestAnnualPct).replace('−', '')} al año. Puedes dejarla para comprobarlo, pero lo normal es detenerla y probar otra idea.`}
        </p>
      )}

      {started && (
        <p className="lab-status-line">
          Lleva <b>{detail.sessions}</b> {unit} mirando el mercado real
          {detail.asOf ? ` (última: ${when(detail.asOf)})` : ''}.
          {idle &&
            ' Todavía no se ha dado su señal, así que no ha comprado nada: es normal, espera.'}
        </p>
      )}

      {detail.error && (
        <p className="lab-error" role="alert">
          {detail.error}
        </p>
      )}

      <dl className="lab-stats lab-stats-hero">
        <div>
          <dt>Capital</dt>
          <dd>{money(detail.equity)}</dd>
          <p className="lab-stat-sub">de {money(test.initialCash)} ficticios</p>
        </div>
        <div>
          <dt>Resultado</dt>
          <dd data-tone={started ? tone(detail.returnPct) : 'flat'}>
            {started ? signedPct(detail.returnPct) : '—'}
          </dd>
          <p className="lab-stat-sub">
            {edge === null || !started
              ? 'Sin comparación aún'
              : `${signedPct(edge)} frente a comprar y esperar`}
          </p>
        </div>
        <div>
          <dt>Peor caída</dt>
          <dd>{started ? pct(detail.maxDrawdownPct) : '—'}</dd>
          <p className="lab-stat-sub">desde el máximo</p>
        </div>
        <div>
          <dt>Operaciones cerradas</dt>
          <dd>{detail.tradeCount}</dd>
          <p className="lab-stat-sub">
            {detail.winRate === null ? 'Ninguna todavía' : `${pct(detail.winRate)} con ganancia`}
          </p>
        </div>
      </dl>

      {started ? (
        <EquityChart
          curve={detail.curve}
          initialCash={test.initialCash}
          benchmark={test.benchmark}
          nowLabel={
            live ? `Ahora · ${shortDate(detail.asOf!)}` : `Detenida · ${shortDate(detail.asOf!)}`
          }
        />
      ) : (
        <div className="lab-waiting">
          {hourly ? (
            <p>
              Empieza a las {when(test.startDate)}. Cada hora mira la vela que acaba de cerrar y, si
              se cumplen sus reglas, compra o vende al empezar la siguiente.
            </p>
          ) : (
            <p>
              Esperando su primer cierre. La estrategia evalúa las reglas al cierre del{' '}
              {longDate(test.startDate)} y, si da señal, opera en la apertura siguiente.
            </p>
          )}
        </div>
      )}

      {expected !== null && (
        <p className="lab-expect">
          Al ritmo de su backtest ({signedPct(detail.backtestAnnualPct)} al año) llevaría{' '}
          <b>{signedPct(expected)}</b>. Lleva{' '}
          <b data-tone={tone(detail.returnPct)}>{signedPct(detail.returnPct)}</b>.
          {detail.sessions < (hourly ? 120 : 60) &&
            ` Con tan pocas ${unit} la diferencia todavía no dice mucho.`}
        </p>
      )}

      <div className="lab-columns">
        <section aria-labelledby="lab-next">
          <h3 id="lab-next">{hourly ? 'Próxima hora' : 'Próxima apertura'}</h3>
          {detail.pendingOrders.length === 0 ? (
            <p className="lab-muted">
              {live ? 'Sin órdenes: la estrategia espera su señal.' : 'Prueba detenida.'}
            </p>
          ) : (
            <ul className="lab-orders">
              {detail.pendingOrders.map((order) => (
                <li key={`${order.ticker}-${order.kind}`}>
                  <span data-kind={order.kind}>{ORDER_LABEL[order.kind]}</span>
                  <b>{order.ticker}</b>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="lab-open">
          <h3 id="lab-open">Posiciones abiertas</h3>
          {detail.positions.length === 0 ? (
            <p className="lab-muted">Ninguna. Todo el capital está en efectivo.</p>
          ) : (
            <table className="lab-table">
              <thead>
                <tr>
                  <th scope="col">Activo</th>
                  <th scope="col">Desde</th>
                  <th scope="col" className="num">
                    Entrada
                  </th>
                  <th scope="col" className="num">
                    Último
                  </th>
                  <th scope="col" className="num">
                    Latente
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.positions.map((p) => (
                  <tr key={p.ticker}>
                    <th scope="row">
                      {p.ticker}
                      {p.side === 'corto' && <span className="lab-row-sub">Corto</span>}
                    </th>
                    <td className="mono">{when(p.entryDate)}</td>
                    <td className="num">{price(p.entryPrice)}</td>
                    <td className="num">{price(p.lastClose)}</td>
                    <td className="num" data-tone={tone(p.unrealizedPnl)}>
                      {signedMoney(p.unrealizedPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section aria-labelledby="lab-trades">
        <h3 id="lab-trades">Operaciones cerradas</h3>
        {detail.trades.length === 0 ? (
          <p className="lab-muted">Ninguna todavía.</p>
        ) : (
          <table className="lab-table">
            <thead>
              <tr>
                <th scope="col">Activo</th>
                <th scope="col">Entrada</th>
                <th scope="col">Salida</th>
                <th scope="col">Motivo</th>
                <th scope="col" className="num">
                  Resultado
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.trades.map((t, i) => (
                <tr key={`${t.ticker}-${t.entryDate}-${i}`}>
                  <th scope="row">
                    {t.ticker}
                    {t.side === 'corto' && <span className="lab-row-sub">Corto</span>}
                  </th>
                  <td className="mono">
                    {when(t.entryDate)} · {price(t.entryPrice)}
                  </td>
                  <td className="mono">
                    {when(t.exitDate)} · {price(t.exitPrice)}
                  </td>
                  <td>{EXIT_LABEL[t.exitReason] ?? t.exitReason}</td>
                  <td className="num" data-tone={tone(t.pnl)}>
                    {signedMoney(t.pnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
