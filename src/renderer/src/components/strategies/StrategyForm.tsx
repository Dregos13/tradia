import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  DEFAULT_STRATEGY_COSTS,
  STRATEGY_NAME_MAX_LENGTH,
  type Strategy,
  type StrategyDraft,
  type StrategyRules,
} from '../../../../shared/strategy';
import { REGIME_LABELS } from '../../../../shared/ai';
import { regimeLabels } from './regimeLabels';
import { isCreateStrategyRequest } from '../../../../shared/ipc';
import { parseStrategyRules } from '../../../../shared/strategyRules';
import { RuleEditor, selectRuleError } from './RuleEditor';
import { ruleLabels } from './ruleValidation';
export function StrategyForm({
  strategy,
  save,
}: {
  strategy?: Strategy;
  save: (draft: StrategyDraft, note: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<StrategyDraft>(
    strategy
      ? {
          name: strategy.name,
          hypothesis: strategy.hypothesis,
          rules: strategy.rules,
          parameters: strategy.parameters,
          parameterRanges: strategy.parameterRanges,
          markets: strategy.markets,
          regime: strategy.regime,
          worksIn: [...strategy.worksIn],
          failsIn: [...strategy.failsIn],
          assumedCosts: strategy.assumedCosts,
          trainingPeriod: strategy.trainingPeriod,
          outOfSamplePeriod: strategy.outOfSamplePeriod,
        }
      : {
          name: '',
          hypothesis: '',
          rules: { entry: '', exit: '', stop: '', target: '' },
          parameters: {},
          parameterRanges: {},
          markets: [],
          regime: '',
          worksIn: [],
          failsIn: [],
          assumedCosts: { ...DEFAULT_STRATEGY_COSTS },
          trainingPeriod: null,
          outOfSamplePeriod: null,
        },
  );
  // La implementación clásica usa parámetros y conserva sus textos descriptivos.
  const descriptiveRules = !!strategy?.executable;
  const [parameters, setParameters] = useState(JSON.stringify(draft.parameters, null, 2));
  const [ranges, setRanges] = useState(JSON.stringify(draft.parameterRanges ?? {}, null, 2));
  const [markets, setMarkets] = useState(draft.markets.join(', '));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const parsedParameters = useMemo(() => {
    try {
      const value: unknown = JSON.parse(parameters);
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !Object.values(value).every(
          (number) => typeof number === 'number' && Number.isFinite(number),
        )
      )
        return null;
      return value as Record<string, number>;
    } catch {
      return null;
    }
  }, [parameters]);
  const validation = useMemo(
    () => parseStrategyRules(draft.rules, parsedParameters ?? {}),
    [draft.rules, parsedParameters],
  );
  // Solo publicamos resultados que correspondan a las reglas y parámetros visibles.
  const [visibleValidation, setVisibleValidation] = useState({
    result: validation,
    rules: draft.rules,
    parameters: parsedParameters,
  });
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setVisibleValidation({
          result: validation,
          rules: draft.rules,
          parameters: parsedParameters,
        }),
      200,
    );
    return () => clearTimeout(timer);
  }, [validation, draft.rules, parsedParameters]);
  const pending = Object.fromEntries(
    (Object.keys(ruleLabels) as (keyof StrategyRules)[]).map((field) => [
      field,
      visibleValidation.parameters !== parsedParameters ||
        draft.rules[field] !== visibleValidation.rules[field],
    ]),
  ) as Record<keyof StrategyRules, boolean>;
  const validationPending = Object.values(pending).some(Boolean);
  const ruleErrors = visibleValidation.result.ok
    ? []
    : visibleValidation.result.errors.filter((error) => !pending[error.field]);
  const emptyRules = !Object.values(draft.rules).some((value) => value?.trim());
  const summary = ruleErrors.length
    ? `Hay ${ruleErrors.length} ${ruleErrors.length === 1 ? 'error' : 'errores'}. Corrige ${ruleLabels[ruleErrors[0]!.field]} antes de guardar.`
    : validationPending
      ? 'Comprobando reglas…'
      : 'Reglas válidas · se pueden guardar y ejecutar.';
  const nameExcess = draft.name.length - STRATEGY_NAME_MAX_LENGTH;
  // Sin maxLength: un nombre pegado de más se conserva entero y se explica, no se corta en silencio.
  const nameField = (
    <div>
      <label htmlFor="strategy-name">Nombre</label>
      <textarea
        id="strategy-name"
        required
        disabled={busy}
        aria-invalid={nameExcess > 0}
        aria-describedby="strategy-name-result strategy-name-count"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <div className="strategy-rule-result">
        <span
          id="strategy-name-result"
          aria-live="polite"
          aria-atomic="true"
          className={nameExcess > 0 ? 'strategy-rule-error' : undefined}
        >
          {nameExcess > 0
            ? `Sobran ${nameExcess} ${nameExcess === 1 ? 'carácter' : 'caracteres'}: acorta el nombre para poder guardar.`
            : nameExcess === 0
              ? `Has llegado al máximo de ${STRATEGY_NAME_MAX_LENGTH} caracteres.`
              : ''}
        </span>
        <span id="strategy-name-count">
          {draft.name.length}/{STRATEGY_NAME_MAX_LENGTH}
        </span>
      </div>
    </div>
  );
  const text = (key: 'hypothesis' | 'regime', label: string, max: number) => (
    <div>
      <label htmlFor={`strategy-${key}`}>{label}</label>
      <textarea
        id={`strategy-${key}`}
        required
        disabled={busy}
        maxLength={max}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </div>
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNoteError(false);
    if (parsedParameters === null) {
      document.getElementById('strategy-parameters')?.focus();
      return;
    }
    if (nameExcess > 0) {
      document.getElementById('strategy-name')?.focus();
      return;
    }
    setSubmitted(true);
    if (!descriptiveRules && !validation.ok) {
      setVisibleValidation({
        result: validation,
        rules: draft.rules,
        parameters: parsedParameters,
      });
      selectRuleError(validation.errors[0]!);
      return;
    }
    if (!event.currentTarget.reportValidity()) return;
    if (strategy && note.trim().length < 12) {
      setNoteError(true);
      return;
    }
    const overlap = draft.worksIn?.find((label) => draft.failsIn?.includes(label));
    if (overlap) {
      setError(`${regimeLabels[overlap]} no puede estar a la vez en “Funciona en” y “Falla en”.`);
      return;
    }
    let request: StrategyDraft;
    try {
      request = {
        ...draft,
        markets: markets
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        parameters: JSON.parse(parameters),
        parameterRanges: JSON.parse(ranges),
      };
    } catch {
      setError('Revisa los parámetros y rangos: deben ser objetos JSON válidos.');
      return;
    }
    if (!isCreateStrategyRequest(request)) {
      setError(
        'Revisa los campos obligatorios, los mercados, las fechas y los valores numéricos de parámetros y costes.',
      );
      return;
    }
    setBusy(true);
    try {
      await save(request, note.trim());
    } catch {
      setError('No pudimos guardar la estrategia. Tus cambios se conservan; inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="strategy-heading" data-layout-block="cabecera">
        <div>
          <a href={strategy ? `#estrategias/${strategy.id}` : '#estrategias'}>Volver sin guardar</a>
          <h2>{strategy ? 'Editar estrategia' : 'Nueva estrategia'}</h2>
          <p>
            {strategy
              ? `Se creará la versión v${strategy.version + 1}; v${strategy.version} seguirá disponible`
              : 'La estrategia comenzará en Investigación.'}
          </p>
        </div>
      </header>
      <form
        noValidate
        aria-busy={busy}
        className="strategy-form"
        data-layout-block="formulario"
        onSubmit={(e) => void submit(e)}
      >
        <nav aria-label="Secciones del formulario">
          {[
            'Identidad',
            'Hipótesis',
            'Reglas',
            'Universo y periodos',
            'Régimen',
            'Costes',
            'Parámetros',
          ].map((name, i) => (
            <button
              type="button"
              key={name}
              onClick={() => {
                const section = document.getElementById(`strategy-section-${i}`);
                section?.scrollIntoView();
                section?.querySelector<HTMLElement>('textarea, input, select')?.focus();
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="strategy-form-fields">
          <fieldset disabled={busy} id="strategy-section-0">
            <legend>Identidad</legend>
            {nameField}
          </fieldset>
          <fieldset disabled={busy} id="strategy-section-1">
            <legend>Hipótesis</legend>
            {text('hypothesis', 'Hipótesis económica', 4000)}
          </fieldset>
          <fieldset disabled={busy} id="strategy-section-2">
            {descriptiveRules ? (
              <>
                <legend>Reglas reproducibles</legend>
                <p>
                  Estas reglas describen una implementación clásica registrada. Su ejecución utiliza
                  los parámetros de la ficha.
                </p>
                {(['entry', 'exit', 'stop', 'target'] as const).map((field) => (
                  <div key={field}>
                    <label htmlFor={`strategy-rule-${field}`}>{ruleLabels[field]}</label>
                    <textarea
                      id={`strategy-rule-${field}`}
                      required
                      maxLength={4000}
                      value={draft.rules[field]}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          rules: { ...draft.rules, [field]: event.target.value },
                        })
                      }
                    />
                  </div>
                ))}
              </>
            ) : (
              <>
                <legend>Reglas ejecutables</legend>
                <p>
                  Escribe qué debe ocurrir para entrar y salir. Tradia comprueba cada regla mientras
                  escribes.
                </p>
                <p>
                  Las decisiones se calculan al cierre de la vela y se ejecutan en la apertura
                  siguiente.
                </p>
                <p
                  role={submitted && ruleErrors.length ? 'alert' : 'status'}
                  aria-live={
                    validationPending
                      ? 'off'
                      : submitted && ruleErrors.length
                        ? 'assertive'
                        : 'polite'
                  }
                >
                  {emptyRules && !submitted
                    ? 'Completa las cuatro reglas. En Stop y Objetivo también puedes escribir ninguno.'
                    : summary}
                </p>
                <RuleEditor
                  rules={draft.rules}
                  parameters={parsedParameters ?? {}}
                  errors={ruleErrors.filter(
                    (item) =>
                      submitted ||
                      !!draft.rules[item.field]?.trim() ||
                      (item.field === 'entryShort' && !!draft.rules.exitShort?.trim()) ||
                      (item.field === 'exitShort' && !!draft.rules.entryShort?.trim()),
                  )}
                  pending={pending}
                  change={(rules, source) => {
                    setDraft({ ...draft, rules });
                    if (source === 'insertion') {
                      setVisibleValidation({
                        result: parseStrategyRules(rules, parsedParameters ?? {}),
                        rules,
                        parameters: parsedParameters,
                      });
                    }
                  }}
                  busy={busy}
                />
              </>
            )}
          </fieldset>
          <fieldset disabled={busy} id="strategy-section-3">
            <legend>Universo y periodos</legend>
            <label>
              Mercados (separados por comas)
              <input required value={markets} onChange={(e) => setMarkets(e.target.value)} />
            </label>
            {(['trainingPeriod', 'outOfSamplePeriod'] as const).map((key) => (
              <div key={key}>
                <h3>{key === 'trainingPeriod' ? 'Entrenamiento' : 'Fuera de muestra'}</h3>
                <div className="strategy-grid">
                  {(['desde', 'hasta'] as const).map((part) => (
                    <label key={part}>
                      {`${key === 'trainingPeriod' ? 'Entrenamiento' : 'Fuera de muestra'} · ${part}`}
                      <input
                        type="date"
                        value={draft[key]?.[part] ?? ''}
                        onChange={(e) => {
                          const period = {
                            desde: draft[key]?.desde ?? '',
                            hasta: draft[key]?.hasta ?? '',
                            [part]: e.target.value,
                          };
                          setDraft({
                            ...draft,
                            [key]: !period.desde && !period.hasta ? null : period,
                          });
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
          <fieldset disabled={busy} id="strategy-section-4">
            <legend>Régimen</legend>
            <div className="strategy-grid">
              {(['worksIn', 'failsIn'] as const).map((key) => (
                <fieldset key={key} disabled={busy}>
                  <legend>{key === 'worksIn' ? 'Funciona en' : 'Falla en'}</legend>
                  {REGIME_LABELS.map((label) => (
                    <label className="strategy-regime-choice" key={label}>
                      <input
                        type="checkbox"
                        checked={draft[key]?.includes(label) ?? false}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            [key]: event.target.checked
                              ? [...(current[key] ?? []), label]
                              : (current[key] ?? []).filter((value) => value !== label),
                          }))
                        }
                      />
                      {regimeLabels[label]}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            {text('regime', 'Régimen favorable y limitaciones', 500)}
          </fieldset>
          <fieldset disabled={busy} id="strategy-section-5">
            <legend>Costes asumidos</legend>
            <div className="strategy-grid">
              {(['commissionPct', 'commissionMin', 'slippageBps', 'spreadBps'] as const).map(
                (key) => (
                  <label key={key}>
                    {
                      {
                        commissionPct: 'Comisión (%)',
                        commissionMin: 'Comisión mínima (USD)',
                        slippageBps: 'Slippage (pb)',
                        spreadBps: 'Spread (pb)',
                      }[key]
                    }
                    <input
                      required
                      type="number"
                      min="0"
                      step="any"
                      value={draft.assumedCosts?.[key] ?? 0}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          assumedCosts: {
                            ...(draft.assumedCosts ?? DEFAULT_STRATEGY_COSTS),
                            [key]: e.target.valueAsNumber,
                          },
                        })
                      }
                    />
                  </label>
                ),
              )}
            </div>
          </fieldset>
          <fieldset disabled={busy} id="strategy-section-6">
            <legend>Parámetros</legend>
            <label>
              Parámetros (objeto JSON de números)
              <textarea
                id="strategy-parameters"
                aria-label="Parámetros (objeto JSON de números)"
                aria-invalid={parsedParameters === null}
                aria-describedby="strategy-parameters-help"
                value={parameters}
                onChange={(e) => setParameters(e.target.value)}
              />
            </label>
            <p id="strategy-parameters-help" role={parsedParameters === null ? 'alert' : undefined}>
              {parsedParameters === null
                ? 'Revisa los parámetros: deben ser un objeto JSON de números finitos.'
                : 'Los nombres de estos parámetros se pueden usar en las reglas.'}
            </p>
            <label>
              Rangos de sensibilidad (objeto JSON: min, max, step)
              <textarea
                aria-label="Rangos de sensibilidad (objeto JSON: min, max, step)"
                value={ranges}
                onChange={(e) => setRanges(e.target.value)}
              />
            </label>
          </fieldset>
          {strategy && (
            <div>
              <label htmlFor="strategy-note">Nota del cambio</label>
              <textarea
                disabled={busy}
                id="strategy-note"
                aria-invalid={noteError}
                aria-describedby="strategy-note-help"
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <span id="strategy-note-help" role={noteError ? 'alert' : undefined}>
                {noteError
                  ? 'Explica qué cambió y por qué; esta nota quedará en el historial.'
                  : 'Obligatoria, al menos 12 caracteres.'}
              </span>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <button
            className="strategy-primary"
            disabled={busy || emptyRules}
            aria-disabled={
              (!descriptiveRules && !validation.ok) || parsedParameters === null || nameExcess > 0
            }
            type="submit"
          >
            {busy ? 'Guardando…' : strategy ? 'Guardar nueva versión' : 'Crear estrategia'}
          </button>
        </div>
      </form>
    </>
  );
}
