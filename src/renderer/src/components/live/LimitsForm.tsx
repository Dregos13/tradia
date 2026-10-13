import { useId, useRef, useState } from 'react';
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
  shortBlocked = false,
  shortBlockReason,
  shortSaveError,
}: {
  saved: LiveLimits | null;
  disabled: boolean;
  onSave: (limits: LiveLimits) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
  confirmed?: boolean;
  shortBlocked?: boolean;
  shortBlockReason?: string;
  shortSaveError?: string;
}) {
  const id = useId();
  const firstShortRef = useRef<HTMLInputElement>(null);
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
  const shortRequested = LIMIT_FIELDS.some(
    ({ key }) => isShortLimit(key) && Number(values[key]) > 0,
  );
  const saveBlocked = shortBlocked && shortRequested;
  const partialShort =
    !shortBlocked &&
    shortRequested &&
    LIMIT_FIELDS.some(({ key }) => isShortLimit(key) && Number(values[key]) === 0);
  const shortReasonId = `${id}-short-block`;
  const shortErrorId = `${id}-short-save-error`;
  const renderField = ({ key, label }: (typeof LIMIT_FIELDS)[number]) => (
    <div className="live-field" key={key}>
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <small id={`${id}-${key}-cap`}>
        Techo fijo de esta fase: {isPositionLimit(key) ? cap(key) : usd(cap(key))}
      </small>
      <input
        id={`${id}-${key}`}
        ref={key === 'shortOrderUsd' ? firstShortRef : undefined}
        type="number"
        inputMode={isPositionLimit(key) ? 'numeric' : 'decimal'}
        min={isShortLimit(key) ? 0 : isPositionLimit(key) ? 1 : 0.01}
        max={cap(key)}
        step={isPositionLimit(key) ? 1 : 'any'}
        required
        disabled={!isShortLimit(key) && disabled}
        readOnly={isShortLimit(key) && (shortBlocked || disabled)}
        aria-disabled={isShortLimit(key) && (shortBlocked || disabled) ? true : undefined}
        value={values[key]}
        aria-invalid={!!(touched[key] && errors[key])}
        aria-describedby={`${id}-${key}-cap${isShortLimit(key) && (shortBlocked || disabled) ? ` ${shortReasonId}` : ''}${isShortLimit(key) && shortSaveError ? ` ${shortErrorId}` : ''}${touched[key] && errors[key] ? ` ${id}-${key}-error` : ''}`}
        onBlur={() => setTouched((old) => ({ ...old, [key]: true }))}
        onChange={(event) => {
          if (disabled || (isShortLimit(key) && shortBlocked)) return;
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
  );
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
          if (disabled || saveBlocked || partialShort || Object.values(errors).some(Boolean))
            return;
          void onSave(
            Object.fromEntries(
              LIMIT_FIELDS.map(({ key }) => [key, Number(values[key])]),
            ) as unknown as LiveLimits,
          ).then((ok) => {
            if (ok) onDirty(false);
          });
        }}
      >
        {(shortBlocked || disabled) && (
          <p id={shortReasonId} className="live-warning">
            {shortBlockReason ??
              'La edición de límites está bloqueada. Revisa la conexión y el estado de dinero real.'}
          </p>
        )}
        <fieldset className="live-limits-group">
          <legend>Límites generales</legend>
          <div className="live-limits-grid">
            {LIMIT_FIELDS.filter(({ key }) => !isShortLimit(key)).map(renderField)}
          </div>
        </fieldset>
        <fieldset className="live-limits-group">
          <legend>Límites propios del corto</legend>
          <p>
            Cada corto real exige una orden limitada y un stop de compra de protección, como máximo
            al 5 % por encima de la entrada. Un salto de precio puede superar el stop.
          </p>
          <div className="live-limits-grid">
            {LIMIT_FIELDS.filter(({ key }) => isShortLimit(key)).map(renderField)}
          </div>
          {shortSaveError && (
            <p id={shortErrorId} className="live-field-error" role="alert">
              {shortSaveError}
            </p>
          )}
          {shortBlocked && shortRequested && (
            <button
              className="button"
              type="button"
              disabled={disabled}
              aria-describedby={shortReasonId}
              onClick={() => {
                if (disabled) return;
                const next = {
                  ...values,
                  shortOrderUsd: '0',
                  shortExposureUsd: '0',
                  shortPositions: '0',
                };
                setValues(next);
                onDirty(isDirty(next));
                // The button unmounts once shortRequested is false: keep keyboard focus.
                firstShortRef.current?.focus();
              }}
            >
              Poner el corto a 0
            </button>
          )}
        </fieldset>
        {partialShort && (
          <p className="live-field-error" role="alert">
            Para habilitar el corto, fija los tres límites por encima de 0. Para mantenerlo
            desactivado, deja los tres a 0.
          </p>
        )}
        <button
          className="button"
          disabled={disabled || saveBlocked || partialShort || Object.values(errors).some(Boolean)}
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
