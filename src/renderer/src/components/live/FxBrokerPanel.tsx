import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  FX_FIXED_CAPS,
  FX_TEST_ORDER,
  formatEur,
  fxCredentialsProblem,
  fxLimitsProblems,
  fxLiveConfirmationPhrase,
  type FxBrokerEnvironment,
  type FxBrokerStatus,
  type FxEnvironmentStatus,
  type FxLimits,
  type FxTestOrderResult,
  type FxTestStep,
} from '../../../../shared/fxBroker';

const STEP_LABELS: Record<FxTestStep, string> = {
  precio: 'Precio leído',
  riesgo: 'Controles de riesgo superados',
  compra: 'Compra de 1 unidad ejecutada',
  cierre: 'Posición cerrada',
  conciliacion: 'Cuentas cuadradas con OANDA',
};

const money = (value: number, currency: string): string =>
  `${value.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/** Formulario de token y número de cuenta de un entorno. */
function ConnectForm({
  environment,
  busy,
  onConnect,
}: {
  environment: FxBrokerEnvironment;
  busy: boolean;
  onConnect: (token: string, accountId: string) => Promise<void>;
}) {
  const id = useId();
  const [account, setAccount] = useState('');
  const [token, setToken] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = fxCredentialsProblem({ environment, token, accountId: account });
  const practice = environment === 'practice';
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (problem) return;
        void onConnect(token, account).finally(() => setToken(''));
      }}
    >
      <fieldset disabled={busy}>
        <legend>{practice ? 'Conectar la cuenta de práctica' : 'Conectar la cuenta real'}</legend>
        <div className="live-fields">
          <div className="live-field">
            <label htmlFor={`${id}-account`}>Número de cuenta</label>
            <input
              id={`${id}-account`}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder={practice ? '101-004-1234567-001' : '001-004-1234567-001'}
              value={account}
              onChange={(event) => setAccount(event.target.value)}
            />
            <span className="live-field-hint">
              {practice
                ? 'Empieza por 101-: así se reconocen las cuentas de práctica.'
                : 'Empieza por 001-: así se reconocen las cuentas reales.'}
            </span>
          </div>
          <div className="live-field">
            <label htmlFor={`${id}-token`}>Token de acceso (API)</label>
            <input
              id={`${id}-token`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <span className="live-field-hint">
              Se guarda cifrado en el llavero del sistema y no se vuelve a mostrar.
            </span>
          </div>
        </div>
        {touched && problem && (
          <p className="live-field-error" role="alert">
            {problem}
          </p>
        )}
        <div className="live-actions">
          <button className="button live-primary" type="submit">
            {busy
              ? 'Comprobando con OANDA…'
              : practice
                ? 'Conectar cuenta de práctica'
                : 'Conectar cuenta real'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/** Saldo, posiciones abiertas y acciones de una cuenta conectada. */
function AccountView({
  env,
  busy,
  onClose,
  onDisconnect,
}: {
  env: FxEnvironmentStatus;
  busy: boolean;
  onClose: (instrument: FxEnvironmentStatus['positions'][number]['instrument']) => void;
  onDisconnect: () => void;
}) {
  const account = env.account;
  if (!account) return null;
  return (
    <div>
      <dl
        className="fx-account"
        aria-label={env.environment === 'practice' ? 'Saldo de práctica' : 'Saldo real'}
      >
        <div>
          <dt>Saldo</dt>
          <dd>{money(account.balance, account.currency)}</dd>
        </div>
        <div>
          <dt>Valor con lo abierto</dt>
          <dd>{money(account.nav, account.currency)}</dd>
        </div>
        <div>
          <dt>Garantía retenida</dt>
          <dd>{money(account.marginUsed, account.currency)}</dd>
        </div>
        <div>
          <dt>Cuenta</dt>
          <dd>
            {account.accountMasked}
            {env.simulated ? ' · simulada' : ''}
          </dd>
        </div>
      </dl>
      {env.positions.length === 0 ? (
        <p>No tienes posiciones abiertas.</p>
      ) : (
        <table className="fx-positions">
          <caption>Posiciones abiertas</caption>
          <thead>
            <tr>
              <th scope="col">Activo</th>
              <th scope="col">Lado</th>
              <th scope="col">Unidades</th>
              <th scope="col">Precio medio</th>
              <th scope="col">Resultado</th>
              <th scope="col">
                <span className="sr-only">Acción</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {env.positions.map((p) => (
              <tr key={`${p.instrument}-${p.side}`}>
                <td>{p.label}</td>
                <td>{p.side === 'long' ? 'Compra' : 'Venta'}</td>
                <td>{p.units}</td>
                <td>{p.avgPrice}</td>
                <td>{p.unrealizedPnl === null ? '—' : money(p.unrealizedPnl, account.currency)}</td>
                <td>
                  <button className="button" disabled={busy} onClick={() => onClose(p.instrument)}>
                    Cerrar {p.label}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="button" disabled={busy} onClick={onDisconnect}>
        Desconectar esta cuenta
      </button>
    </div>
  );
}

function LimitsEditor({
  saved,
  busy,
  onSave,
}: {
  saved: FxLimits;
  busy: boolean;
  onSave: (limits: FxLimits) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => ({
    capitalEur: String(saved.capitalEur),
    riskPerOrderEur: String(saved.riskPerOrderEur),
    dailyLossEur: String(saved.dailyLossEur),
    openPositions: String(saved.openPositions),
  }));
  const parsed: FxLimits = {
    capitalEur: Number(draft.capitalEur.replace(',', '.')),
    riskPerOrderEur: Number(draft.riskPerOrderEur.replace(',', '.')),
    dailyLossEur: Number(draft.dailyLossEur.replace(',', '.')),
    openPositions: Number(draft.openPositions),
  };
  const problems = fxLimitsProblems(parsed);
  const field = (key: keyof typeof draft, label: string, hint: string) => (
    <div className="live-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        inputMode="decimal"
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
      <span className="live-field-hint">{hint}</span>
    </div>
  );
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length === 0) void onSave(parsed);
      }}
    >
      <fieldset disabled={busy}>
        <legend>Tus límites de divisas y oro (en euros)</legend>
        <div className="live-fields">
          {field(
            'capitalEur',
            'Capital para divisas (€)',
            `Lo máximo que el bróker puede retener como garantía: de ${FX_FIXED_CAPS.capitalEurMin} a ${FX_FIXED_CAPS.capitalEur} €.`,
          )}
          {field(
            'riskPerOrderEur',
            'Riesgo por orden de divisas (€)',
            `Lo que pierdes como mucho si salta el stop: hasta ${formatEur(FX_FIXED_CAPS.riskPerOrderEur)}.`,
          )}
          {field(
            'dailyLossEur',
            'Pérdida máxima al día en divisas (€)',
            `Al llegar, no se abren más órdenes hasta mañana: hasta ${formatEur(FX_FIXED_CAPS.dailyLossEur)}.`,
          )}
          {field(
            'openPositions',
            'Posiciones de divisas a la vez',
            `De 1 a ${FX_FIXED_CAPS.openPositions}.`,
          )}
        </div>
        {problems.length > 0 && (
          <ul className="live-field-error" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="live-actions">
          <button className="button" type="submit" disabled={problems.length > 0}>
            Guardar mis límites en euros
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/**
 * Divisas y oro con OANDA, dentro de «Dinero real»: conectar la cuenta
 * de práctica, ver el saldo, hacer una orden mínima de prueba y fijar
 * los límites en euros; la cuenta real se abre al completar la lista.
 */
export function FxBrokerPanel() {
  const id = useId();
  const [status, setStatus] = useState<FxBrokerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState<FxTestOrderResult | null>(null);
  const [phrase, setPhrase] = useState('');
  const mounted = useRef(false);

  const reload = useCallback(async () => {
    try {
      const next = await window.tradia.fxBroker.status();
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError('No se pudo leer el estado de OANDA. Vuelve a intentarlo.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.tradia.fxBroker.onChanged((next) => {
      if (mounted.current) setStatus(next);
    });
    void reload();
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [reload]);

  const run = async (action: () => Promise<FxBrokerStatus | void>, ok?: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await action();
      if (!mounted.current) return;
      if (next) setStatus(next);
      if (ok) setNotice(ok);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
            : String(cause),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const practice = status?.practice;
  const live = status?.live;
  const practiceConnected = practice?.state === 'conectada' || (practice?.account ?? null) !== null;
  const liveConnected = live?.state === 'conectada' || (live?.account ?? null) !== null;

  return (
    <section
      data-layout-block="divisas-oanda"
      className="live-sheet fx-broker"
      aria-labelledby={`${id}-title`}
      aria-busy={loading || busy}
    >
      <h3 id={`${id}-title`}>Divisas y oro con OANDA</h3>
      <p>
        Alpaca solo opera acciones. Para EUR/USD, USD/JPY, GBP/USD y oro, Tradia usa el bróker
        OANDA, que permite órdenes desde 1 unidad (1 € en EUR/USD). Empieza con la cuenta de
        práctica: es dinero simulado, así que no arriesgas nada.
      </p>
      {loading && <p role="status">Comprobando tus cuentas de OANDA…</p>}
      {status?.killSwitchActive && (
        <p className="live-warning" role="alert">
          La parada de emergencia está activa: no se abre ninguna orden y se han cerrado las
          posiciones de OANDA.
        </p>
      )}

      <h4>1. Cuenta de práctica</h4>
      {practice && !practiceConnected && (
        <>
          <details>
            <summary>¿Dónde consigo el número de cuenta y el token?</summary>
            <ol>
              <li>Crea una cuenta de práctica gratuita en la web de OANDA (fxTrade Practice).</li>
              <li>
                Entra en tu área de cliente, abre «Gestionar acceso a la API» (Manage API Access) y
                genera un token.
              </li>
              <li>Copia el número de cuenta de práctica (empieza por 101-) y el token aquí.</li>
            </ol>
          </details>
          <ConnectForm
            environment="practice"
            busy={busy}
            onConnect={(token, accountId) =>
              run(async () => {
                const next = await window.tradia.fxBroker.connect({
                  environment: 'practice',
                  token: token.trim(),
                  accountId: accountId.trim(),
                });
                if (next.practice.state !== 'conectada') {
                  setStatus(next);
                  throw new Error(next.practice.error ?? 'No se pudo conectar la cuenta.');
                }
                return next;
              }, 'Cuenta de práctica conectada.')
            }
          />
        </>
      )}
      {practice && practiceConnected && (
        <AccountView
          env={practice}
          busy={busy}
          onClose={(instrument) =>
            void run(
              () => window.tradia.fxBroker.closePosition({ environment: 'practice', instrument }),
              'Posición cerrada.',
            )
          }
          onDisconnect={() =>
            void run(
              () => window.tradia.fxBroker.disconnect('practice'),
              'Cuenta de práctica desconectada.',
            )
          }
        />
      )}
      {practice?.error && practiceConnected && (
        <p className="live-warning" role="alert">
          {practice.error}
        </p>
      )}

      <h4>2. Orden mínima de prueba</h4>
      <p>
        Compra {FX_TEST_ORDER.units} unidad de EUR/USD (1 €) con un stop a{' '}
        {String(FX_TEST_ORDER.stopPct).replace('.', ',')} % y un objetivo a{' '}
        {String(FX_TEST_ORDER.targetPct).replace('.', ',')} %, la cierra al momento y comprueba que
        Tradia y OANDA cuentan lo mismo. Pasa por el motor de riesgo y tus límites como cualquier
        orden.
      </p>
      <button
        className="button live-primary"
        disabled={!practiceConnected || busy || !!status?.killSwitchActive}
        onClick={() =>
          void run(async () => {
            const result = await window.tradia.fxBroker.testOrder({
              environment: 'practice',
              confirm: true,
            });
            setTest(result);
            return result.status;
          })
        }
      >
        {busy ? 'Haciendo la orden de prueba…' : 'Hacer orden de prueba en práctica'}
      </button>
      {!practiceConnected && <p>Conecta antes la cuenta de práctica.</p>}
      {test && (
        <div role="status" aria-label="Resultado de la orden de prueba">
          <p>
            <strong>
              {test.ok ? 'Orden de prueba correcta' : 'La orden de prueba no se completó'}
            </strong>
          </p>
          <p>{test.summary}</p>
          {test.error && <p className="live-warning">{test.error}</p>}
          {test.steps.length > 0 && (
            <ul>
              {test.steps.map((step) => (
                <li key={step}>✓ {STEP_LABELS[step]}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h4>3. Límites para empezar con poco</h4>
      {status && (
        <LimitsEditor
          key={JSON.stringify(status.limits)}
          saved={status.limits}
          busy={busy}
          onSave={(limits) =>
            run(() => window.tradia.fxBroker.setLimits(limits), 'Límites de divisas guardados.')
          }
        />
      )}

      <h4>4. Cuenta real</h4>
      <p className="live-warning">
        Con la cuenta real operas con tu dinero y puedes perderlo. Empieza solo cuando la práctica
        te funcione y con un importe que puedas permitirte perder.
      </p>
      {status && !status.liveGateOpen && (
        <p>
          Se desbloquea cuando completes la lista de comprobación de esta página. Las claves de la
          cuenta real van en una ranura aparte: un token de práctica nunca sirve aquí.
        </p>
      )}
      {status?.liveGateOpen && live && !liveConnected && (
        <ConnectForm
          environment="live"
          busy={busy}
          onConnect={(token, accountId) =>
            run(async () => {
              const next = await window.tradia.fxBroker.connect({
                environment: 'live',
                token: token.trim(),
                accountId: accountId.trim(),
              });
              if (next.live.state !== 'conectada') {
                setStatus(next);
                throw new Error(next.live.error ?? 'No se pudo conectar la cuenta real.');
              }
              return next;
            }, 'Cuenta real conectada. Conectarla no envía ninguna orden.')
          }
        />
      )}
      {live && liveConnected && (
        <>
          <AccountView
            env={live}
            busy={busy}
            onClose={(instrument) =>
              void run(
                () => window.tradia.fxBroker.closePosition({ environment: 'live', instrument }),
                'Posición cerrada.',
              )
            }
            onDisconnect={() =>
              void run(() => window.tradia.fxBroker.disconnect('live'), 'Cuenta real desconectada.')
            }
          />
          {status && !status.liveConfirmed && (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () => window.tradia.fxBroker.confirmLive({ phrase }),
                  'Límites confirmados para la cuenta real.',
                );
              }}
            >
              <label htmlFor={`${id}-phrase`}>
                Para operar con dinero real, escribe esta frase:
              </label>
              <p className="live-phrase">{fxLiveConfirmationPhrase(status.limits)}</p>
              <input
                id={`${id}-phrase`}
                autoComplete="off"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
              />
              <button className="button" type="submit" disabled={busy}>
                Confirmar límites
              </button>
            </form>
          )}
        </>
      )}
      {status?.liveGateOpen && live?.error && !liveConnected && (
        <p className="live-warning" role="alert">
          {live.error}
        </p>
      )}

      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="live-warning" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
