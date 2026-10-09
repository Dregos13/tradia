import { useEffect, useState } from 'react';
import { isRoutineConfig } from '../../../../shared/ipc';
import {
  ROUTINE_KINDS,
  ROUTINE_TIMEZONE,
  type RoutineConfig,
  type RoutineKind,
} from '../../../../shared/journal';
import { SettingsFeedback, SettingsSection } from './SettingsSection';

const labels: Record<RoutineKind, string> = {
  preapertura: 'Resumen previo a la apertura',
  cierre: 'Revisión al cierre',
  conciliacion: 'Conciliación',
};
export function RoutineSettings() {
  const [config, setConfig] = useState<RoutineConfig | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void window.tradia.routine
      .getConfig()
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch(() => {
        if (active) setError('No se pudieron cargar los horarios. Inténtalo de nuevo.');
      });
    return () => {
      active = false;
    };
  }, [retry]);
  async function save() {
    setMessage('');
    if (!isRoutineConfig(config)) {
      setError('Introduce las tres horas en formato HH:MM (24 horas).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setConfig(await window.tradia.routine.setConfig(config));
      setMessage('Horarios guardados.');
    } catch {
      setError('No se pudieron guardar los horarios. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsSection title="Rutina diaria" description="Horarios del mercado de Nueva York.">
      <p className="settings-message">
        Zona horaria: <span className="operational-data">{ROUTINE_TIMEZONE}</span>. Se adapta
        automáticamente al horario de verano.
      </p>
      {config ? (
        <form
          className="settings-form operational-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset className="channel-fields" disabled={busy}>
            {ROUTINE_KINDS.map((kind) => (
              <div className="routine-row" key={kind}>
                <label htmlFor={`routine-${kind}`}>{labels[kind]}</label>
                <input
                  id={`routine-${kind}`}
                  type="time"
                  value={config[kind]}
                  onChange={(e) => {
                    setConfig({ ...config, [kind]: e.target.value });
                    setMessage('');
                  }}
                />
              </div>
            ))}
            <div className="settings-actions">
              <button className="button primary" type="submit">
                {busy ? 'Guardando…' : 'Guardar horarios'}
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        !error && (
          <p className="settings-message" role="status">
            Cargando horarios…
          </p>
        )
      )}
      {!config && error && (
        <button className="button" onClick={() => setRetry((value) => value + 1)}>
          Reintentar horarios
        </button>
      )}
      <p className="settings-message">
        No se envía en fines de semana ni festivos de mercado. Si el equipo estaba dormido, se envía
        al despertar con la marca «Con retraso».
      </p>
      <SettingsFeedback error={error} message={message} />
    </SettingsSection>
  );
}
