import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSettings } from '../../../shared/ipc';
import { RISK_DISCLAIMER_VERSION } from '../../../shared/riskDisclaimer';
import { RiskDisclaimer } from './RiskDisclaimer';

export function RiskGate({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setError(false);
    void window.tradia.settings.get().then((value) => { if (active) setSettings(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  const accepted = settings?.disclaimerAcceptedVersion === RISK_DISCLAIMER_VERSION;
  useEffect(() => { if (accepted) content.current?.querySelector<HTMLElement>('h1')?.focus(); }, [accepted]);
  if (!settings) return <main className="risk-loading">{error ? <><p role="alert">No pudimos cargar los ajustes. Reintenta para continuar.</p><button className="button" onClick={() => setAttempt((value) => value + 1)}>Reintentar</button></> : <p role="status">Cargando ajustes…</p>}</main>;
  if (!accepted) return <RiskDisclaimer onAccept={async () => {
    const saved = await window.tradia.settings.set({ disclaimerAcceptedVersion: RISK_DISCLAIMER_VERSION });
    if (saved.disclaimerAcceptedVersion !== RISK_DISCLAIMER_VERSION || !saved.disclaimerAcceptedAt) throw new Error('Aceptación no confirmada');
    setSettings(saved);
  }} />;
  return <div ref={content}>{children}</div>;
}
