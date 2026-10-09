import type { RiskState } from '../../hooks/useRisk';

/** Provisional route; the limits editor and veto tester are delivered next. */
export function RiskPage({ risk }: { risk: RiskState }) {
  return (
    <section aria-labelledby="risk-page-title">
      <h2 id="risk-page-title">Control de riesgo</h2>
      <p>Estas reglas no las puede cambiar la IA</p>
      {risk.loading && <p role="status">Cargando estado de riesgo…</p>}
      {risk.error && (
        <div role="alert">
          <p>{risk.error}</p>
          <button className="button" onClick={() => void risk.reload()}>
            Reintentar
          </button>
        </div>
      )}
      {risk.killSwitch && (
        <p>{risk.killSwitch.active ? 'Señales y órdenes detenidas' : 'Parada desactivada'}</p>
      )}
      {risk.caution?.active && (
        <div className="risk-caution" role="status">
          <strong>Modo cautela activo</strong>
          <p>
            {risk.caution.eventTitle} ·{' '}
            {risk.caution.effect === 'bloquear'
              ? 'Entradas bloqueadas'
              : `Tamaño × ${risk.caution.sizeFactor}`}
          </p>
        </div>
      )}
      <p>
        La configuración de límites y el registro de vetos se incorporarán en la siguiente entrega.
      </p>
    </section>
  );
}
