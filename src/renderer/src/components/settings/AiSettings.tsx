import { useEffect, useRef, useState } from 'react';
import {
  NEWS_LLM_DAILY_CAP_BOUNDS,
  type NewsLlmSettings,
  type NewsAnalyzer,
} from '../../../../shared/ai';
import { isNewsLlmSettingsInput } from '../../../../shared/ipc';
import { useSystemState } from '../../hooks/useSystemState';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
import './settings.css';

export function AiSettings() {
  const [settings, setSettings] = useState<NewsLlmSettings | null>(null);
  const [provider, setProvider] = useState<NewsAnalyzer>('local');
  const [cliPath, setCliPath] = useState('');
  const testAfterSave = useRef(false);
  const enabled = provider !== 'local';
  const [cap, setCap] = useState('200');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const saveButton = useRef<HTMLButtonElement>(null);
  const { connectivity } = useSystemState();
  const offline = connectivity?.status === 'offline';
  const input = {
    enabled,
    provider,
    cliPath: cliPath.trim() || null,
    dailyCap: Number(cap),
  };
  const valid = cap.trim() !== '' && isNewsLlmSettingsInput(input);
  function apply(value: NewsLlmSettings) {
    setSettings(value);
    // Un 'llm' heredado ya no es elegible: la API de pago se retiró.
    setProvider(value.provider === 'llm' ? 'local' : value.provider);
    setCliPath(value.cliPath ?? '');
    setCap(String(value.dailyCap));
  }
  useEffect(() => {
    let active = true;
    void window.tradia.ai
      .getLlmSettings()
      .then((value) => {
        if (active) apply(value);
      })
      .catch(() => {
        if (active) setError('No se pudieron cargar los ajustes de análisis. Reintenta.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const off = window.tradia.ai.onChanged((event) => {
      if (event.kind === 'noticias')
        void window.tradia.ai
          .getLlmSettings()
          .then((value) => {
            if (active) setSettings(value);
          })
          .catch(() => {
            if (active)
              setError('No se pudo actualizar el uso del análisis. Reintenta guardar los ajustes.');
          });
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  async function reload() {
    setLoading(true);
    setError('');
    try {
      apply(await window.tradia.ai.getLlmSettings());
    } catch {
      setError('No se pudieron cargar los ajustes de análisis. Reintenta.');
    } finally {
      setLoading(false);
    }
  }
  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      apply(await window.tradia.ai.setLlmSettings(input));
      setMessage('Ajustes de análisis guardados.');
      if (testAfterSave.current) await test();
    } catch {
      setError('No se pudieron guardar los ajustes. Reintenta.');
    } finally {
      testAfterSave.current = false;
      setBusy(false);
      saveButton.current?.focus();
    }
  }
  async function test() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await window.tradia.ai.testLlm();
      if (result.ok)
        setMessage(
          provider === 'local'
            ? 'Análisis local disponible · sin coste.'
            : 'Suscripción disponible.',
        );
      else setError(result.error ?? 'No se pudo usar la suscripción. Reintenta.');
    } catch {
      setError('No se pudo usar la suscripción. Reintenta.');
    } finally {
      setBusy(false);
    }
  }
  function requestSave(probe = false) {
    if (!valid || busy) return;
    testAfterSave.current = probe;
    void save();
  }
  return (
    <SettingsSection
      title="Análisis de noticias"
      description="Elige la suscripción de Claude Code o el analizador local. Las noticias no crean señales por sí solas."
    >
      <div aria-busy={loading || busy}>
        {loading ? (
          <p role="status">Cargando ajustes de análisis…</p>
        ) : (
          settings && (
            <form
              className="settings-form operational-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid) {
                  setError('Introduce un máximo diario entero entre 1 y 2000.');
                  return;
                }
                requestSave();
              }}
            >
              <fieldset className="channel-fields" disabled={busy}>
                <div className="channel-field">
                  <label htmlFor="llm-provider">Proveedor de análisis</label>
                  <select
                    id="llm-provider"
                    value={provider}
                    onChange={(event) => {
                      setProvider(event.target.value as NewsAnalyzer);
                      setError('');
                      setMessage('');
                    }}
                  >
                    <option value="suscripcion">Suscripción (Claude Code)</option>
                    <option value="local">Analizador local</option>
                  </select>
                </div>
                {provider === 'suscripcion' && !settings.cliAvailable && (
                  <p role="status">
                    CLI no detectada. Recomendamos el analizador local mientras configuras Claude
                    Code.
                  </p>
                )}
                {provider === 'suscripcion' && (
                  <p>
                    Para iniciar sesión en Claude Code, ejecuta <code>claude</code> y después{' '}
                    <code>/login</code> con tu suscripción.
                  </p>
                )}
                {provider === 'suscripcion' && (
                  <div className="channel-field">
                    <label htmlFor="llm-cli-path">Ruta de la CLI (opcional)</label>
                    <input
                      id="llm-cli-path"
                      type="text"
                      value={cliPath}
                      maxLength={1024}
                      aria-describedby="llm-cli-help"
                      onChange={(event) => setCliPath(event.target.value)}
                    />
                    <p id="llm-cli-help">
                      Déjala vacía para detectar claude automáticamente. Si falla la suscripción, se
                      usa el analizador local.
                    </p>
                  </div>
                )}
                {provider === 'local' && (
                  <p>Análisis local sin coste; no necesita clave de API ni sesión de CLI.</p>
                )}
                {provider === 'suscripcion' && (
                  <div className="channel-field">
                    <label htmlFor="llm-cap">Máximo diario de titulares</label>
                    <input
                      id="llm-cap"
                      type="number"
                      min={NEWS_LLM_DAILY_CAP_BOUNDS.min}
                      max={NEWS_LLM_DAILY_CAP_BOUNDS.max}
                      step="1"
                      value={cap}
                      onChange={(event) => setCap(event.target.value)}
                    />
                  </div>
                )}
                {provider === 'suscripcion' && (
                  <p className="operational-data">
                    Hoy: {settings.usedToday} de {settings.dailyCap} titulares
                  </p>
                )}
                {provider === 'suscripcion' && settings.usedToday >= settings.dailyCap && (
                  <p role="status">Tope diario alcanzado · se mantiene el analizador local.</p>
                )}
                {offline && provider !== 'local' && (
                  <p role="status">Sin conexión · la prueba está pausada.</p>
                )}
                <p>Probar guarda estos ajustes y comprueba el proveedor elegido.</p>
                <div className="settings-actions">
                  <button
                    className="button"
                    type="button"
                    disabled={!valid || (provider !== 'local' && offline)}
                    onClick={() => requestSave(true)}
                  >
                    Probar
                  </button>
                  <button
                    ref={saveButton}
                    className="button primary"
                    type="submit"
                    disabled={!valid}
                  >
                    Guardar ajustes
                  </button>
                </div>
              </fieldset>
            </form>
          )
        )}
        {busy && <p role="status">Comprobando o guardando el análisis…</p>}
        <SettingsFeedback error={error} message={message} />
        {!loading && !settings && (
          <button className="button" onClick={() => void reload()}>
            Reintentar ajustes
          </button>
        )}
      </div>
    </SettingsSection>
  );
}
