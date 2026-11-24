import { useEffect, useId, useRef, useState } from 'react';

import type { BacktestReport } from '../../../../shared/backtest';
import {
  FORWARD_DEFAULT_CASH,
  FORWARD_MAX_CASH,
  FORWARD_MIN_CASH,
  LAB_IDEA_MAX_LENGTH,
  LAB_IDEA_MIN_LENGTH,
  type GeneratedStrategy,
  type LabBacktestResult,
  type LabEngineStatus,
  type LabHistoryDays,
  type LabSessionId,
  labVerdict,
} from '../../../../shared/lab';
import type { StrategyTimeframe } from '../../../../shared/strategy';
import { EquityChart } from './EquityChart';
import { formatFxPair } from '../../../../shared/fx';
import { isFxSymbol } from '../../../../shared/fxTrading';
import { longDate, pct, signedMoney, signedPct, tone } from './format';

const prettyTicker = (t: string) => (isFxSymbol(t) ? formatFxPair(t) : t);

const HOURLY_EXAMPLES = [
  'Comprar EUR/USD al abrir Londres si rompe el máximo de las 6 horas anteriores y cerrar al acabar Nueva York',
  'Comprar dólar/yen en la sesión de Tokio cuando el RSI de 14 baje de 30 y salir cuando supere 50',
  'Comprar oro en la sesión de Nueva York si está por encima de su media de 50 horas, con stop ajustado a la volatilidad',
];

const DAILY_EXAMPLES = [
  'Comprar EUR/USD cuando rompa el máximo de las últimas 20 sesiones con tendencia alcista y salir si pierde la media de 50',
  'Comprar dólar/yen cuando el RSI de 14 baje de 30 si sigue por encima de su media de 200, y vender cuando supere 55',
  'Comprar oro cuando la media de 20 cruce por encima de la de 50 y salir con un stop ajustado a la volatilidad',
];

/** Resultado de la prueba histórica: diaria (informe completo) o de 1 hora. */
type Outcome =
  { timeframe: '1d'; report: BacktestReport } | { timeframe: '1h'; result: LabBacktestResult };

const SESSION_LABEL: Record<LabSessionId, string> = {
  tokio: 'Tokio',
  londres: 'Londres',
  'nueva-york': 'Nueva York',
  fuera: 'Fuera de sesión',
};

