import { useEffect, useId, useRef, useState } from 'react';

import type { BacktestReport } from '../../../../shared/backtest';
import {
  FORWARD_DEFAULT_CASH,
  FORWARD_MAX_CASH,
  FORWARD_MIN_CASH,
  LAB_IDEA_MAX_LENGTH,
  LAB_IDEA_MIN_LENGTH,
  type GeneratedStrategy,
  type LabEngineStatus,
} from '../../../../shared/lab';
import { pct, signedPct, tone } from './format';

const EXAMPLES = [
  'Comprar el SPY cuando cae fuerte varios días seguidos pero sigue en tendencia alcista, y vender en el rebote',
  'Seguir la tendencia en los ETF de sectores: entrar cuando la media de 50 cruza por encima de la de 200',
  'Comprar rupturas de máximos de 20 días en Nvidia, AMD y Microsoft con un stop ajustado a la volatilidad',
];

type Step =
  | { kind: 'idle' }
  | { kind: 'generating'; refining: boolean }
  | { kind: 'draft'; draft: GeneratedStrategy; engine: string; attempts: number }
  | { kind: 'testing'; draft: GeneratedStrategy; engine: string }
  | {
      kind: 'tested';
      draft: GeneratedStrategy;
      engine: string;
      strategyId: number;
      report: BacktestReport;
    }
  | { kind: 'launching'; draft: GeneratedStrategy; strategyId: number; report: BacktestReport };

const RULE_ROWS: { key: keyof GeneratedStrategy['rules']; label: string }[] = [
  { key: 'entry', label: 'Entra' },
  { key: 'exit', label: 'Sale' },
  { key: 'stop', label: 'Stop' },
  { key: 'target', label: 'Objetivo' },
  { key: 'entryShort', label: 'Entra en corto' },
  { key: 'exitShort', label: 'Sale del corto' },
];

