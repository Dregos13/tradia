import { useEffect, useRef, useState } from 'react';
import {
  NEWS_LLM_DAILY_CAP_BOUNDS,
  type NewsEngine,
  type NewsLlmSettings,
  type NewsLlmSettingsInput,
  type NewsProvider,
} from '../../../../shared/ai';
import { isNewsLlmSettingsInput } from '../../../../shared/ipc';
import { SubscriptionNotice } from '../news/SubscriptionNotice';
import { useNewsStatus } from '../../hooks/useNewsStatus';
import { useSystemState } from '../../hooks/useSystemState';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
import './settings.css';

export interface EngineSpec {
  id: NewsEngine;
  name: string;
  label: string;
  cliCmd: string;
  description: string;
  defaultPlaceholder: string;
}

export const ENGINE_SPECS: Record<NewsEngine, EngineSpec> = {
  'suscripcion-claude': {
    id: 'suscripcion-claude',
    name: 'Claude Code',
    label: 'Claude Code (Suscripción en este equipo)',
    cliCmd: 'claude',
    description:
      'Utiliza la sesión iniciada en este equipo mediante Claude CLI. Tradia analiza noticias sin costes de API.',
    defaultPlaceholder: '/usr/local/bin/claude',
  },
  'suscripcion-codex': {
    id: 'suscripcion-codex',
    name: 'OpenAI Codex',
    label: 'OpenAI Codex (Suscripción de OpenAI)',
    cliCmd: 'codex',
    description:
      'Utiliza la sesión iniciada en OpenAI Codex CLI. El analizador procesa titulares con tu cuenta.',
    defaultPlaceholder: '/usr/local/bin/codex',
  },
  'suscripcion-antigravity': {
    id: 'suscripcion-antigravity',
    name: 'Google Antigravity',
    label: 'Google Antigravity (Suscripción de Google)',
    cliCmd: 'agy',
    description:
      'Utiliza el entorno configurado de Google Antigravity CLI para el análisis de noticias.',
    defaultPlaceholder: '/usr/local/bin/agy',
  },
  'suscripcion-copilot': {
    id: 'suscripcion-copilot',
    name: 'GitHub Copilot',
    label: 'GitHub Copilot (Suscripción de GitHub)',
    cliCmd: 'copilot',
    description:
      'Utiliza la CLI de GitHub Copilot para evaluar el impacto de los titulares de mercado.',
    defaultPlaceholder: '/usr/local/bin/copilot',
  },
  local: {
    id: 'local',
    name: 'Analizador local',
    label: 'Analizador local (Sin suscripción · En este equipo)',
    cliCmd: '',
    description:
      'Analizador léxico básico integrado. No requiere conexión externa, suscripciones ni comandos CLI.',
    defaultPlaceholder: '',
  },
};

