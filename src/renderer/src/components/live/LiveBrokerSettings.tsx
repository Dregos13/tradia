import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { isLiveConnectRequest } from '../../../../shared/ipc';
import {
  LIVE_REQUIREMENTS,
  LIVE_REQUIREMENT_TITLES,
  type LiveChecklist,
} from '../../../../shared/live';
import { SettingsFeedback, SettingsSection } from '../settings/SettingsSection';
import { LiveIcon, liveTokens } from './presentation';
import { LiveNavigation } from './LiveNavigation';
import { useLiveState } from './useLiveState';
import { useLiveSafety } from './useLiveSafety';
import './checklist.css';
import './live.css';

export function LiveBrokerSettings({ onOpenChecklist }: { onOpenChecklist?: () => void } = {}) {
  const live = useLiveState();
  const safety = useLiveSafety();
  const id = useId();
  const [checklist, setChecklist] = useState<LiveChecklist | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState('');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  const available = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    setChecking(true);
    setCheckError('');
    try {
      const next = await window.tradia.live.checklist();
      if (mounted.current && version === generation.current) setChecklist(next);
    } catch {
      if (mounted.current && version === generation.current)
        setCheckError('No se pudo verificar la lista. Las claves live permanecen bloqueadas.');
    } finally {
      if (mounted.current && version === generation.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.tradia.live.onChanged(() => void reload());
    void reload();
    window.addEventListener('focus', reload);
    return () => {
      mounted.current = false;
      generation.current++;
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  const pending = LIVE_REQUIREMENTS.filter(
    (requirement) =>
      checklist?.items.find((row) => row.requirement === requirement)?.state !== 'cumplido',
  );
  const allowed =
    !!checklist?.allComplete &&
    pending.length === 0 &&
    !checking &&
    !checkError &&
    !live.error &&
    !live.loading;
  const operating = live.state?.mode === 'activo' || live.state?.mode === 'suspendido';
  const disabled = !allowed || !safety.online || operating || busy;
  available.current = allowed && safety.online && !operating;
  const credentials = { apiKeyId: key.trim(), apiSecret: secret.trim() };
  const keyValid =
    credentials.apiKeyId.startsWith('AK') &&
    isLiveConnectRequest({ ...credentials, apiSecret: 'valid00' });
  const secretValid = isLiveConnectRequest({
    apiKeyId: 'AKvalid00',
    apiSecret: credentials.apiSecret,
  });
  useEffect(() => {
    if (!allowed || !safety.online || operating) {
      setKey('');
      setSecret('');
      setEditing(false);
    }
  }, [allowed, safety.online, operating]);
  async function connect() {
    if (working.current || disabled) return;
    setTouched(true);
    if (!keyValid || !secretValid) {
      first.current?.focus();
      return;
    }
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // Recheck immediately before handing credentials to main, which validates again.
      const fresh = await window.tradia.live.checklist();
      if (
        !fresh.allComplete ||
        LIVE_REQUIREMENTS.some(
          (r) => fresh.items.find((row) => row.requirement === r)?.state !== 'cumplido',
        )
      ) {
        setChecklist(fresh);
        throw new Error('La lista ha cambiado. Completa los requisitos antes de conectar.');
      }
      if (!mounted.current || !available.current)
        throw new Error('La conexión o el modo ha cambiado. Verifica el estado antes de conectar.');
      const next = await window.tradia.live.connect(credentials);
      if (!mounted.current) return;
      live.accept(next);
      if (!next.hasCredentials || !next.accountMasked)
        throw new Error('La cuenta live no se pudo verificar. Revisa la conexión.');
      setEditing(false);
      setNotice('Cuenta live verificada. Conectar las claves no activa dinero real.');
      summary.current?.focus();
    } catch (cause) {
      let reason =
        cause instanceof Error
          ? cause.message
          : 'No se pudo conectar la cuenta live. Revisa claves, conexión y permisos del llavero.';
      for (const value of Object.values(credentials)) reason = reason.split(value).join('[oculto]');
      if (mounted.current) setError(reason);
    } finally {
      working.current = false;
      if (mounted.current) {
        setKey('');
        setSecret('');
        setBusy(false);
      }
    }
  }
  return (
    <SettingsSection
      title="Cuenta de broker · Dinero real"
      description="Claves de Alpaca Live en una ranura cifrada separada. Solo disponible con la lista de comprobación cumplida."
    >
      <div className="live-surface live-broker" aria-busy={checking || live.loading || busy}>
        <style>{liveTokens()}</style>
        <p className="live-warning">
          <LiveIcon /> Las órdenes live usan capital real y pueden generar pérdidas.
        </p>
        {(checking || live.loading) && <p role="status">Comprobando requisitos y cuenta live…</p>}
        {!allowed && !checking && (
          <div role="region" aria-label="Claves live bloqueadas">
            <strong>Completa la lista antes de conectar las claves live.</strong>
            <ul>
              {pending.map((requirement) => (
                <li key={requirement}>{LIVE_REQUIREMENT_TITLES[requirement]}</li>
              ))}
            </ul>
          </div>
        )}
        <LiveNavigation
          label="Ver lista de comprobación"
          href="#dinero-real"
          onOpen={onOpenChecklist}
        />
        {!safety.online && (
          <p role="status">Sin conexión verificada · las claves live están bloqueadas.</p>
        )}
        {live.state?.hasCredentials && (
          <p ref={summary} tabIndex={-1}>
            <strong>Claves live guardadas de forma cifrada</strong>
            <br />
            Alpaca Live · {live.state.accountMasked ?? 'Cuenta sin verificar'} · Las claves nunca
            vuelven a mostrarse.
          </p>
        )}
        {operating && <p>Vuelve a paper desde Dinero real antes de reemplazar las claves live.</p>}
        {allowed && (!live.state?.hasCredentials || editing) && !operating && (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <fieldset disabled={disabled}>
              <legend>Conexión de Alpaca Live</legend>
              <div className="live-fields">
                <div className="live-field">
                  <label htmlFor={`${id}-key`}>Clave de API live</label>
                  <input
                    ref={first}
                    id={`${id}-key`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={256}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    onBlur={() => setTouched(true)}
                    aria-invalid={touched && !keyValid}
                    aria-describedby={`${id}-key-help`}
                  />
                  <span id={`${id}-key-help`} className="live-field-error">
                    {touched && !keyValid
                      ? 'Introduce una clave live con prefijo AK, de 6 a 256 caracteres alfanuméricos o guiones.'
                      : 'Usa la clave de la cuenta live (prefijo AK).'}
                  </span>
                </div>
                <div className="live-field">
                  <label htmlFor={`${id}-secret`}>Secreto de API live</label>
                  <input
                    id={`${id}-secret`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={256}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    onBlur={() => setTouched(true)}
                    aria-invalid={touched && !secretValid}
                    aria-describedby={`${id}-secret-help`}
                  />
                  <span id={`${id}-secret-help`} className="live-field-error">
                    {touched && !secretValid
                      ? 'Introduce un secreto de 6 a 256 caracteres alfanuméricos o guiones.'
                      : 'No se vuelve a mostrar después de enviarlo.'}
                  </span>
                </div>
              </div>
              <p>
                Las claves se cifran en el llavero del sistema. Declara que no permiten retirar
                fondos en la lista de comprobación.
              </p>
              <div className="live-actions">
                <button className="button live-primary" type="submit">
                  {busy ? 'Verificando cuenta live…' : 'Verificar y guardar claves live'}
                </button>
              </div>
            </fieldset>
            {editing && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setKey('');
                  setSecret('');
                }}
              >
                Cancelar reemplazo
              </button>
            )}
          </form>
        )}
        {live.state?.hasCredentials && !editing && (
          <button
            className="button"
            disabled={disabled}
            onClick={() => {
              setEditing(true);
              setTouched(false);
            }}
          >
            Reemplazar claves live
          </button>
        )}
        <SettingsFeedback error={error || checkError || live.error} message={notice} />
        {(checkError || live.error) && (
          <button
            className="button"
            onClick={() => {
              void reload();
              void live.reload();
            }}
          >
            Reintentar cuenta live
          </button>
        )}
      </div>
    </SettingsSection>
  );
}
