import { useEffect, useRef } from 'react';
import type { StrategyRules } from '../../../../shared/strategy';
import {
  CAMPOS_PRECIO,
  INDICADORES,
  PALABRAS_CLAVE,
  RULES_FIELD_MAX_LENGTH,
  type StrategyRulesError,
} from '../../../../shared/strategyRules';
import { ruleErrorText, ruleLabels } from './ruleValidation';

type RuleField = 'entry' | 'exit' | 'stop' | 'target';
const fields: RuleField[] = ['entry', 'exit', 'stop', 'target'];
const help: Record<RuleField, string> = {
  entry: 'Una condición que indique cuándo abrir una posición larga.',
  exit: 'Una condición que indique cuándo cerrar la posición.',
  stop: 'Distancia máxima de pérdida: porcentaje, múltiplo de ATR o ninguno.',
  target: 'Distancia para tomar beneficio: porcentaje, múltiplo de ATR o ninguno.',
};
const examples: Record<RuleField, { label: string; value: string }[]> = {
  entry: [
    { label: 'Insertar cruce de medias', value: 'cruza_arriba(sma(rapida), sma(lenta))' },
    {
      label: 'Insertar entrada RSI con tendencia',
      value: 'cruza_arriba(rsi(14), 30) y no (cierre < sma(200))',
    },
  ],
  exit: [
    {
      label: 'Insertar salida RSI o cruce',
      value: 'rsi(14) > 70 o cruza_abajo(sma(rapida), sma(lenta))',
    },
  ],
  stop: [
    { label: 'Insertar stop del 2 %', value: '2%' },
    { label: 'Insertar stop ATR', value: '1,5 * atr(14)' },
    { label: 'Sin stop', value: 'ninguno' },
  ],
  target: [
    { label: 'Insertar objetivo del 6 %', value: '6%' },
    { label: 'Insertar objetivo ATR', value: '3 * atr(14)' },
    { label: 'Sin objetivo', value: 'ninguno' },
  ],
};
export function selectRuleError(error: StrategyRulesError) {
  const editor = document.getElementById(`strategy-rule-${error.field}`);
  if (editor instanceof HTMLTextAreaElement) {
    editor.focus();
    editor.setSelectionRange(error.start, error.end);
  }
}
function RuleFieldEditor({
  field,
  value,
  error,
  change,
  busy,
}: {
  field: RuleField;
  value: string;
  error?: StrategyRulesError;
  change: (value: string) => void;
  busy: boolean;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const inserted = useRef(false);
  useEffect(() => {
    if (!inserted.current) return;
    inserted.current = false;
    editor.current?.focus();
    editor.current?.setSelectionRange(value.length, value.length);
  }, [value]);
  const id = `strategy-rule-${field}`;
  return (
    <div className="strategy-rule-field">
      <label htmlFor={id}>{ruleLabels[field]}</label>
      <p id={`${id}-help`}>{help[field]}</p>
      <textarea
        ref={editor}
        id={id}
        required
        disabled={busy}
        maxLength={RULES_FIELD_MAX_LENGTH}
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={`${id}-help ${id}-result ${id}-count`}
        value={value}
        onChange={(event) => change(event.target.value)}
      />
      <div className="strategy-rule-result">
        <span
          id={`${id}-result`}
          className={error ? 'strategy-rule-error' : value.trim() ? 'strategy-rule-valid' : ''}
        >
          {error ? (
            <button type="button" onClick={() => selectRuleError(error)}>
              {ruleErrorText(error)}
            </button>
          ) : value.trim() ? (
            'Válida'
          ) : (
            'Escribe una regla o inserta un ejemplo.'
          )}
        </span>
        <span id={`${id}-count`}>
          {value.length}/{RULES_FIELD_MAX_LENGTH}
        </span>
      </div>
      <div className="strategy-rule-examples">
        {examples[field].map(({ label, value: example }) => (
          <button
            key={label}
            type="button"
            disabled={busy}
            onClick={() => {
              inserted.current = true;
              change(example);
              editor.current?.focus();
              editor.current?.setSelectionRange(example.length, example.length);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
export function RuleEditor({
  rules,
  parameters,
  errors,
  change,
  busy,
}: {
  rules: StrategyRules;
  parameters: Record<string, number>;
  errors: StrategyRulesError[];
  change: (rules: StrategyRules) => void;
  busy: boolean;
}) {
  return (
    <div className="strategy-rule-layout">
      <div className="strategy-rule-fields">
        {fields.map((field) => (
          <RuleFieldEditor
            key={field}
            field={field}
            value={rules[field]}
            error={errors.find((error) => error.field === field)}
            change={(value) => change({ ...rules, [field]: value })}
            busy={busy}
          />
        ))}
      </div>
      <aside className="strategy-rule-reference" aria-labelledby="rule-reference-heading">
        <h3 id="rule-reference-heading">Lo que puedes usar</h3>
        <p>
          Precio: <code>{CAMPOS_PRECIO.join(', ')}</code>.
        </p>
        <dl>
          {INDICADORES.map(({ name, signature, summary }) => (
            <div key={name}>
              <dt>
                <code>{signature}</code>
              </dt>
              <dd>{summary}</dd>
            </div>
          ))}
        </dl>
        <p>
          Lógica:{' '}
          <code>{PALABRAS_CLAVE.filter((word) => ['y', 'o', 'no'].includes(word)).join(', ')}</code>
          .
        </p>
        <p>
          Comparaciones: <code>{'>, <, >=, <=, ='}</code>.
        </p>
        <p>
          Operaciones: <code>+ - * /</code> y paréntesis.
        </p>
        <p>Periodos: entero entre 1 y 500 o nombre de parámetro.</p>
        <h4>Parámetros de esta estrategia</h4>
        {Object.keys(parameters).length ? (
          <dl>
            {Object.entries(parameters).map(([name, value]) => (
              <div key={name}>
                <dt>
                  <code>{name}</code>
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>Sin parámetros definidos.</p>
        )}
        <p>
          Usa el nombre sin comillas. Si lo cambias en Parámetros, la regla se vuelve a validar.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => document.getElementById('strategy-parameters')?.focus()}
        >
          Revisar parámetros
        </button>
        <details>
          <summary>Ver reglas de sintaxis</summary>
          <p>
            Combina condiciones con y, o, no. En Stop y Objetivo usa un porcentaje, un múltiplo de
            ATR o ninguno. Máximo: 500 caracteres por campo.
          </p>
        </details>
      </aside>
    </div>
  );
}
