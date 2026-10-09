import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isBrokerCredentials } from '../../../../shared/ipc';
import { useBroker } from '../../hooks/useBroker';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
import './broker-settings.css';

export function BrokerSettings() {
  const broker = useBroker();
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState(false);
  const [validation, setValidation] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState('');
  const keyInput = useRef<HTMLInputElement>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const connected = broker.status?.state === 'conectada';
  const credentials = { apiKeyId: key.trim(), apiSecret: secret.trim() };
  const valid = isBrokerCredentials(credentials);
  const keyValid = isBrokerCredentials({ apiKeyId: key.trim(), apiSecret: 'valid00' });
  async function connect() {
    setValidation(true);
    if (!valid) {
      (keyValid ? secretInput : keyInput).current?.focus();
      return;
    }
    setMessage('');
    const result = await broker.connect(credentials);
    if (result.clearDraft) {
      setKey('');
      setSecret('');
    }
    setValidation(false);
    if (result.ok) {
      setEditing(false);
      setMessage('Cuenta paper conectada');
      window.setTimeout(() => summary.current?.focus(), 0);
    }
  }
  return (
    <SettingsSection
      title="Cuenta de broker · Paper"
      description="Conecta una cuenta de Alpaca Paper. Tradia no admite cuentas live ni puede retirar fondos."
    >
      <div className="broker-settings" aria-busy={broker.loading || broker.busy}>
        <span className="broker-paper-badge">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 15h8" />
          </svg>
          Solo paper · sin dinero real
        </span>
        {broker.loading ? (
          <p role="status">Cargando cuenta paper…</p>
        ) : (
          <>
            {connected && broker.status?.account && (
              <div ref={summary} tabIndex={-1} className="broker-account">
                <strong>✓ Cuenta paper conectada</strong>
                <p>
                  {broker.status.adapter === 'simulado' ? 'Broker simulado' : 'Alpaca'} · Cuenta
                  •••• {broker.status.account.accountId.slice(-4)}
                </p>
                <p>
                  Saldo paper{' '}
                  <span className="broker-balance">
                    {new Intl.NumberFormat('es-ES', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).format(broker.status.account.cash)}{' '}
                    {broker.status.account.currency}
                  </span>
                </p>
              </div>
            )}
            {(!connected || editing) && (
              <form
                className="settings-form"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect();
                }}
              >
                <p role="status">
                  {broker.busy
                    ? 'Comprobando cuenta paper…'
                    : 'Sin conectar · introduce las claves de tu cuenta paper'}
                </p>
                <div className="broker-fields">
                  <div className="channel-field">
                    <label htmlFor="broker-key">Clave de API</label>
                    <input
                      ref={keyInput}
                      id="broker-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={256}
                      value={key}
                      disabled={broker.busy}
                      aria-describedby="broker-key-help broker-credentials-help"
                      aria-invalid={validation && !key.trim()}
                      onChange={(event) => setKey(event.target.value)}
                      onBlur={() => setValidation(true)}
                    />
                    <span id="broker-key-help">
                      {validation && !key.trim() ? 'Introduce la clave de API' : ''}
                    </span>
                  </div>
                  <div className="channel-field">
                    <label htmlFor="broker-secret">Secreto de API</label>
                    <input
                      ref={secretInput}
                      id="broker-secret"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={256}
                      value={secret}
                      disabled={broker.busy}
                      aria-describedby="broker-secret-help broker-credentials-help"
                      aria-invalid={validation && !secret.trim()}
                      onChange={(event) => setSecret(event.target.value)}
                      onBlur={() => setValidation(true)}
                    />
                    <span id="broker-secret-help">
                      {validation && !secret.trim() ? 'Introduce el secreto de API' : ''}
                    </span>
                  </div>
                </div>
                <p id="broker-credentials-help">
                  Las claves se cifran en el llavero del sistema y nunca vuelven a mostrarse.
                </p>
                {validation && key.trim() && secret.trim() && !valid && (
                  <p role="alert">
                    Usa claves de 6 a 256 caracteres alfanuméricos o guiones, sin espacios.
                  </p>
                )}
                <div className="settings-actions">
                  <button className="button primary" type="submit" disabled={!valid || broker.busy}>
                    {broker.busy ? 'Comprobando cuenta paper…' : 'Probar conexión'}
                  </button>
                  {connected && (
                    <button
                      className="button"
                      type="button"
                      disabled={broker.busy}
                      onClick={() => {
                        setEditing(false);
                        setKey('');
                        setSecret('');
                      }}
                    >
                      Cancelar reemplazo
                    </button>
                  )}
                </div>
              </form>
            )}
            {connected && (
              <>
                {!editing && (
                  <div className="setting-row">
                    <strong>Clave y secreto guardados de forma cifrada</strong>
                    <button
                      className="button"
                      disabled={broker.busy}
                      onClick={() => {
                        setEditing(true);
                        setValidation(false);
                      }}
                    >
                      Reemplazar claves
                    </button>
                  </div>
                )}
                <div className="setting-row">
                  <div>
                    <label htmlFor="broker-execution">
                      <strong>Ejecutar señales aprobadas en paper</strong>
                    </label>
                    <p id="broker-execution-help">
                      Las señales aprobadas o reducidas por Riesgo se enviarán al broker paper. La
                      parada de emergencia sigue teniendo prioridad.
                    </p>
                    <span>{broker.status?.executionEnabled ? 'Activado' : 'Desactivado'}</span>
                  </div>
                  <label className="setting-switch">
                    <input
                      id="broker-execution"
                      type="checkbox"
                      role="switch"
                      checked={broker.status?.executionEnabled ?? false}
                      disabled={broker.busy}
                      aria-describedby="broker-execution-help"
                      onChange={(event) => void broker.setExecution(event.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                </div>
                <div className="settings-actions">
                  <button
                    ref={disconnectButton}
                    className="button danger"
                    disabled={broker.busy}
                    onClick={() => setConfirm(true)}
                  >
                    Desconectar
                  </button>
                  <button
                    className="button"
                    disabled={broker.busy}
                    onClick={() => {
                      setMessage('');
                      void broker.test().then((ok) => {
                        if (ok) setMessage('Conexión paper comprobada');
                      });
                    }}
                  >
                    {broker.busy ? 'Comprobando cuenta paper…' : 'Probar de nuevo'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
        <SettingsFeedback error={broker.error || broker.status?.error || ''} message={message} />
        {!broker.status && broker.error && (
          <button className="button" disabled={broker.loading} onClick={() => void broker.reload()}>
            Reintentar cuenta paper
          </button>
        )}
      </div>
      {confirm && (
        <DisconnectDialog
          busy={broker.busy}
          error={broker.error}
          close={() => {
            setConfirm(false);
            window.setTimeout(() => (disconnectButton.current ?? keyInput.current)?.focus(), 0);
          }}
          disconnect={async () => {
            if (await broker.disconnect()) {
              setConfirm(false);
              setEditing(false);
              setMessage('Cuenta paper desconectada. Claves borradas.');
              window.setTimeout(() => keyInput.current?.focus(), 0);
            }
          }}
        />
      )}
    </SettingsSection>
  );
}

function DisconnectDialog({
  busy,
  error,
  close,
  disconnect,
}: {
  busy: boolean;
  error: string;
  close: () => void;
  disconnect: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    safe.current?.focus();
    const app = document.querySelector<HTMLElement>('.app');
    const previous = app?.inert;
    if (app) app.inert = true;
    return () => {
      if (app) app.inert = previous ?? false;
    };
  }, []);
  return createPortal(
    <div className="broker-modal-backdrop">
      <div
        ref={dialog}
        className="broker-disconnect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="broker-disconnect-title"
        aria-describedby="broker-disconnect-help"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            close();
          }
          if (event.key === 'Tab') {
            const buttons =
              dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (!buttons?.length) {
              event.preventDefault();
              return;
            }
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id="broker-disconnect-title">Desconectar la cuenta paper</h2>
        <p id="broker-disconnect-help">
          Tradia dejará de enviar órdenes y borrará las claves guardadas. Las órdenes y el Diario se
          conservan.
        </p>
        <SettingsFeedback error={error} />
        <div className="settings-actions">
          <button ref={safe} className="button" disabled={busy} onClick={close}>
            Mantener conectada
          </button>
          <button className="button danger" disabled={busy} onClick={() => void disconnect()}>
            {busy ? 'Desconectando…' : 'Desconectar y borrar claves'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