/** Velas pedidas desde la Mesa (`&tf=1d`); por defecto, 1 hora. */
function initialTimeframe(): StrategyTimeframe {
  const query = window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('tf') === '1d' ? '1d' : '1h';
}

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
      outcome: Outcome;
    }
  | { kind: 'launching'; draft: GeneratedStrategy; strategyId: number; outcome: Outcome };

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
  const [timeframe, setTimeframe] = useState<StrategyTimeframe>(initialTimeframe);
  const [days, setDays] = useState<LabHistoryDays>(365);
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
        timeframe,
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
        timeframe,
        regime: d.regime || 'Sin régimen declarado',
        note: `Creada en el laboratorio${eng ? ` con ${eng}` : ''} a partir de la idea: ${idea.trim()}`.slice(
          0,
          1_000,
        ),
      });
      const outcome: Outcome =
        timeframe === '1h'
          ? {
              timeframe: '1h',
              result: await window.tradia.lab.backtest({ strategyId: strategy.id, days }),
            }
          : {
              timeframe: '1d',
              report: await window.tradia.backtest.run({
                strategyId: strategy.id,
                // Se compara con comprar y mantener el propio activo.
                benchmark: d.markets[0],
                walkForward: false,
                sensitivity: false,
                monteCarlo: false,
              }),
            };
      setStep({ kind: 'tested', draft: d, engine: eng, strategyId: strategy.id, outcome });
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
    const { draft: d, strategyId, outcome } = step;
    setStep({ kind: 'launching', draft: d, strategyId, outcome });
    try {
      const forward = await window.tradia.forward.start({ strategyId, initialCash: cashValue });
      onLaunched(forward.id);
    } catch (cause) {
      setError(`No se pudo lanzar la prueba: ${(cause as Error)?.message ?? 'error desconocido'}`);
      setStep({ kind: 'tested', draft: d, engine: '', strategyId, outcome });
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
        <div className="lab-options">
          <Segmented
            label="Velas"
            value={timeframe}
            disabled={busy || step.kind !== 'idle'}
            options={[
              { value: '1h', label: '1 hora' },
              { value: '1d', label: 'Diarias' },
            ]}
            onChange={setTimeframe}
          />
          {timeframe === '1h' && (
            <Segmented
              label="Histórico"
              value={days}
              disabled={busy || step.kind === 'tested'}
              options={[
                { value: 365, label: '1 año' },
                { value: 730, label: '2 años' },
              ]}
              onChange={setDays}
            />
          )}
        </div>
        <div className="lab-composer-foot">
          {step.kind === 'idle' || step.kind === 'generating' ? (
            <ul className="lab-examples" aria-label="Ideas de ejemplo">
              {(timeframe === '1h' ? HOURLY_EXAMPLES : DAILY_EXAMPLES).map((example) => (
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
          outcome={step.outcome}
          strategyId={step.strategyId}
          cashId={cashId}
          cash={cash}
          cashValid={cashValid}
          onCash={setCash}
          launching={step.kind === 'launching'}
          onLaunch={() => void launch()}
          onReset={reset}
          sectionRef={resultRef}
        />
      )}
    </section>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="lab-segmented" role="radiogroup" aria-label={label}>
      <span className="lab-segmented-label" aria-hidden="true">
        {label}
      </span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Cifras comunes de las dos pruebas para el veredicto. */
function summarize(outcome: Outcome) {
  if (outcome.timeframe === '1h') {
    const r = outcome.result;
    return {
      annual: r.annualizedReturn,
      total: r.totalReturn,
      bench: r.buyAndHold,
      drawdown: r.maxDrawdown,
      trades: r.tradeCount,
      winRate: r.winRate,
      ticker: r.ticker,
      period: `${longDate(r.desde)} – ${longDate(r.hasta)} · velas de 1 hora`,
    };
  }
  const { report } = outcome;
  const m = report.metrics;
  return {
    annual: m.annualizedReturn,
    total: m.totalReturn,
    bench: report.benchmark?.totalReturn ?? null,
    drawdown: m.maxDrawdown?.pct ?? null,
    trades: m.tradeCount,
    winRate: m.winRate,
    ticker: report.benchmark?.ticker ?? '',
    period: `${report.config.desde.slice(0, 4)}–${(report.config.ejecutadoHasta ?? report.config.hasta).slice(0, 4)}`,
  };
}

function BacktestVerdict({
  outcome,
  strategyId,
  cashId,
  cash,
  cashValid,
  onCash,
  launching,
  onLaunch,
  onReset,
  sectionRef,
}: {
  outcome: Outcome;
  strategyId: number;
  cashId: string;
  cash: string;
  cashValid: boolean;
  onCash: (value: string) => void;
  launching: boolean;
  onLaunch: () => void;
  onReset: () => void;
  sectionRef: React.RefObject<HTMLElement | null>;
}) {
  const v = summarize(outcome);
  const beat = v.total !== null && v.bench !== null ? v.total - v.bench : null;
  const verdict = labVerdict({
    total: v.total,
    benchmark: v.bench,
    trades: v.trades,
    asset: prettyTicker(v.ticker),
  });
  const discourage = verdict.tone === 'bad';
  const hourly = outcome.timeframe === '1h' ? outcome.result : null;
  // Solo se destaca una sesión que haya ganado dinero.
  const sessions = hourly?.bySession.filter((s) => s.trades > 0 && s.pnl > 0) ?? [];
  const best = sessions.reduce<(typeof sessions)[number] | null>(
    (top, s) => (top === null || s.pnl > top.pnl ? s : top),
    null,
  );
  return (
    <section
      className="lab-verdict"
      aria-labelledby={`${cashId}-verdict`}
      ref={sectionRef}
      tabIndex={-1}
    >
      <header>
        <h3 id={`${cashId}-verdict`}>Así le habría ido · {v.period}</h3>
        {outcome.timeframe === '1d' && (
          <a href={`#estrategias/${strategyId}/backtest/${outcome.report.id}`}>Informe completo</a>
        )}
      </header>
      <div className="lab-call" data-tone={verdict.tone} role="status">
        <strong>{verdict.title}</strong>
        <p>{verdict.text}</p>
      </div>
      <dl className="lab-stats">
        <div>
          <dt>{hourly ? 'Resultado total' : 'Rentabilidad anual'}</dt>
          <dd data-tone={tone(hourly ? v.total : v.annual)}>
            {signedPct(hourly ? v.total : v.annual)}
          </dd>
        </div>
        <div>
          <dt>Frente a comprar y esperar</dt>
          <dd data-tone={tone(beat)}>{beat === null ? '—' : `${signedPct(beat)} total`}</dd>
        </div>
        <div>
          <dt>Peor caída</dt>
          <dd>{pct(v.drawdown)}</dd>
        </div>
        <div>
          <dt>Operaciones</dt>
          <dd>
            {v.trades}
            {v.winRate !== null && (
              <span className="lab-stat-sub"> · {pct(v.winRate)} aciertos</span>
            )}
          </dd>
        </div>
      </dl>
      {hourly && hourly.curve.length > 1 && (
        <EquityChart
          curve={hourly.curve}
          initialCash={hourly.initialCash}
          benchmark={hourly.ticker}
          nowLabel={longDate(hourly.hasta)}
        />
      )}
      {hourly && (
        <table className="lab-sessions">
          <caption>Por sesión en la que entró</caption>
          <thead>
            <tr>
              <th scope="col">Sesión</th>
              <th scope="col">Operaciones</th>
              <th scope="col">Aciertos</th>
              <th scope="col">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {hourly.bySession
              .filter((s) => s.trades > 0 || s.session !== 'fuera')
              .map((s) => (
                <tr key={s.session} data-best={best?.session === s.session || undefined}>
                  <th scope="row">{SESSION_LABEL[s.session]}</th>
                  <td>{s.trades}</td>
                  <td>{s.winRate === null ? '—' : pct(s.winRate)}</td>
                  <td data-tone={tone(s.pnl / hourly.initialCash)}>
                    {s.trades === 0 ? '—' : signedMoney(s.pnl)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      {/* El veredicto ya habla de pocas operaciones; aquí solo el resto de avisos. */}
      {hourly?.warnings
        .filter((w) => !/30 operaciones/.test(w))
        .map((w) => (
          <p key={w} className="lab-caution">
            {w}
          </p>
        ))}
      <div className="lab-launch">
        <div>
          <h4>{discourage ? '¿Y ahora?' : 'Pruébala en el mercado real con dinero ficticio'}</h4>
          <p>
            {discourage
              ? 'Lo normal es probar otra idea o pedir cambios arriba. Si aun así quieres verla en el mercado real, puedes lanzarla con dinero ficticio.'
              : hourly
                ? 'Las reglas quedan congeladas y la estrategia opera cada hora desde la próxima hora en punto. Nada de lo que pase después puede cambiar su resultado.'
                : 'Las reglas quedan congeladas y la estrategia opera cada cierre desde hoy. Nada de lo que pase después puede cambiar su resultado.'}
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
          {discourage && (
            <button type="button" className="button primary" onClick={onReset}>
              Probar otra idea
            </button>
          )}
          <button
            type="button"
            className={discourage ? 'button' : 'button primary'}
            disabled={!cashValid || launching}
            aria-busy={launching}
            onClick={onLaunch}
          >
            {launching ? 'Lanzando…' : discourage ? 'Lanzar igualmente' : 'Lanzar prueba en vivo'}
          </button>
        </div>
      </div>
    </section>
  );
}
