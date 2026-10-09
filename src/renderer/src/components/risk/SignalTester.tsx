import { useState } from 'react';
import type { RiskDecision, SignalDirection } from '../../../../shared/risk';
import { isTicker } from '../../../../shared/ipc';
import { ReasonValues } from './VetoLog';
const numeric = (value: string) => (value.trim() ? Number(value.replace(',', '.')) : NaN);
export function SignalTester() {
  const [draft, setDraft] = useState({
    ticker: '',
    entry: '',
    stop: '',
    target: '',
    confidence: '',
  });
  const [direction, setDirection] = useState<SignalDirection>('largo');
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [decision, setDecision] = useState<RiskDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errors: Partial<Record<keyof typeof draft, string>> = {};
  if (!isTicker(draft.ticker.trim().toUpperCase()))
    errors.ticker = 'Introduce un ticker de 1 a 12 caracteres: letras, números, punto o guion.';
  for (const key of ['entry', 'stop', 'target'] as const) {
    if (key !== 'entry' && draft[key].trim() === '') continue;
    if (!Number.isFinite(numeric(draft[key])) || numeric(draft[key]) <= 0)
      errors[key] = 'Introduce un precio mayor que cero.';
  }
  if (
    !Number.isFinite(numeric(draft.confidence)) ||
    numeric(draft.confidence) < 0 ||
    numeric(draft.confidence) > 1
  )
    errors.confidence = 'Introduce una confianza entre 0 y 1.';
  async function submit() {
    setAttempted(true);
    if (busy || Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    setDecision(null);
    try {
      setDecision(
        await window.tradia.risk.submitSignal({
          ticker: draft.ticker.trim().toUpperCase(),
          direction,
          entry: numeric(draft.entry),
          stop: draft.stop.trim() ? numeric(draft.stop) : null,
          target: draft.target.trim() ? numeric(draft.target) : null,
          confidence: numeric(draft.confidence),
          origin: 'probador',
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="risk-paper risk-tester" aria-labelledby="tester-title">
      <span className="risk-simulation">Simulación</span>
      <h3 id="tester-title">Probador de señales</h3>
      <p>Evalúa una señal con el motor de riesgo. No envía órdenes al mercado.</p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <fieldset disabled={busy} className="risk-signal-fields">
          <legend className="sr-only">Señal simulada</legend>
          {(
            [
              ['ticker', 'Activo'],
              ['entry', 'Entrada'],
              ['stop', 'Stop (vacío: sin stop)'],
              ['target', 'Objetivo (opcional)'],
              ['confidence', 'Confianza (0–1)'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <label htmlFor={`signal-${key}`}>{label}</label>
              <input
                id={`signal-${key}`}
                value={draft[key]}
                inputMode={key === 'ticker' ? 'text' : 'decimal'}
                aria-invalid={attempted && !!errors[key]}
                aria-describedby={attempted && errors[key] ? `signal-error-${key}` : undefined}
                onChange={(event) => {
                  setDraft({ ...draft, [key]: event.target.value });
                  setDecision(null);
                }}
              />
              {attempted && errors[key] && (
                <small id={`signal-error-${key}`} className="risk-field-error">
                  Error: {errors[key]}
                </small>
              )}
            </div>
          ))}
          <label>
            Dirección
            <select
              value={direction}
              onChange={(event) => {
                setDirection(event.target.value as SignalDirection);
                setDecision(null);
              }}
            >
              <option value="largo">Largo</option>
              <option value="corto">Corto</option>
            </select>
          </label>
        </fieldset>
        <div className="risk-actions">
          <button className="button primary" disabled={busy}>
            {busy ? 'Evaluando…' : 'Evaluar señal'}
          </button>
        </div>
      </form>
      {busy && <p role="status">Evaluando señal…</p>}
      {error && (
        <p className="risk-error" role="alert">
          {error}
        </p>
      )}
      {decision && (
        <div role="status" className={`risk-decision is-${decision.status}`}>
          <strong>
            {decision.status === 'vetada'
              ? 'Vetada'
              : decision.status === 'reducida'
                ? 'Reducida'
                : 'Aprobada'}{' '}
            · Simulación
          </strong>
          {decision.status !== 'vetada' && (
            <p>
              Tamaño: {decision.size.toLocaleString('es-ES')} unidades · Factor:{' '}
              {decision.sizeFactor.toLocaleString('es-ES')} · Capital arriesgado:{' '}
              {decision.riskAmount.toLocaleString('es-ES')}
            </p>
          )}
          {decision.reasons.map((reason, index) => (
            <div key={`${reason.code}-${index}`}>
              <p>
                {reason.message} · {reason.code}
              </p>
              <ReasonValues details={reason.details} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
