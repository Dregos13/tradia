import { useId, useState } from 'react';
import { LIVE_FIXED_CAPS, type LiveLimits } from '../../../../shared/live';
import { usd } from './presentation';

export const LIMIT_FIELDS = [
  { key: 'capitalUsd', label: 'Capital total en real' },
  { key: 'orderUsd', label: 'Máximo por orden' },
  { key: 'dailyLossUsd', label: 'Pérdida diaria máxima' },
  { key: 'openPositions', label: 'Posiciones abiertas simultáneas' },
] as const;
type Field = keyof LiveLimits;
type Values = Record<Field, string>;
function validate(key: Field, value: string) {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return 'Escribe un límite mayor que cero.';
  if (key === 'openPositions' && !Number.isInteger(n))
    return 'Escribe un número entero de posiciones.';
  if (n > LIVE_FIXED_CAPS[key])
    return `Tu límite supera el techo de ${key === 'openPositions' ? `${LIVE_FIXED_CAPS[key]} posiciones` : usd(LIVE_FIXED_CAPS[key])}.`;
  return '';
}
export function LimitsForm({
  saved,
  disabled,
  onSave,
  onDirty,
  confirmed = false,
}: {
  saved: LiveLimits | null;
  disabled: boolean;
  onSave: (limits: LiveLimits) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
  confirmed?: boolean;
}) {
  const id = useId();
  const [values, setValues] = useState<Values>(
    () =>
      Object.fromEntries(
        LIMIT_FIELDS.map(({ key }) => [key, saved ? String(saved[key]) : '']),
      ) as Values,
  );
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const errors = Object.fromEntries(
    LIMIT_FIELDS.map(({ key }) => [key, validate(key, values[key])]),
  ) as Record<Field, string>;
  const dirty = !saved || LIMIT_FIELDS.some(({ key }) => Number(values[key]) !== saved[key]);
  return (
    <section className="live-sheet" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Límites de capital real</h3>
      <p>Tu valor debe ser igual o menor que el techo fijo.</p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, true])));
          if (disabled || Object.values(errors).some(Boolean)) return;
          void onSave(
            Object.fromEntries(
              LIMIT_FIELDS.map(({ key }) => [key, Number(values[key])]),
            ) as unknown as LiveLimits,
          ).then((ok) => {
            if (ok) onDirty(false);
          });
        }}
      >
        <div className="live-limits-grid">
          {LIMIT_FIELDS.map(({ key, label }) => (
            <div className="live-field" key={key}>
              <label htmlFor={`${id}-${key}`}>{label}</label>
              <small id={`${id}-${key}-cap`}>
                Techo fijo de esta fase:{' '}
                {key === 'openPositions' ? LIVE_FIXED_CAPS[key] : usd(LIVE_FIXED_CAPS[key])}
              </small>
              <input
                id={`${id}-${key}`}
                type="number"
                inputMode={key === 'openPositions' ? 'numeric' : 'decimal'}
                min={key === 'openPositions' ? 1 : 0.01}
                max={LIVE_FIXED_CAPS[key]}
                step={key === 'openPositions' ? 1 : 'any'}
                required
                disabled={disabled}
                value={values[key]}
                aria-invalid={!!(touched[key] && errors[key])}
                aria-describedby={`${id}-${key}-cap${touched[key] && errors[key] ? ` ${id}-${key}-error` : ''}`}
                onBlur={() => setTouched((old) => ({ ...old, [key]: true }))}
                onChange={(event) => {
                  const next = { ...values, [key]: event.target.value };
                  setValues(next);
                  setTouched((old) => ({ ...old, [key]: true }));
                  onDirty(
                    !saved ||
                      LIMIT_FIELDS.some(({ key: field }) => Number(next[field]) !== saved[field]),
                  );
                }}
              />
              {touched[key] && errors[key] && (
                <p className="live-field-error" id={`${id}-${key}-error`} role="alert">
                  {errors[key]}
                </p>
              )}
            </div>
          ))}
        </div>
        <button
          className="button"
          disabled={disabled || Object.values(errors).some(Boolean)}
          type="submit"
        >
          Guardar límites
        </button>
        {saved && !dirty && (
          <p className="live-meta">
            {confirmed
              ? 'Límites confirmados por escrito.'
              : 'Límites guardados · todavía debes confirmarlos por escrito.'}
          </p>
        )}
      </form>
    </section>
  );
}
