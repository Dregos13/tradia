import { useId, useState } from 'react';
import { LIVE_FIXED_CAPS, LIVE_FIXED_SHORT_CAPS, type LiveLimits } from '../../../../shared/live';
import { usd } from './presentation';

export const LIMIT_FIELDS = [
  { key: 'capitalUsd', label: 'Capital total en real' },
  { key: 'orderUsd', label: 'Máximo por orden' },
  { key: 'dailyLossUsd', label: 'Pérdida diaria máxima' },
  { key: 'openPositions', label: 'Posiciones abiertas simultáneas' },
  { key: 'shortOrderUsd', label: 'Máximo por orden en corto' },
  { key: 'shortExposureUsd', label: 'Exposición corta total máxima' },
  { key: 'shortPositions', label: 'Posiciones cortas simultáneas' },
] as const;
type Field = keyof LiveLimits;
type Values = Record<Field, string>;
export const isPositionLimit = (key: Field) => key === 'openPositions' || key === 'shortPositions';
const isShortLimit = (key: Field) => key.startsWith('short');
const cap = (key: Field): number =>
  key === 'shortOrderUsd' || key === 'shortExposureUsd' || key === 'shortPositions'
    ? LIVE_FIXED_SHORT_CAPS[key]
    : LIVE_FIXED_CAPS[key];
function validate(key: Field, value: string) {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || (isShortLimit(key) ? n < 0 : n <= 0))
    return isShortLimit(key)
      ? 'Escribe un límite igual o mayor que cero.'
      : 'Escribe un límite mayor que cero.';
  if (isPositionLimit(key) && !Number.isInteger(n))
    return 'Escribe un número entero de posiciones.';
  if (n > cap(key))
    return `Tu límite supera el techo de ${isPositionLimit(key) ? `${cap(key)} posiciones` : usd(cap(key))}.`;
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
        LIMIT_FIELDS.map(({ key }) => [
          key,
          saved ? String(saved[key]) : isShortLimit(key) ? '0' : '',
        ]),
      ) as Values,
  );
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const errors = Object.fromEntries(
    LIMIT_FIELDS.map(({ key }) => [key, validate(key, values[key])]),
  ) as Record<Field, string>;
  const isDirty = (next: Values) =>
    !saved ||
    LIMIT_FIELDS.some(({ key }) => !!validate(key, next[key]) || Number(next[key]) !== saved[key]);
  const dirty = isDirty(values);
  return (
    <section className="live-sheet" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Límites de capital real</h3>
      <p>Tu valor debe ser igual o menor que el techo fijo.</p>
      <p>
        Corto con dinero real: desactivado mientras cualquiera de sus tres límites sea 0. Para
        habilitarlo, fija los tres límites y confirma la nueva frase por escrito.
      </p>
      <p>
        En corto la pérdida no tiene tope natural. Cada corto lleva un stop de compra obligatorio
        como máximo al {LIVE_FIXED_SHORT_CAPS.shortMaxStopPct} % por encima de la entrada; un salto
        de precio puede superar el stop. Alpaca exige una cuenta con margen y el corto habilitado,
        al menos 2 000 USD de capital y un título disponible para préstamo.
      </p>
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
                Techo fijo de esta fase: {isPositionLimit(key) ? cap(key) : usd(cap(key))}
              </small>
              <input
                id={`${id}-${key}`}
                type="number"
                inputMode={isPositionLimit(key) ? 'numeric' : 'decimal'}
                min={isShortLimit(key) ? 0 : isPositionLimit(key) ? 1 : 0.01}
                max={cap(key)}
                step={isPositionLimit(key) ? 1 : 'any'}
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
                  onDirty(isDirty(next));
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