export function LabStudio({ onLaunched }: { onLaunched: (forwardId: number) => void }) {
  const ideaId = useId();
  const feedbackId = useId();
  const cashId = useId();
  const [engine, setEngine] = useState<LabEngineStatus | null>(null);
  // Una idea que llega desde la Mesa («Crear estrategia con esto»).
  const [idea, setIdea] = useState(() => {
    const query = window.location.hash.split('?')[1] ?? '';
    return new URLSearchParams(query).get('idea') ?? '';
  });
  const [feedback, setFeedback] = useState('');
  const [cash, setCash] = useState(String(FORWARD_DEFAULT_CASH));
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    void window.tradia.lab.engine().then(
      (status) => alive && setEngine(status),
      () => alive && setEngine({ available: false, label: null, hint: null }),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (step.kind === 'draft' || step.kind === 'tested') resultRef.current?.focus();
  }, [step.kind]);

  const draft = 'draft' in step ? step.draft : null;
  const busy = step.kind === 'generating' || step.kind === 'testing' || step.kind === 'launching';
  const ideaValid = idea.trim().length >= LAB_IDEA_MIN_LENGTH;

  const generate = async (refine: boolean) => {
    setError(null);
    const previous = refine && draft ? draft : undefined;
    setStep({ kind: 'generating', refining: refine });
    try {
      const result = await window.tradia.lab.generate({
        idea: idea.trim(),
        ...(previous ? { previous, feedback: feedback.trim() } : {}),
      });
      if (result.ok) {
        setStep({
          kind: 'draft',
          draft: result.draft,
          engine: result.engine,
          attempts: result.attempts,
        });
        setFeedback('');
      } else {
        setError(result.message);
        setStep(
          previous ? { kind: 'draft', draft: previous, engine: '', attempts: 0 } : { kind: 'idle' },
        );
      }
    } catch (cause) {
      setError((cause as Error)?.message ?? 'No se pudo generar la estrategia.');
      setStep(
        previous ? { kind: 'draft', draft: previous, engine: '', attempts: 0 } : { kind: 'idle' },
      );
    }
  };

  const test = async () => {
    if (step.kind !== 'draft') return;
    const { draft: d, engine: eng } = step;
    setError(null);
    setStep({ kind: 'testing', draft: d, engine: eng });
    try {
      const strategy = await window.tradia.strategies.create({
        name: d.name,
        hypothesis: d.hypothesis,
        rules: d.rules,
        parameters: d.parameters,
        parameterRanges: d.parameterRanges,
        markets: d.markets,
        regime: d.regime || 'Sin régimen declarado',
        note: `Creada en el laboratorio${eng ? ` con ${eng}` : ''} a partir de la idea: ${idea.trim()}`.slice(
          0,
          1_000,
        ),
      });
      const report = await window.tradia.backtest.run({
        strategyId: strategy.id,
        walkForward: false,
        sensitivity: false,
        monteCarlo: false,
      });
      setStep({ kind: 'tested', draft: d, engine: eng, strategyId: strategy.id, report });
    } catch (cause) {
      setError(
        `No se pudo probar con datos históricos: ${(cause as Error)?.message ?? 'error desconocido'}`,
      );
      setStep({ kind: 'draft', draft: d, engine: eng, attempts: 0 });
    }
  };

  const cashValue = Number(cash.replace(/\./g, '').replace(',', '.'));
  const cashValid =
    Number.isFinite(cashValue) && cashValue >= FORWARD_MIN_CASH && cashValue <= FORWARD_MAX_CASH;

  const launch = async () => {
    if (step.kind !== 'tested' || !cashValid) return;
    setError(null);
    const { draft: d, strategyId, report } = step;
    setStep({ kind: 'launching', draft: d, strategyId, report });
    try {
      const forward = await window.tradia.forward.start({ strategyId, initialCash: cashValue });
      onLaunched(forward.id);
    } catch (cause) {
      setError(`No se pudo lanzar la prueba: ${(cause as Error)?.message ?? 'error desconocido'}`);
      setStep({ kind: 'tested', draft: d, engine: '', strategyId, report });
    }
  };

  const reset = () => {
    setStep({ kind: 'idle' });
    setError(null);
    setFeedback('');
  };

  return (
    <section className="lab-studio" aria-labelledby={`${ideaId}-title`}>
      <div className="lab-studio-head">
        <h2 id={`${ideaId}-title`}>Describe una estrategia</h2>
        <p className="lab-engine" aria-live="polite">
          {engine === null ? (
            'Buscando tu IA…'
          ) : engine.available ? (
            <>
              <span className="lab-engine-dot" aria-hidden="true" /> {engine.label}
            </>
          ) : (
            <>
              Sin IA conectada · <a href="#ajustes">Configurar</a>
            </>
          )}
        </p>
      </div>

      <div className="lab-composer">
        <label className="visually-hidden" htmlFor={ideaId}>
          Tu idea
        </label>
        <textarea
          id={ideaId}
          rows={3}
          maxLength={LAB_IDEA_MAX_LENGTH}
          value={idea}
          disabled={busy || step.kind === 'tested'}
          placeholder="Qué quieres comprar o vender, cuándo entrar y cuándo salir"
          onChange={(event) => setIdea(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ideaValid && !busy) {
              event.preventDefault();
              void generate(false);
            }
          }}
        />
        <div className="lab-composer-foot">
          {step.kind === 'idle' || step.kind === 'generating' ? (
            <ul className="lab-examples" aria-label="Ideas de ejemplo">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    className="lab-example"
                    disabled={busy}
                    onClick={() => setIdea(example)}
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <button type="button" className="lab-link" onClick={reset} disabled={busy}>
              Empezar otra idea
            </button>
          )}
          {(step.kind === 'idle' || (step.kind === 'generating' && !step.refining)) && (
            <button
              type="button"
              className="button primary"
              disabled={!ideaValid || busy || engine?.available === false}
              aria-busy={step.kind === 'generating'}
              onClick={() => void generate(false)}
            >
              {step.kind === 'generating' ? 'Escribiendo reglas…' : 'Generar estrategia'}
            </button>
          )}
        </div>
        {engine && !engine.available && engine.hint && <p className="lab-hint">{engine.hint}</p>}
      </div>

      {error && (
        <p className="lab-error" role="alert">
          {error}
        </p>
      )}

      {step.kind === 'generating' && (
        <p className="lab-working" role="status" aria-busy="true">
          {step.refining
            ? 'Ajustando las reglas…'
            : 'Traduciendo tu idea a reglas que el motor pueda ejecutar…'}
          <span className="lab-working-note">Puede tardar hasta un minuto</span>
        </p>
      )}

      {draft && step.kind !== 'generating' && (
        <article
          className="lab-draft"
          ref={resultRef}
          tabIndex={-1}
          aria-label={`Borrador: ${draft.name}`}
        >
          <header className="lab-draft-head">
            <div>
              <h3>{draft.name}</h3>
              <p className="lab-draft-markets">{draft.markets.join(' · ')}</p>
            </div>
            {step.kind === 'draft' && step.attempts > 1 && (
              <p className="lab-draft-meta">Validada en {step.attempts} intentos</p>
            )}
          </header>
          <p className="lab-draft-explain">{draft.explanation || draft.hypothesis}</p>

          <dl className="lab-rules">
            {RULE_ROWS.filter((row) => (draft.rules[row.key] ?? '').trim().length > 0).map(
              (row) => (
                <div key={row.key}>
                  <dt>{row.label}</dt>
                  <dd>
                    <code>{draft.rules[row.key]}</code>
                  </dd>
                </div>
              ),
            )}
          </dl>

          {Object.keys(draft.parameters).length > 0 && (
            <p className="lab-params">
              {Object.entries(draft.parameters).map(([key, value]) => (
                <span key={key}>
                  {key} <b>{value}</b>
                </span>
              ))}
            </p>
          )}

          {draft.risks.length > 0 && (
            <div className="lab-risks">
              <h4>Dónde puede fallar</h4>
              <ul>
                {draft.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </div>
          )}

          {(step.kind === 'draft' || step.kind === 'testing') && (
            <footer className="lab-draft-actions">
              <div className="lab-refine">
                <label htmlFor={feedbackId}>¿Qué cambiarías?</label>
                <div className="lab-refine-row">
                  <input
                    id={feedbackId}
                    value={feedback}
                    disabled={busy}
                    placeholder="Más conservadora, solo tecnológicas, añade salida por objetivo…"
                    onChange={(event) => setFeedback(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && feedback.trim() && !busy) {
                        event.preventDefault();
                        void generate(true);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="button"
                    disabled={!feedback.trim() || busy}
                    onClick={() => void generate(true)}
                  >
                    Ajustar
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                aria-busy={step.kind === 'testing'}
                onClick={() => void test()}
              >
                {step.kind === 'testing'
                  ? 'Probando con el histórico…'
                  : 'Probar con datos históricos'}
              </button>
            </footer>
          )}
        </article>
      )}

      {(step.kind === 'tested' || step.kind === 'launching') && (
        <BacktestVerdict
          report={step.report}
          strategyId={step.strategyId}
          cashId={cashId}
          cash={cash}
          cashValid={cashValid}
          onCash={setCash}
          launching={step.kind === 'launching'}
          onLaunch={() => void launch()}
          sectionRef={resultRef}
        />
      )}
    </section>
  );
}

function BacktestVerdict({
  report,
  strategyId,
  cashId,
  cash,
  cashValid,
  onCash,
  launching,
  onLaunch,
  sectionRef,
}: {
  report: BacktestReport;
  strategyId: number;
  cashId: string;
  cash: string;
  cashValid: boolean;
  onCash: (value: string) => void;
  launching: boolean;
  onLaunch: () => void;
  sectionRef: React.RefObject<HTMLElement | null>;
}) {
  const m = report.metrics;
  const bench = report.benchmark?.totalReturn ?? null;
  const beat = m.totalReturn !== null && bench !== null ? m.totalReturn - bench : null;
  const few = m.tradeCount < 30;
  const period = `${report.config.desde.slice(0, 4)}–${(report.config.ejecutadoHasta ?? report.config.hasta).slice(0, 4)}`;
  return (
    <section
      className="lab-verdict"
      aria-labelledby={`${cashId}-verdict`}
      ref={sectionRef}
      tabIndex={-1}
    >
      <header>
        <h3 id={`${cashId}-verdict`}>Así le habría ido · {period}</h3>
        <a href={`#estrategias/${strategyId}/backtest/${report.id}`}>Informe completo</a>
      </header>
      <dl className="lab-stats">
        <div>
          <dt>Rentabilidad anual</dt>
          <dd data-tone={tone(m.annualizedReturn)}>{signedPct(m.annualizedReturn)}</dd>
        </div>
        <div>
          <dt>Frente a {report.benchmark?.ticker ?? 'SPY'}</dt>
          <dd data-tone={tone(beat)}>{beat === null ? '—' : `${signedPct(beat)} total`}</dd>
        </div>
        <div>
          <dt>Peor caída</dt>
          <dd>{pct(m.maxDrawdown?.pct ?? null)}</dd>
        </div>
        <div>
          <dt>Operaciones</dt>
          <dd>
            {m.tradeCount}
            {m.winRate !== null && (
              <span className="lab-stat-sub"> · {pct(m.winRate)} aciertos</span>
            )}
          </dd>
        </div>
      </dl>
      {(few || (beat !== null && beat < 0)) && (
        <p className="lab-caution">
          {beat !== null && beat < 0
            ? `En este periodo rinde menos que comprar ${report.benchmark?.ticker ?? 'SPY'} y esperar. Ajusta la idea o lánzala para ver si en el mercado actual se comporta distinto.`
            : 'Con menos de 30 operaciones el resultado puede ser suerte. La prueba en vivo es la forma de saberlo.'}
        </p>
      )}
      <div className="lab-launch">
        <div>
          <h4>Pruébala en el mercado real con dinero ficticio</h4>
          <p>
            Las reglas quedan congeladas y la estrategia opera cada cierre desde hoy. Nada de lo que
            pase después puede cambiar su resultado.
          </p>
        </div>
        <div className="lab-launch-row">
          <label htmlFor={cashId}>Capital ficticio (USD)</label>
          <input
            id={cashId}
            inputMode="numeric"
            value={cash}
            aria-invalid={!cashValid}
            onChange={(event) => onCash(event.target.value)}
          />
          <button
            type="button"
            className="button primary"
            disabled={!cashValid || launching}
            aria-busy={launching}
            onClick={onLaunch}
          >
            {launching ? 'Lanzando…' : 'Lanzar prueba en vivo'}
          </button>
        </div>
      </div>
    </section>
  );
}
