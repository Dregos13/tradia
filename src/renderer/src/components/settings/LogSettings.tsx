import { useState } from 'react';
import { LOG_MAX_FILES, LOG_MAX_FILE_BYTES } from '../../../../shared/journal';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
export function LogSettings() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [path, setPath] = useState('');
  async function open() {
    setBusy(true);
    setError('');
    setMessage('');
    setPath('');
    try {
      const result = await window.tradia.logs.openFolder();
      if (result.ok) setMessage('Carpeta de registros abierta.');
      else {
        setPath(result.path);
        setError(
          'El sistema no pudo abrir la carpeta. Puedes copiar la ruta y abrirla manualmente.',
        );
      }
    } catch {
      setError('No se pudo abrir la carpeta de registros. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setMessage('Ruta copiada.');
    } catch {
      setError('No se pudo copiar. Selecciona la ruta y cópiala manualmente.');
    }
  }
  return (
    <SettingsSection title="Registros" description="Diagnóstico local con secretos ocultos.">
      <div className="setting-row backup-header">
        <div>
          <strong>Registros de diagnóstico</strong>
          <p>
            Se guardan localmente y se rotan automáticamente ({LOG_MAX_FILES} archivos de hasta{' '}
            {LOG_MAX_FILE_BYTES / (1024 * 1024)} MB). Los secretos se ocultan.
          </p>
        </div>
        <button className="button" disabled={busy} onClick={() => void open()}>
          {busy ? 'Abriendo…' : 'Abrir carpeta de registros'}
        </button>
      </div>
      {path && (
        <div className="settings-form">
          <label htmlFor="logs-path">Ruta de los registros</label>
          <input id="logs-path" readOnly value={path} onFocus={(e) => e.target.select()} />
          <button className="button" onClick={() => void copy()}>
            Copiar ruta
          </button>
        </div>
      )}
      <SettingsFeedback error={error} message={message} />
    </SettingsSection>
  );
}
