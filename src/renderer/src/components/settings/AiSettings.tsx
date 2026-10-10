import { useEffect, useRef, useState } from 'react';
import {
  NEWS_LLM_MODEL,
  NEWS_LLM_SECRET_PROVIDER,
  NEWS_LLM_DAILY_CAP_BOUNDS,
  NEWS_LLM_MONTHLY_BUDGET_BOUNDS,
  type NewsLlmSettings,
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
  const [enabled, setEnabled] = useState(false);
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
  const input = { enabled, dailyCap: Number(cap), monthlyBudgetEur: Number(budget) };
  const valid =
    cap.trim() !== '' &&
    budget.trim() !== '' &&
    isNewsLlmSettingsInput(input) &&
    (!enabled || !!(settings?.hasKey || key.trim()));
  function apply(value: NewsLlmSettings) {
    setSettings(value);
    setEnabled(value.enabled);
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
      if (key.trim()) {
        const draft = key.trim();
        setKey('');
        await window.tradia.secrets.setKey(NEWS_LLM_SECRET_PROVIDER, draft);
        setSettings((previous) => (previous ? { ...previous, hasKey: true } : previous));
        setEditing(false);
      }
      apply(await window.tradia.ai.setLlmSettings(input));
      setMessage('Ajustes del LLM guardados.');
    } catch {
      setError(
        'No se pudieron guardar los ajustes. Comprueba los permisos del llavero y reintenta.',
      );
    } finally {
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
      if (result.ok) setMessage('Conexión correcta · la clave se ha guardado cifrada');
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
  return (
    <SettingsSection
      title="Análisis de noticias con LLM"
      description="Controla el uso de Anthropic y su gasto. Las noticias nunca crean señales por sí solas."
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
                    'Introduce un máximo diario entero entre 1 y 2000, un tope mensual entre 0 y 30 € y una clave para activar el LLM.',
                  );
                  return;
                }
                if (
                  Number(budget) > 0 &&
                  ((enabled && !settings.enabled) || Number(budget) > settings.monthlyBudgetEur)
                )
                  setConfirm(true);
                else void save();
              }}
            >
              <fieldset className="channel-fields" disabled={busy}>
                <div className="setting-row">
                  <div>
                    <label htmlFor="llm-enabled">
                      <strong>Usar LLM para titulares confirmados</strong>
                    </label>
                    <p role="status">
                      {enabled
                        ? 'Activado · puede generar cargos de Anthropic.'
                        : 'Desactivado · Tradia usa análisis local sin coste. Activar el LLM puede generar cargos de Anthropic.'}
                    </p>
                  </div>
                  <label className="setting-switch">
                    <input
                      id="llm-enabled"
                      type="checkbox"
                      role="switch"
                      checked={enabled}
                      onChange={(event) => setEnabled(event.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                </div>
                <p>Modelo · {NEWS_LLM_MODEL}</p>
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
                </div>
                <p className="operational-data">
                  Hoy: {settings.usedToday} de {settings.dailyCap} titulares
                </p>
                <p className="operational-data">
                  Este mes: {llmMoney(settings.spentThisMonthEur)} de{' '}
                  {llmMoney(settings.monthlyBudgetEur)}
                </p>
                {settings.usedToday >= settings.dailyCap && (
                  <p role="status">Tope diario alcanzado · se mantiene el análisis local.</p>
                )}
                {offline && <p role="status">Sin conexión · la prueba del LLM está pausada.</p>}
                <div className="settings-actions">
                  <button
                    className="button"
                    type="button"
                    disabled={!settings.hasKey || offline || !!key.trim()}
                    onClick={() => void test()}
                  >
                    Probar conexión
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
            saveButton.current?.focus();
          }}
        />
      )}
    </SettingsSection>
  );
}
