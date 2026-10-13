import { useEffect, useId, useRef, useState } from 'react';
import { liveConfirmationPhrase, type LiveLimits } from '../../../../shared/live';
import { ShortReadiness, shortLimitsBlockReason } from './ShortReadiness';
import { LimitsForm } from './LimitsForm';
import { LiveActivationDialog } from './LiveActivationDialog';
import { checklistReasons, useLiveChecklist } from './useLiveChecklist';
import { liveTokens } from './presentation';
import './checklist.css';
import './live.css';

export function LiveLimitsSettings() {
  const state = useLiveChecklist();
  const id = useId();
  const [dirty, setDirty] = useState(false);
  const [dialog, setDialog] = useState<LiveLimits | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  const active = state.snapshot?.state.mode === 'activo';
  const disabled = state.loading || state.busy || state.offline;
  const shortBlockReason = shortLimitsBlockReason(
    state.snapshot?.checklist,
    state.loading,
    state.error,
    state.offline,
  );
  const shortBlocked = !!shortBlockReason;
  const savedShort =
    !!state.limits &&
    (state.limits.shortOrderUsd > 0 ||
      state.limits.shortExposureUsd > 0 ||
      state.limits.shortPositions > 0);
  const reasons = checklistReasons(state.snapshot);
  const ready = !disabled && !state.error && !dirty && !!state.limits && reasons.length === 0;
  useEffect(() => {
    if (
      !state.busy &&
      (!ready ||
        (dialog &&
          state.limits &&
          liveConfirmationPhrase(dialog) !== liveConfirmationPhrase(state.limits)))
    )
      setDialog(null);
  }, [ready, dialog, state.busy, state.limits]);
  return (
    <div className="live-surface live-limits-settings" aria-busy={state.loading || state.busy}>
      <style>{liveTokens()}</style>
      <ShortReadiness
        checklist={state.snapshot?.checklist}
        loading={state.loading}
        disabled={disabled || !!state.error || !state.snapshot}
        blocked={shortBlocked}
        savedShort={savedShort}
        onDeclare={state.declare}
        onReload={() => void state.reload()}
      />
      <LimitsForm
        key={state.limits ? liveConfirmationPhrase(state.limits) : 'unsaved'}
        saved={state.limits}
        disabled={disabled || !!state.error || !state.snapshot || active}
        shortBlocked={shortBlocked}
        shortBlockReason={shortBlockReason}
        onSave={state.save}
        onDirty={setDirty}
        confirmed={!!state.snapshot?.checklist.limits.confirmed}
      />
      {state.error && (
        <p role="alert">
          {state.error} <button onClick={() => void state.reload()}>Reintentar límites</button>
        </p>
      )}
      {state.offline && (
        <p role="status">Sin conexión · no se pueden guardar ni confirmar límites.</p>
      )}
      <p ref={notice} tabIndex={-1} className="live-meta" role="status" aria-live="polite">
        {state.loading ? 'Comprobando los requisitos del corto…' : state.notice}
      </p>
      {state.limits && !dirty && (
        <p className="live-phrase">{liveConfirmationPhrase(state.limits)}</p>
      )}
      {!active && (
        <>
          <p id={`${id}-confirmation-help`}>
            Confirmar esta frase activa dinero real con estos límites. Completa antes la{' '}
            <a href="#dinero-real">lista de comprobación</a>.
          </p>
          {reasons.length > 0 && (
            <ul>
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <button
            ref={trigger}
            className="button"
            disabled={!ready}
            aria-describedby={`${id}-confirmation-help`}
            onClick={async () => {
              if (await state.prepare()) {
                trigger.current?.focus();
                setDialog(state.limits);
              }
            }}
          >
            Confirmar límites y activar dinero real
          </button>
          {state.rejection.length > 0 && (
            <ul role="alert">
              {state.rejection.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {dialog && state.snapshot?.state.accountMasked && (
        <LiveActivationDialog
          limits={dialog}
          account={state.snapshot.state.accountMasked}
          busy={state.busy}
          onCancel={() => setDialog(null)}
          onConfirm={async (phrase) => {
            await state.activate(phrase);
            setDialog(null);
            window.setTimeout(() => notice.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}