export function AiSettings() {
  const [settings, setSettings] = useState<NewsLlmSettings | null>(null);
  const [engine, setEngine] = useState<NewsEngine>('local');
  // CLI que activa el radio «Suscripción» cuando el motor actual es el analizador local.
  const [subscriptionEngine, setSubscriptionEngine] =
    useState<Exclude<NewsEngine, 'local'>>('suscripcion-claude');
  const [cliPath, setCliPath] = useState('');
  const testAfterSave = useRef(false);
  const enabled = engine !== 'local';
  const provider: NewsProvider = engine === 'local' ? 'local' : 'suscripcion';
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

  const input: NewsLlmSettingsInput = {
    enabled,
    provider,
    engine,
    cliPath: cliPath.trim() || null,
    dailyCap: Number(cap),
  };
  const valid = cap.trim() !== '' && isNewsLlmSettingsInput(input);

  function apply(value: NewsLlmSettings) {
    setSettings(value);
    const resolvedEngine: NewsEngine =
      value.provider === 'llm' || value.provider === 'local'
        ? 'local'
        : value.engine && value.engine !== 'local'
          ? value.engine
          : 'suscripcion-claude';
    setEngine(resolvedEngine);
    const detected = value.engines?.find((entry) => entry.id !== 'local' && entry.available)?.id;
    setSubscriptionEngine(
      resolvedEngine !== 'local'
        ? resolvedEngine
        : ((detected as Exclude<NewsEngine, 'local'> | undefined) ?? 'suscripcion-claude'),
    );
    setCliPath(value.cliPath ?? '');
    setCap(String(value.dailyCap));
  }

  function handleEngineChange(nextEngine: NewsEngine) {
    setEngine(nextEngine);
    if (nextEngine !== 'local') setSubscriptionEngine(nextEngine);
    setError('');
    setMessage('');
    setNoticeRetryActive(false);
    const engineEntry = settings?.engines?.find((e) => e.id === nextEngine);
    if (engineEntry?.configuredPath !== undefined && engineEntry.configuredPath !== null) {
      setCliPath(engineEntry.configuredPath);
    } else if (nextEngine === settings?.engine) {
      setCliPath(settings?.cliPath ?? '');
    } else {
      setCliPath('');
    }
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
      if (result.ok) {
        const msText = result.latencyMs != null ? ` (latencia ${result.latencyMs} ms)` : '';
        setMessage(
          engine === 'local'
            ? 'Análisis local disponible · sin coste.'
            : `Suscripción disponible · ${ENGINE_SPECS[engine].name} responde y la sesión está iniciada${msText}. El analizador local queda como respaldo.`,
        );
      } else {
        setError(result.error ?? 'No se pudo usar la suscripción. Reintenta.');
      }
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

  const engineStatus = settings?.engines?.find((e) => e.id === engine);
  const isDetected =
    engineStatus?.available ?? (engine === settings?.engine ? settings?.cliAvailable : false);
  const resolvedPath =
    engineStatus?.resolvedPath ??
    (isDetected && cliPath ? cliPath : (engineStatus?.configuredPath ?? null));
  const cmd = ENGINE_SPECS[engine].cliCmd;

  return (
    <SettingsSection
      title="Análisis de noticias"
      description="Configura la suscripción de IA que Tradia usará para evaluar titulares de mercado o mantén el analizador local."
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
                <fieldset
                  className="channel-events news-origin"
                  aria-describedby="news-origin-help"
                >
                  <legend>Origen del análisis</legend>
                  <label>
                    <input
                      type="radio"
                      name="news-origin"
                      disabled={busy}
                      checked={engine !== 'local'}
                      onChange={() => handleEngineChange(subscriptionEngine)}
                    />
                    {`Suscripción (${ENGINE_SPECS[subscriptionEngine].name})`}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="news-origin"
                      disabled={busy}
                      checked={engine === 'local'}
                      onChange={() => handleEngineChange('local')}
                    />
                    Analizador local
                  </label>
                  <p id="news-origin-help" className="help-text news-origin-help">
                    La suscripción usa la sesión de tu CLI, sin API de pago; el analizador local
                    queda siempre como respaldo.
                  </p>
                </fieldset>
                <div className="channel-field">
                  <label htmlFor="news-provider-select">Motor de análisis de noticias</label>
                  <select
                    id="news-provider-select"
                    disabled={busy}
                    value={engine}
                    aria-describedby="provider-desc"
                    onChange={(event) => handleEngineChange(event.target.value as NewsEngine)}
                  >
                    <option value="suscripcion-claude">
                      Claude Code (Suscripción en este equipo)
                    </option>
                    <option value="suscripcion-codex">OpenAI Codex (Suscripción de OpenAI)</option>
                    <option value="suscripcion-antigravity">
                      Google Antigravity (Suscripción de Google)
                    </option>
                    <option value="suscripcion-copilot">
                      GitHub Copilot (Suscripción de GitHub)
                    </option>
                    <option value="local">
                      Analizador local (Sin suscripción · En este equipo)
                    </option>
                  </select>
                  <p id="provider-desc" className="help-text">
                    {ENGINE_SPECS[engine].description}
                  </p>
                </div>

                {engine !== 'local' && (
                  <div className="channel-field">
                    <label htmlFor="llm-cli-path">{`Ruta de ${ENGINE_SPECS[engine].name} (opcional)`}</label>
                    <div
                      className={`cli-detect-badge ${isDetected ? 'found' : 'not-found'}`}
                      role="status"
                      aria-live="polite"
                    >
                      <span aria-hidden="true">{isDetected ? '✓' : '!'}</span>
                      <span>
                        {isDetected
                          ? resolvedPath
                            ? `Ejecutable detectado automáticamente: ${resolvedPath}`
                            : `Ejecutable de ${cmd} disponible en el sistema.`
                          : `No se encontró el comando ${cmd} en las rutas estándar. Indica la ruta completa abajo.`}
                      </span>
                    </div>
                    <input
                      disabled={busy}
                      id="llm-cli-path"
                      type="text"
                      value={cliPath}
                      maxLength={1024}
                      placeholder={
                        ENGINE_SPECS[engine].defaultPlaceholder ||
                        'Ruta personalizada o vacía para búsqueda automática'
                      }
                      aria-describedby="llm-cli-help"
                      onChange={(event) => setCliPath(event.target.value)}
                    />
                    <p id="llm-cli-help">
                      {`Déjala vacía para buscar ${cmd} automáticamente en el sistema.`}
                    </p>
                  </div>
                )}

                {engine === 'local' && (
                  <div className="channel-field">
                    <strong>Analizador local preparado · Sin suscripción externa</strong>
                    <p>
                      El análisis léxico se realiza directamente en este ordenador sin necesidad de
                      cuentas ni herramientas de terceros.
                    </p>
                  </div>
                )}

                {engine !== 'local' && (
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

                {engine !== 'local' && (
                  <p className="operational-data">
                    Hoy: {settings.usedToday} de {settings.dailyCap} titulares
                  </p>
                )}

                {engine !== 'local' && settings.usedToday >= settings.dailyCap && (
                  <p role="status">Tope diario alcanzado · se mantiene el analizador local.</p>
                )}

                {offline && engine !== 'local' && (
                  <p role="status">Sin conexión · la prueba está pausada.</p>
                )}

                <SubscriptionNotice
                  status={newsStatus.status}
                  error={newsStatus.error}
                  busy={busy && testAfterSave.current && noticeRetryActive}
                  context="ajustes"
                  canRetry={valid && !(engine !== 'local' && offline)}
                  engine={engine}
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
                      disabled={!valid || (engine !== 'local' && offline)}
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
        {busy && (
          <p role="status" aria-live="polite">
            Comprobando o guardando el análisis…
          </p>
        )}
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
