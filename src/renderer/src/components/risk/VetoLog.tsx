import { useState } from 'react';
import {
  VETO_REASON_CODES,
  VETO_REASON_MESSAGES,
  type RiskVeto,
  type VetoReasonCode,
} from '../../../../shared/risk';
export function ReasonValues({ details }: { details: Record<string, number | string> }) {
  return (
    <dl className="risk-values">
      {Object.entries(details).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{typeof value === 'number' ? value.toLocaleString('es-ES') : value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function VetoLog({
  vetoes,
  loading,
  error,
  onRetry,
}: {
  vetoes: RiskVeto[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [rule, setRule] = useState<VetoReasonCode | ''>('');
  const rows = vetoes
    .filter((row) => !rule || row.code === rule)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  return (
    <section className="risk-paper" aria-labelledby="veto-title">
      <div className="risk-section-head">
        <h3 id="veto-title">Registro de vetos</h3>
        <label>
          Filtrar por regla
          <select
            value={rule}
            onChange={(event) => setRule(event.target.value as VetoReasonCode | '')}
          >
            <option value="">Todas las reglas</option>
            {VETO_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {VETO_REASON_MESSAGES[code]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status" aria-live="polite">
        {loading ? 'Cargando vetos…' : `${vetoes.length} registros · más reciente primero`}
      </p>
      {error && (
        <div className="risk-error" role="alert">
          <p>{error}</p>
          <button className="button" onClick={onRetry}>
            Reintentar registro
          </button>
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className="risk-empty">
          <strong>{rule ? 'No hay vetos para esta regla' : 'Todavía no hay vetos'}</strong>
          <p>Las señales rechazadas aparecerán aquí con la regla y los valores.</p>
        </div>
      )}
      {rows.length > 0 && (
        <div
          className="risk-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Registro de vetos, desplazable"
        >
          <table>
            <thead>
              <tr>
                {['Fecha', 'Activo', 'Regla', 'Motivo', 'Valores'].map((title) => (
                  <th scope="col" key={title}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <time dateTime={row.createdAt}>
                      {new Date(row.createdAt).toLocaleString('es-ES', { timeZoneName: 'short' })}
                    </time>
                  </td>
                  <td>{row.ticker}</td>
                  <td>
                    <strong>{row.code}</strong>
                    <br />
                    {row.decision === 'reducida' ? 'Reducida' : 'Vetada'}
                  </td>
                  <td>{row.message}</td>
                  <td>
                    <ReasonValues details={row.details} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
