import { useId, useState } from 'react';
import {
  LIVE_DECLARATION_TEXTS,
  type LiveChecklistItem,
  type LiveDeclarationRequirement,
  type LiveDeclareRequest,
} from '../../../../shared/live';

export const CONTINGENCY_TEMPLATE =
  'Caída de internet: cómo detener órdenes y contactar al broker.\nCaída del broker: canal alternativo, órdenes y posiciones pendientes.\nFallo del equipo: acceso alternativo y recuperación.\nResponsable y contacto de emergencia: \nConciliación y condiciones para reanudar: ';

export function DeclarationForm({
  item,
  requirement,
  disabled,
  onDeclare,
}: {
  item: LiveChecklistItem;
  requirement: LiveDeclarationRequirement;
  disabled: boolean;
  onDeclare: (request: LiveDeclareRequest) => Promise<boolean>;
}) {
  const id = useId();
  const [confirmed, setConfirmed] = useState(item.state === 'cumplido');
  const [detail, setDetail] = useState(item.declarationDetail ?? '');
  const [error, setError] = useState('');
  const plan = requirement === 'plan-contingencia';
  return (
    <form
      className="live-declaration"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        if (confirmed && plan && !detail.trim()) {
          setError('Documenta el plan o indica su ruta local antes de declararlo.');
          return;
        }
        if (detail.length > 1000) {
          setError('El detalle admite como máximo 1.000 caracteres.');
          return;
        }
        setError('');
        void onDeclare({ requirement, confirmed, detail: detail.trim() });
      }}
    >
      <label className="live-checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {LIVE_DECLARATION_TEXTS[requirement]}
      </label>
      <label htmlFor={`${id}-detail`}>
        {plan ? 'Plan de contingencia o ruta local' : 'Nota o referencia local (opcional)'}
      </label>
      <textarea
        id={`${id}-detail`}
        value={detail}
        maxLength={1000}
        rows={plan ? 5 : 2}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        onChange={(event) => {
          setDetail(event.target.value);
          setError('');
        }}
      />
      <small id={`${id}-hint`}>
        {plan
          ? 'Revisa la plantilla y completa los procedimientos y contactos. Máximo 1.000 caracteres.'
          : 'Máximo 1.000 caracteres. La declaración se guarda con fecha.'}
      </small>
      {error && (
        <p id={`${id}-error`} className="live-field-error" role="alert">
          {error}
        </p>
      )}
      <div className="live-actions">
        {plan && (
          <button
            type="button"
            className="button"
            disabled={disabled || !!detail.trim()}
            onClick={() => setDetail(CONTINGENCY_TEMPLATE)}
          >
            Usar plantilla de contingencia
          </button>
        )}
        <button
          className="button"
          type="submit"
          disabled={disabled || (!confirmed && item.state !== 'cumplido')}
        >
          {!confirmed && item.state === 'cumplido'
            ? 'Guardar retirada de declaración'
            : 'Guardar declaración'}
        </button>
      </div>
      {item.state === 'cumplido' && (
        <small>Retirar esta declaración suspende las nuevas órdenes reales.</small>
      )}
    </form>
  );
}
