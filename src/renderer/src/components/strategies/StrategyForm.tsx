import { useState, type FormEvent } from 'react';
import {
  DEFAULT_STRATEGY_COSTS,
  type Strategy,
  type StrategyDraft,
} from '../../../../shared/strategy';
import { isCreateStrategyRequest } from '../../../../shared/ipc';
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
          assumedCosts: { ...DEFAULT_STRATEGY_COSTS },
          trainingPeriod: null,
          outOfSamplePeriod: null,
        },
  );
  const [parameters, setParameters] = useState(JSON.stringify(draft.parameters, null, 2));
  const [ranges, setRanges] = useState(JSON.stringify(draft.parameterRanges ?? {}, null, 2));
  const [markets, setMarkets] = useState(draft.markets.join(', '));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState(false);
  const [busy, setBusy] = useState(false);
  const text = (key: 'name' | 'hypothesis' | 'regime', label: string, max: number) => (
    <div>
      <label htmlFor={`strategy-${key}`}>{label}</label>
      <textarea
        id={`strategy-${key}`}
        required
        maxLength={max}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </div>
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNoteError(false);
    if (strategy && note.trim().length < 12) {
      setNoteError(true);
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
      <header className="strategy-heading">
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
      <form className="strategy-form" onSubmit={(e) => void submit(e)}>
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
              onClick={() => document.getElementById(`strategy-section-${i}`)?.scrollIntoView()}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="strategy-form-fields">
          <fieldset id="strategy-section-0">
            <legend>Identidad</legend>
            {text('name', 'Nombre', 120)}
          </fieldset>
          <fieldset id="strategy-section-1">
            <legend>Hipótesis</legend>
            {text('hypothesis', 'Hipótesis económica', 4000)}
          </fieldset>
          <fieldset id="strategy-section-2">
            <legend>Reglas</legend>
            {(['entry', 'exit', 'stop', 'target'] as const).map((key) => (
              <div key={key}>
                <label htmlFor={`strategy-rule-${key}`}>
                  {{ entry: 'Entrada', exit: 'Salida', stop: 'Stop', target: 'Objetivo' }[key]}
                </label>
                <textarea
                  id={`strategy-rule-${key}`}
                  required
                  maxLength={4000}
                  value={draft.rules[key]}
                  onChange={(e) =>
                    setDraft({ ...draft, rules: { ...draft.rules, [key]: e.target.value } })
                  }
                />
              </div>
            ))}
          </fieldset>
          <fieldset id="strategy-section-3">
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
          <fieldset id="strategy-section-4">
            <legend>Régimen</legend>
            {text('regime', 'Régimen favorable y limitaciones', 500)}
          </fieldset>
          <fieldset id="strategy-section-5">
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
          <fieldset id="strategy-section-6">
            <legend>Parámetros</legend>
            <label>
              Parámetros (objeto JSON de números)
              <textarea
                aria-label="Parámetros (objeto JSON de números)"
                value={parameters}
                onChange={(e) => setParameters(e.target.value)}
              />
            </label>
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
          <button className="strategy-primary" disabled={busy} type="submit">
            {busy ? 'Guardando…' : strategy ? 'Guardar nueva versión' : 'Crear estrategia'}
          </button>
        </div>
      </form>
    </>
  );
}
