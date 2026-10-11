import { useEffect, useRef, useState } from 'react';
import {
  NEWS_LLM_MODEL,
  NEWS_LLM_SECRET_PROVIDER,
  NEWS_LLM_DAILY_CAP_BOUNDS,
  NEWS_LLM_MONTHLY_BUDGET_BOUNDS,
  type NewsLlmSettings,
  type NewsAnalyzer,
} from '../../../../shared/ai';
import { isNewsLlmSettingsInput } from '../../../../shared/ipc';
import { useSystemState } from '../../hooks/useSystemState';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
import { LlmSpendConfirmation } from './LlmSpendConfirmation';
import './settings.css';

const llmMoney = (value: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
export function AiSettings() {
  const [settings, setSettings] = useState<NewsLlmSettings | null>(null);
  const [provider, setProvider] = useState<NewsAnalyzer>('local');
  const [cliPath, setCliPath] = useState('');
  const testAfterSave = useRef(false);
  const enabled = provider !== 'local';
  const [cap, setCap] = useState('200');
  const [budget, setBudget] = useState('0');
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const { connectivity } = useSystemState();
  const offline = connectivity?.status === 'offline';
  const input = {
    enabled,
    provider,
    cliPath: cliPath.trim() || null,
    dailyCap: Number(cap),
    monthlyBudgetEur: Number(budget),
  };
  const valid =
    cap.trim() !== '' &&
    budget.trim() !== '' &&
    isNewsLlmSettingsInput(input) &&
    (provider !== 'llm' || !!(settings?.hasKey || key.trim()));
  function apply(value: NewsLlmSettings) {
    setSettings(value);
    setProvider(value.provider);
    setCliPath(value.cliPath ?? '');
    setCap(String(value.dailyCap));
    setBudget(String(value.monthlyBudgetEur));
  }
  useEffect(() => {
    let active = true;
    void window.tradia.ai
      .getLlmSettings()
      .then((value) => {
        if (active) apply(value);
      })
      .catch(() => {
        if (active) setError('No se pudieron cargar los ajustes del LLM. Reintenta.');
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
              setError('No se pudo actualizar el uso del LLM. Reintenta guardar los ajustes.');
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
      setError('No se pudieron cargar los ajustes del LLM. Reintenta.');
    } finally {
      setLoading(false);
    }
  }
  async function save() {
    if (!valid || busy) return;
    setConfirm(false);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (provider === 'llm' && key.trim()) {
        const draft = key.trim();
        setKey('');
        await window.tradia.secrets.setKey(NEWS_LLM_SECRET_PROVIDER, draft);
        setSettings((previous) => (previous ? { ...previous, hasKey: true } : previous));
        setEditing(false);
      }
      apply(await window.tradia.ai.setLlmSettings(input));
      setMessage('Ajustes del LLM guardados.');
      if (testAfterSave.current) await test();
    } catch {
      setError(
        'No se pudieron guardar los ajustes. Comprueba los permisos del llavero y reintenta.',
      );
    } finally {
      testAfterSave.current = false;
      setKey('');
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
            : 'Conexión correcta · proveedor disponible.',
        );
      else
        setError(
          result.error ?? 'No se pudo conectar. Revisa la clave y la conexión antes de reintentar.',
        );
    } catch {
      setError('No se pudo conectar. Revisa tu conexión y reintenta.');
    } finally {
      setBusy(false);
    }
  }
  function requestSave(probe = false) {
    if (!valid || busy) return;
    testAfterSave.current = probe;
    if (
      provider === 'llm' &&
      Number(budget) > 0 &&
      (settings?.provider !== 'llm' || Number(budget) > settings.monthlyBudgetEur)
    ) {
      setConfirm(true);
    } else void save();
  }
  return (
    <SettingsSection
      title="Análisis de noticias con LLM"
      description="Elige suscripción, análisis local o API opcional. Las noticias nunca crean señales por sí solas."
    >
      <div aria-busy={loading || busy}>
        {loading ? (
          <p role="status">Cargando ajustes del LLM…</p>
        ) : (
          settings && (
            <form
              className="settings-form operational-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid) {
                  setError(
                    'Introduce un máximo diario entero entre 1 y 2000, un tope mensual entre 0 y 30 € y, si eliges la API, una clave.',
                  );
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
                      setKey('');
                      setError('');
                      setMessage('');
                    }}
                  >
                    <option value="suscripcion">Suscripción (Claude Code)</option>
                    <option value="local">Local (sin coste)</option>
                    <option value="llm">API de Anthropic (opcional)</option>
                  </select>
                </div>
                {!settings.cliAvailable && (
                  <p role="status">
                    CLI no detectada. Recomendamos Local (sin coste) mientras configuras Claude
                    Code.
                  </p>
                )}
                <p>
                  Para iniciar sesión en Claude Code, ejecuta <code>claude</code> y después{' '}
                  <code>/login</code> con tu suscripción.
                </p>
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
                      usa el análisis local.
                    </p>
                  </div>
                )}
                {provider === 'local' && (
                  <p>Análisis local sin coste; no necesita clave de API ni sesión de CLI.</p>
                )}
                {provider === 'llm' && (
                  <>
                    <p>Modelo · {NEWS_LLM_MODEL} · puede generar cargos de Anthropic.</p>
                    {settings.hasKey && !editing ? (
                      <div className="setting-row">
                        <strong>Clave guardada de forma cifrada</strong>
                        <button type="button" className="button" onClick={() => setEditing(true)}>
                          Reemplazar clave
                        </button>
                      </div>
                    ) : (
                      <div className="channel-field">
                        <label htmlFor="llm-key">Clave de API de Anthropic</label>
                        <input
                          id="llm-key"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={key}
                          aria-describedby="llm-key-help"
                          onChange={(event) => setKey(event.target.value)}
                        />
                        <p id="llm-key-help">
                          Se cifra en el llavero del sistema y no vuelve a mostrarse.
                        </p>
                        {editing && (
                          <button
                            type="button"
                            className="button"
                            onClick={() => {
                              setEditing(false);
                              setKey('');
                            }}
                          >
                            Cancelar reemplazo
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div className="channel-grid">
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
                  {provider === 'llm' && (
                    <div className="channel-field">
                      <label htmlFor="llm-budget">Tope mensual (€)</label>
                      <input
                        id="llm-budget"
                        type="number"
                        min={NEWS_LLM_MONTHLY_BUDGET_BOUNDS.min}
                        max={NEWS_LLM_MONTHLY_BUDGET_BOUNDS.max}
                        step="0.01"
                        value={budget}
                        onChange={(event) => setBudget(event.target.value)}
                      />
                    </div>
                  )}
                </div>
                <p className="operational-data">
                  Hoy: {settings.usedToday} de {settings.dailyCap} titulares
                </p>
                {provider === 'llm' && (
                  <p className="operational-data">
                    Este mes: {llmMoney(settings.spentThisMonthEur)} de{' '}
                    {llmMoney(settings.monthlyBudgetEur)}
                  </p>
                )}
                {settings.usedToday >= settings.dailyCap && (
                  <p role="status">Tope diario alcanzado · se mantiene el análisis local.</p>
                )}
                {offline && provider !== 'local' && (
                  <p role="status">Sin conexión · la prueba del LLM está pausada.</p>
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
        {busy && <p role="status">Comprobando o guardando el LLM…</p>}
        <SettingsFeedback error={error} message={message} />
        {!loading && !settings && (
          <button className="button" onClick={() => void reload()}>
            Reintentar ajustes
          </button>
        )}
      </div>
      {confirm && (
        <LlmSpendConfirmation
          budget={Number(budget)}
          cap={Number(cap)}
          accept={() => void save()}
          close={() => {
            setConfirm(false);
            testAfterSave.current = false;
            saveButton.current?.focus();
          }}
        />
      )}
    </SettingsSection>
  );
}
