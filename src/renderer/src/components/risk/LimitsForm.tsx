import { useState } from 'react';
import {
  RISK_BOUNDS,
  RISK_DEFAULTS,
  type CautionState,
  type RiskLimits,
} from '../../../../shared/risk';

const groups: { title: string; fields: [keyof RiskLimits, string, string][] }[] = [
  {
    title: 'Por operación',
    fields: [
      ['riskPerTradePct', 'Riesgo por operación', '%'],
      ['minRewardRiskRatio', 'Beneficio/riesgo mínimo', 'ratio'],
    ],
  },
  {
    title: 'Pérdidas',
    fields: [
      ['maxDailyLossPct', 'Pérdida diaria', '%'],
      ['maxWeeklyLossPct', 'Pérdida semanal', '%'],
      ['maxMonthlyLossPct', 'Pérdida mensual', '%'],
      ['maxDrawdownPct', 'Drawdown máximo', '%'],
    ],
  },
  {
    title: 'Exposición',
    fields: [
      ['maxOpenPositions', 'Posiciones abiertas', ''],
      ['maxAssetExposurePct', 'Exposición por activo', '%'],
      ['maxSectorExposurePct', 'Exposición por sector', '%'],
      ['maxCurrencyExposurePct', 'Exposición por divisa no USD', '%'],
      ['maxCorrelation', 'Correlación a 60 días', ''],
      ['maxLeverage', 'Apalancamiento fijo', '×'],
      ['maxLiquidityPct', 'Volumen medio 20 días', '%'],
    ],
  },
];
const number = (value: string) => (value.trim() === '' ? NaN : Number(value.replace(',', '.')));
const format = (value: number, unit: string) =>
  unit === 'ratio'
    ? `1:${value.toLocaleString('es-ES')}`
    : `${value.toLocaleString('es-ES')} ${unit}`.trim();
const draftOf = (limits: RiskLimits) =>
  Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, String(value)])) as Record<
    keyof RiskLimits,
    string
  >;

export function LimitsForm({ limits, caution }: { limits: RiskLimits; caution?: CautionState }) {
  const [draft, setDraft] = useState(() => draftOf(limits));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errors = Object.fromEntries(
    Object.keys(draft).map((field) => {
      const key = field as keyof RiskLimits;
      const value = number(draft[key]);
      const { min, max } = RISK_BOUNDS[key];
      return [
        key,
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (key === 'maxOpenPositions' && !Number.isInteger(value))
          ? `Introduce un valor entre ${min.toLocaleString('es-ES')} y ${max.toLocaleString('es-ES')}${key === 'maxOpenPositions' ? ', entero' : ''}.`
          : null,
      ];
    }),
  ) as Record<keyof RiskLimits, string | null>;
  async function save() {
    if (busy || Object.values(errors).some(Boolean)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.tradia.risk.setLimits(
        Object.fromEntries(
          Object.entries(draft).map(([key, value]) => [key, number(value)]),
        ) as unknown as RiskLimits,
      );
      setDraft(draftOf(result));
      setMessage('Límites guardados');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="risk-paper" aria-labelledby="limits-title">
      <h3 id="limits-title">Límites de riesgo</h3>
      <p className="risk-muted">Valores prudentes y márgenes duros.</p>
      <p>Estas reglas no las puede cambiar la IA</p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        aria-busy={busy}
      >
        {groups.map((group) => (
          <fieldset className="risk-group" key={group.title} disabled={busy}>
            <legend>{group.title}</legend>
            {group.title === 'Por operación' && (
              <p>
                Stop: <strong>Obligatorio</strong> · No se puede desactivar
              </p>
            )}
            {group.fields.map(([key, label, unit]) => (
              <div className="risk-field" key={key}>
                <label htmlFor={`limit-${key}`}>
                  {label}
                  {unit === '%' ? ' (%)' : ''}
                </label>
                <input
                  id={`limit-${key}`}
                  type="text"
                  inputMode="decimal"
                  value={draft[key]}
                  readOnly={key === 'maxLeverage'}
                  aria-invalid={!!errors[key]}
                  aria-describedby={`help-${key}${errors[key] ? ` error-${key}` : ''}`}
                  onChange={(event) => {
                    setDraft({ ...draft, [key]: event.target.value });
                    setMessage(null);
                    setError(null);
                  }}
                />
                <small id={`help-${key}`}>
                  Predeterminado: {format(RISK_DEFAULTS[key], unit)} · Margen:{' '}
                  {format(RISK_BOUNDS[key].min, unit)}–{format(RISK_BOUNDS[key].max, unit)}
                  {key === 'maxDrawdownPct' && ' · Activa la parada'}
                </small>
                {errors[key] && (
                  <small id={`error-${key}`} className="risk-field-error">
                    Error: {errors[key]}
                  </small>
                )}
              </div>
            ))}
          </fieldset>
        ))}
        <div className="risk-group">
          <h4>Cautela</h4>
          <p>
            {caution
              ? caution.active
                ? `${caution.eventTitle ?? caution.cause} · ${caution.effect === 'bloquear' ? 'Entradas bloqueadas' : `Tamaño × ${caution.sizeFactor.toLocaleString('es-ES')}`}`
                : 'Sin cautela activa'
              : 'Estado de cautela no disponible'}
          </p>
          <small>Reglas automáticas de calendario y mercado; no se pueden editar.</small>
        </div>
        {error && (
          <p className="risk-error" role="alert">
            {error}
          </p>
        )}
        <p role="status">{busy ? 'Guardando límites…' : message}</p>
        <div className="risk-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(draftOf(RISK_DEFAULTS));
              setError(null);
              setMessage('Valores prudentes restablecidos. Guarda para aplicarlos.');
            }}
          >
            Restablecer valores prudentes
          </button>
          <button className="button primary" disabled={busy || Object.values(errors).some(Boolean)}>
            Guardar límites
          </button>
        </div>
      </form>
    </section>
  );
}
