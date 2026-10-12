import { useEffect, useRef, useState } from 'react';
import {
  NEWS_LLM_DAILY_CAP_BOUNDS,
  type NewsLlmSettings,
  type NewsProvider,
} from '../../../../shared/ai';
import { isNewsLlmSettingsInput } from '../../../../shared/ipc';
import { SubscriptionNotice } from '../news/SubscriptionNotice';
import { useNewsStatus } from '../../hooks/useNewsStatus';
import { useSystemState } from '../../hooks/useSystemState';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
import './settings.css';

export function AiSettings() {
  const [settings, setSettings] = useState<NewsLlmSettings | null>(null);
  const [provider, setProvider] = useState<NewsProvider>('local');
  const [cliPath, setCliPath] = useState('');
  const testAfterSave = useRef(false);
  const enabled = provider !== 'local';
  const [cap, setCap] = useState('200');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [noticeRetryActive, setNoticeRetryActive] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const newsStatus = useNewsStatus();
  const failedSubscription =
    newsStatus.status?.provider === 'suscripcion' && newsStatus.status.state !== 'ok';
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
      const probed = testAfterSave.current;
      testAfterSave.current = false;
      setBusy(false);
      if (!probed) saveButton.current?.focus();
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
            : 'Suscripción disponible · Claude Code responde y la sesión está iniciada. El analizador local queda como respaldo.',
        );
      else setError(result.error ?? 'No se pudo usar la suscripción. Reintenta.');
      await newsStatus.refresh();
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
              <fieldset className="channel-fields">
                <fieldset className="analyzer-choices" disabled={busy}>
                  <legend>Proveedor de análisis</legend>
                  {(['suscripcion', 'local'] as const).map((choice) => (
                    <label key={choice} className="analyzer-choice">
                      <input
                        type="radio"
                        name="news-provider"
                        value={choice}
                        checked={provider === choice}
                        onChange={() => {
                          setProvider(choice);
                          setError('');
                          setMessage('');
                        }}
                      />
                      <span>
                        <strong>
                          {choice === 'suscripcion'
                            ? 'Suscripción (Claude Code)'
                            : 'Analizador local'}
                        </strong>
                        <span>
                          {choice === 'suscripcion'
                            ? 'Usa la sesión iniciada en este equipo. Si falla, Tradia continúa con el analizador local.'
                            : 'Funciona sin sesión. Es más limitado, pero mantiene el análisis básico en el equipo.'}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {provider === 'suscripcion' && (
                  <div className="channel-field">
                    <label htmlFor="llm-cli-path">Ruta de Claude Code (opcional)</label>
                    <input
                      disabled={busy}
                      id="llm-cli-path"
                      type="text"
                      value={cliPath}
                      maxLength={1024}
                      aria-describedby="llm-cli-help"
                      onChange={(event) => setCliPath(event.target.value)}
                    />
                    <p id="llm-cli-help">Déjala vacía para buscar claude automáticamente.</p>
                  </div>
                )}
                {provider === 'local' && (
                  <div>
                    <strong>Analizador local seleccionado</strong>
                    <p>
                      No necesita sesión y seguirá funcionando aunque Claude Code no esté
                      disponible.
                    </p>
                  </div>
                )}
                {provider === 'suscripcion' && (
                  <div className="channel-field">
                    <label htmlFor="llm-cap">Máximo diario</label>
                    <input
                      disabled={busy}
                      id="llm-cap"
                      type="number"
                      min={NEWS_LLM_DAILY_CAP_BOUNDS.min}
                      max={NEWS_LLM_DAILY_CAP_BOUNDS.max}
                      step="1"
                      value={cap}
                      aria-describedby="llm-cap-help"
                      aria-invalid={!valid}
                      onChange={(event) => setCap(event.target.value)}
                    />
                    <p id="llm-cap-help">Titulares por día. Introduce un entero entre 1 y 2000.</p>
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
                <SubscriptionNotice
                  status={newsStatus.status}
                  error={newsStatus.error}
                  busy={busy && testAfterSave.current && noticeRetryActive}
                  context="ajustes"
                  canRetry={valid && !(provider !== 'local' && offline)}
                  onRetry={() => {
                    setNoticeRetryActive(true);
                    requestSave(true);
                  }}
                />
                <p>Probar guarda estos ajustes y comprueba el proveedor elegido.</p>
                <div className="settings-actions">
                  {!failedSubscription && !newsStatus.error && !noticeRetryActive && (
                    <button
                      className="button"
                      type="button"
                      aria-disabled={busy}
                      disabled={!valid || (provider !== 'local' && offline)}
                      onClick={() => requestSave(true)}
                    >
                      {busy && testAfterSave.current ? 'Probando…' : 'Probar de nuevo'}
                    </button>
                  )}
                  <button
                    ref={saveButton}
                    className="button primary"
                    type="submit"
                    disabled={busy || !valid}
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
