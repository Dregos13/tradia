import { useState } from 'react';
import { DELIVERY_EVENT_KINDS, type DeliveryEventKind } from '../../../../shared/journal';

const eventLabels: Record<DeliveryEventKind, string> = {
  'senal-aprobada': 'Señal aprobada',
  'senal-vetada': 'Señal vetada',
  'limite-alcanzado': 'Límite alcanzado',
  'resumen-diario': 'Resúmenes diarios',
};
export function EventFields({
  events,
  onChange,
}: {
  events: DeliveryEventKind[];
  onChange: (value: DeliveryEventKind[]) => void;
}) {
  return (
    <fieldset className="channel-events">
      <legend>Eventos enviados</legend>
      {DELIVERY_EVENT_KINDS.map((event) => (
        <label key={event}>
          <input
            type="checkbox"
            checked={events.includes(event)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...events, event] : events.filter((item) => item !== event),
              )
            }
          />
          {eventLabels[event]}
        </label>
      ))}
    </fieldset>
  );
}
export function SecretField({
  label,
  id,
  stored,
  value,
  onChange,
}: {
  label: string;
  id: string;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const [replace, setReplace] = useState(false);
  return (
    <div className="channel-field">
      {stored && !replace ? (
        <>
          <span>{label}</span>
          <div className="settings-actions">
            <span className="online">Guardado</span>
            <button className="button" type="button" onClick={() => setReplace(true)}>
              Reemplazar {label.toLowerCase()}
            </button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {stored && (
            <span className="online">Guardado; deja el campo vacío para conservarlo.</span>
          )}
        </>
      )}
    </div>
  );
}
