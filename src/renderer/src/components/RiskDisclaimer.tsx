import { useEffect, useRef, useState } from 'react';
import { RISK_DISCLAIMER_PARAGRAPHS, RISK_DISCLAIMER_VERSION } from '../../../shared/riskDisclaimer';

interface Props {
  onAccept?: () => Promise<void>;
  onClose?: () => void;
}

export function RiskDisclaimer({ onAccept, onClose }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { heading.current?.focus(); }, []);
  const accept = async () => {
    if (!checked || saving || !onAccept) return;
    setSaving(true);
    setError(false);
    try { await onAccept(); }
    catch { setError(true); setSaving(false); }
  };
  return (
    <main className="risk-shell">
      <aside className="risk-brand">
        <div className="logo">Tradia</div>
        <p>Decisiones basadas en datos, con el riesgo por delante de la rentabilidad.</p>
        <p>{onAccept ? 'Primer arranque' : 'Ajustes · Legal'} · Aviso {RISK_DISCLAIMER_VERSION}</p>
      </aside>
      <section className="risk-main" aria-labelledby="risk-title">
        <div className="risk-content">
          <h1 id="risk-title" ref={heading} tabIndex={-1}>{onAccept ? 'Antes de empezar' : 'Aviso de riesgo'}</h1>
          <p className="risk-intro">Lee este aviso con atención. Tradia empezará en modo de señales y simulación.</p>
          <div className="risk-notice">
            <div className="risk-warning">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Zm0 5v6m0 3v.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <div><strong>Tu capital está en riesgo.</strong><br />La app no puede garantizar resultados ni evitar todas las pérdidas.</div>
            </div>
            <div className="risk-copy">{RISK_DISCLAIMER_PARAGRAPHS.map((text) => <p key={text}>{text}</p>)}</div>
            <p className="risk-meta">Versión del aviso {RISK_DISCLAIMER_VERSION} · Podrás volver a consultarlo en Ajustes › Legal.</p>
            {onAccept && <label className="risk-accept"><input type="checkbox" checked={checked} disabled={saving} onChange={(event) => setChecked(event.target.checked)} /><span>He leído y acepto</span></label>}
            {error && <p className="risk-error" role="alert">No pudimos guardar la aceptación. Inténtalo de nuevo con Continuar.</p>}
            <div className="risk-actions">
              {onAccept ? <><p id="accept-hint">{checked ? 'La aceptación guardará la versión y la fecha.' : 'Marca la casilla para continuar.'}</p><button className="button primary" disabled={!checked || saving} aria-describedby="accept-hint" onClick={() => void accept()}>{saving ? 'Guardando…' : 'Continuar'}</button></> : <button className="button" onClick={onClose}>Volver a Ajustes</button>}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
