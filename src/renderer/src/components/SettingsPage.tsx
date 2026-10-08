import { DataProvidersSettings } from './DataProvidersSettings';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ALERT_LEAD_MINUTES,
  type AlertPrefs,
  NOTIFICATION_LEVELS,
  type NotificationLevel,
  type NotificationPrefs,
} from '../../../shared/ipc';
import type { SystemState } from '../hooks/useSystemState';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" aria-label={title}>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-panel">{children}</div>
    </section>
  );
}
function Switch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <label className="setting-switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
        />
        <span aria-hidden="true" className="switch-track" />
      </label>
    </div>
  );
}
const levels = { info: 'Información', alerta: 'Alerta', critica: 'Crítica' };
const descriptions = {
  info: 'Conexión recuperada y tareas completadas.',
  alerta: 'Pérdida de conexión o decisiones pausadas.',
  critica: 'Riesgo inmediato o fallo que requiere tu acción.',
};
function GeneralSettings({ state }: { state: SystemState }) {
  const [value, setValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      window.tradia.settings
        .get()
        .then((s) => {
          if (active) {
            setValue(s.autostart);
            setError('');
          }
        })
        .catch(() => {
          if (active)
            setError('No se pudo consultar el inicio automático. Vuelve a abrir Ajustes.');
        });
    void load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, []);
  async function toggle() {
    setBusy(true);
    setError('');
    try {
      setValue((await window.tradia.settings.set({ autostart: !value })).autostart);
    } catch {
      setError('No se pudo cambiar el inicio automático. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="General" description="Comportamiento de la aplicación y segundo plano.">
      <Switch
        label="Iniciar con el sistema"
        description="Tradia arrancará oculta en la bandeja al iniciar sesión."
        checked={value ?? false}
        disabled={value === null || busy}
        onChange={() => void toggle()}
      />
      {value === null && !error && (
        <p className="settings-message" role="status">
          Consultando inicio automático…
        </p>
      )}
      <div className="setting-row">
        <div>
          <strong>Agentes en segundo plano</strong>
          <p>El latido continúa aunque cierres la ventana.</p>
        </div>
        <span className={state.agents?.paused ? 'paused' : 'online'}>
          {state.agentsError
            ? 'No disponible'
            : !state.agents
              ? 'Cargando…'
              : state.agents.paused
                ? 'En pausa'
                : 'Activo'}
        </span>
      </div>
      {error && (
        <p className="settings-message error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [level, setLevel] = useState<NotificationLevel>('info');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void window.tradia.notifications
      .getPrefs()
      .then((p) => {
        if (active) setPrefs(p);
      })
      .catch(() => {
        if (active) setError('No se pudieron cargar las preferencias. Vuelve a abrir Ajustes.');
      });
    return () => {
      active = false;
    };
  }, []);
  async function toggle(key: NotificationLevel) {
    if (!prefs) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setPrefs(await window.tradia.notifications.setPrefs({ ...prefs, [key]: !prefs[key] }));
    } catch {
      setError('No se pudo guardar la preferencia. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await window.tradia.notifications.test(level);
      setMessage('Prueba enviada. Deberías verla en las notificaciones del sistema.');
    } catch {
      setError(
        'No se pudo enviar la prueba. Revisa los permisos de notificaciones del sistema e inténtalo de nuevo.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Notificaciones" description="Elige qué niveles pueden interrumpirte.">
      {NOTIFICATION_LEVELS.map((key) => (
        <Switch
          key={key}
          label={`Notificaciones: ${levels[key]}`}
          description={descriptions[key]}
          checked={prefs?.[key] ?? false}
          disabled={!prefs || busy}
          onChange={() => void toggle(key)}
        />
      ))}
      {!prefs && !error && (
        <p className="settings-message" role="status">
          Cargando preferencias…
        </p>
      )}
      <div className="settings-test">
        <select
          aria-label="Nivel de la notificación de prueba"
          value={level}
          disabled={busy}
          onChange={(e) => {
            setLevel(e.target.value as NotificationLevel);
            setMessage('');
          }}
        >
          {NOTIFICATION_LEVELS.map((key) => (
            <option key={key} value={key}>
              {levels[key]}
            </option>
          ))}
        </select>
        <button
          className="button primary"
          disabled={!prefs || busy || !prefs[level]}
          onClick={() => void test()}
        >
          Enviar prueba
        </button>
      </div>
      {prefs && !prefs[level] && (
        <p className="settings-message">
          Activa las notificaciones de {levels[level].toLowerCase()} para enviar la prueba.
        </p>
      )}
      {message && (
        <p className="settings-message success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="settings-message error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
function NewsAlertSettings() {
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void window.tradia.alerts
      .getPrefs()
      .then((value) => {
        if (active) setPrefs(value);
      })
      .catch(() => {
        if (active)
          setError('No se pudieron cargar los avisos de noticias. Vuelve a abrir Ajustes.');
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(value: string) {
    const leadMinutes = ALERT_LEAD_MINUTES.find((minutes) => String(minutes) === value);
    if (!prefs || leadMinutes === undefined || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setPrefs(await window.tradia.alerts.setPrefs({ leadMinutes }));
      setMessage('Antelación guardada.');
    } catch {
      setError('No se pudo guardar la antelación. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="Avisos de noticias"
      description="Antelación de los avisos de eventos de alto impacto, también en segundo plano."
    >
      <div className="settings-form" aria-busy={busy}>
        <label htmlFor="news-alert-lead">Minutos de antelación</label>
        <select
          id="news-alert-lead"
          value={prefs?.leadMinutes ?? 30}
          disabled={!prefs || busy}
          onChange={(e) => void save(e.target.value)}
        >
          {ALERT_LEAD_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minutos
            </option>
          ))}
        </select>
      </div>
      <p className="settings-message">
        Los avisos de noticias críticas siguen el interruptor «Notificaciones: Crítica» de la
        sección Notificaciones.
      </p>
      {!prefs && !error && <p role="status">Cargando avisos de noticias…</p>}
      {message && (
        <p className="settings-message success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="settings-message error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
function ApiKeys() {
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [stored, setStored] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setStored(null);
    setError('');
    setMessage('');
    if (provider.trim())
      void window.tradia.secrets
        .hasKey(provider.trim())
        .then((value) => {
          if (active) setStored(value);
        })
        .catch(() => {
          if (active)
            setError('No se pudo comprobar la clave guardada. Vuelve a seleccionar el proveedor.');
        });
    return () => {
      active = false;
    };
  }, [provider]);
  async function save() {
    if (!provider.trim() || !key.trim()) {
      setError('Introduce un proveedor y una clave nueva.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const submittedKey = key;
    setKey('');
    try {
      await window.tradia.secrets.setKey(provider.trim(), submittedKey);
      setStored(true);
    } catch (cause) {
      setError(
        cause instanceof Error && /safeStorage|cifrado|llavero/i.test(cause.message)
          ? 'No se puede guardar: el cifrado seguro del sistema (safeStorage) no está disponible. Activa el llavero del sistema e inténtalo de nuevo. La clave no se ha guardado.'
          : 'No se pudo guardar la clave. Comprueba el almacén local e inténtalo de nuevo.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await window.tradia.secrets.deleteKey(provider.trim());
      setStored(false);
      setKey('');
      setMessage('Clave borrada.');
    } catch {
      setError('No se pudo borrar la clave. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="Claves de API"
      description="Se cifran con el llavero del sistema y nunca vuelven a mostrarse."
    >
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor="api-provider">Proveedor</label>
        <input
          id="api-provider"
          value={provider}
          disabled={busy}
          autoComplete="off"
          onChange={(e) => {
            setProvider(e.target.value);
            setKey('');
          }}
          placeholder="Nombre del proveedor"
        />
        <label htmlFor="api-key">Clave nueva</label>
        <div className="settings-controls">
          <input
            id="api-key"
            type="password"
            value={key}
            disabled={busy}
            autoComplete="new-password"
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="button primary" disabled={busy} type="submit">
            Guardar clave
          </button>
        </div>
        <div className="key-state">
          <span role="status" className={stored ? 'online' : undefined}>
            {!provider.trim()
              ? 'Indica un proveedor para gestionar su clave.'
              : stored === null
                ? 'Comprobando clave…'
                : stored
                  ? 'Guardada (cifrada)'
                  : 'Sin clave guardada'}
          </span>
          <button
            className="button danger"
            type="button"
            disabled={busy || !stored}
            onClick={() => void remove()}
          >
            Borrar clave
          </button>
        </div>
      </form>
      {message && (
        <p className="settings-message success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="settings-message error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
export function SettingsPage({ state }: { state: SystemState }) {
  return (
    <section aria-label="Preferencias">
      <div className="headline">
        <h2>Tu aplicación, bajo tus reglas.</h2>
        <p>Controla el arranque, las interrupciones y las credenciales locales.</p>
      </div>
      <GeneralSettings state={state} />
      <NotificationSettings />
      <NewsAlertSettings />
      <DataProvidersSettings />
      <ApiKeys />
    </section>
  );
}
