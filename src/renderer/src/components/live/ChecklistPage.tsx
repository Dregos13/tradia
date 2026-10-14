import { useEffect, useId, useRef, useState } from 'react';
import type { DeliveryTestableChannel } from '../../../../shared/journal';
import { liveConfirmationPhrase, type LiveLimits } from '../../../../shared/live';
import { ChecklistRow } from './ChecklistRow';
import { ShortReadiness, shortLimitsBlockReason } from './ShortReadiness';
import { LimitsForm } from './LimitsForm';
import { LiveDeactivationButton } from './LiveDeactivationButton';
import { LiveActivationDialog } from './LiveActivationDialog';
import { LiveIcon, liveTokens, timestamp } from './presentation';
import { checklistReasons, useLiveChecklist } from './useLiveChecklist';
import './checklist.css';

export interface ChecklistPageProps {
  onOpenValidation?: () => void;
  onOpenPaper?: () => void;
  onOpenAlerts?: () => void;
  onOpenStrategies?: () => void;
}
export function ChecklistPage({
  onOpenValidation,
  onOpenPaper,
  onOpenAlerts,
  onOpenStrategies,
}: ChecklistPageProps = {}) {
  const state = useLiveChecklist();
  const id = useId();
  const error = state.loadError || state.error;
  const [channel, setChannel] = useState<DeliveryTestableChannel>('telegram');
  const [dirty, setDirty] = useState(false);
  const [dialog, setDialog] = useState<LiveLimits | null>(null);
  const reasonsTitle = useRef<HTMLHeadingElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const activateButton = useRef<HTMLButtonElement>(null);
  const disabled = state.loading || state.busy || state.offline;
  const shortBlockReason =
    shortLimitsBlockReason(
      state.snapshot?.checklist,
      state.loading,
      state.loadError,
      state.offline,
    ) ??
    (state.shortSaveError
      ? 'El corto real permanece bloqueado. Revisa sus requisitos o pon sus límites a 0.'
      : undefined);
  const shortBlocked = !!shortBlockReason;
  const savedShort =
    !!state.limits &&
    (state.limits.shortOrderUsd > 0 ||
      state.limits.shortExposureUsd > 0 ||
      state.limits.shortPositions > 0);
  const reasons = [
    ...new Set([
      ...checklistReasons(state.snapshot),
      ...state.rejection,
      ...(state.loading ? ['Comprobando requisitos en el proceso principal…'] : []),
      ...(state.offline ? ['Sin conexión · no se puede activar dinero real.'] : []),
      ...(error ? [error] : []),
      ...(state.saveError ? [state.saveError] : []),
      ...(state.shortSaveError ? [state.shortSaveError] : []),
      ...(!state.limits || dirty
        ? ['Guarda los límites de capital real antes de confirmarlos por escrito.']
        : []),
    ]),
  ];
  const ready = !disabled && reasons.length === 0;
  const active = state.snapshot?.state.mode === 'activo';
  const suspended = state.snapshot?.state.mode === 'suspendido';
  const checklist = state.snapshot?.checklist;
  useEffect(() => {
    if (
      !state.busy &&
      (state.loading ||
        state.offline ||
        error ||
        state.saveError ||
        state.shortSaveError ||
        checklistReasons(state.snapshot).length > 0 ||
        !state.limits ||
        (dialog && liveConfirmationPhrase(dialog) !== liveConfirmationPhrase(state.limits)))
    )
      setDialog(null);
  }, [
    state.busy,
    state.loading,
    state.offline,
    error,
    state.saveError,
    state.shortSaveError,
    state.limits,
    state.snapshot,
    dialog,
  ]);
  return (
    <div
      data-layout-page="dinero-real"
      className="live-checklist-page"
      aria-busy={state.loading || state.busy}
    >
      <style>{liveTokens()}</style>
      <header data-layout-block="cabecera" className="live-page-head">
        <div>
          <h2>Dinero real</h2>
          <p>Lista de comprobación antes de usar capital real.</p>
        </div>
        <button
          className="button"
          disabled={state.busy || state.loading}
          onClick={() => void state.reload()}
        >
          Reintentar verificación
        </button>
      </header>
      <p data-layout-block="aviso" className="live-warning">
        <LiveIcon />
        Capital real en riesgo. La mayoría de los traders minoristas pierden dinero. Completa cada
        requisito y confirma límites bajos antes de activar.
      </p>
      <p
        ref={status}
        tabIndex={-1}
        data-layout-block="estado"
        className={`live-mode-status${ready ? ' live-mode-ready' : ''}`}
        role={active || suspended ? 'alert' : 'status'}
      >
        <LiveIcon />
        {active
          ? 'Dinero real activo'
          : suspended
            ? 'Dinero real suspendido · no se enviarán órdenes nuevas.'
            : ready
              ? 'Listo para confirmar · revisa los límites una última vez'
              : checklist && checklist.completedCount === checklist.total
                ? 'Lista completa · revisa los motivos antes de activar dinero real'
                : `Dinero real bloqueado${checklist ? ` · faltan ${checklist.total - checklist.completedCount} de ${checklist.total} requisitos` : ''}`}
      </p>
      {(active || suspended) && (
        <LiveDeactivationButton
          label="Volver a paper (desactivar dinero real)"
          disabled={state.busy}
          onDeactivated={state.acceptDeactivation}
        />
      )}
      {state.notice && <p role="status">{state.notice}</p>}
      {state.snapshot?.state.suspension && (
        <p data-layout-block="aviso" className="live-warning" role="alert">
          {state.snapshot.state.suspension.detail}
        </p>
      )}
      {error && (
        <p data-layout-block="aviso" className="live-warning" role="alert">
          {error}
        </p>
      )}
      {state.saveError && (
        <p data-layout-block="aviso" className="live-warning" role="alert">
          {state.saveError}
        </p>
      )}
      {state.offline && (
        <div data-layout-block="aviso" className="live-warning" role="alert">
          <p>
            Sin conexión · no se puede activar dinero real.
            {checklist?.evaluatedAt && (
              <>
                {' '}
                Última evaluación:{' '}
                <time dateTime={checklist.evaluatedAt}>{timestamp(checklist.evaluatedAt)}</time>.
              </>
            )}
          </p>
          <button className="button" disabled={state.busy} onClick={() => void state.reconnect()}>
            Reintentar conexión
          </button>
        </div>
      )}
      {state.loading && (
        <div>
          <p role="status">Comprobando requisitos en el proceso principal…</p>
          <div className="live-skeleton" aria-hidden="true">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} />
            ))}
          </div>
        </div>
      )}
      {checklist && !checklist.items.length && (
        <section data-layout-block="requisitos" className="live-sheet">
          <h3>No hay estrategias seleccionadas para dinero real</h3>
          <p>Elige primero qué estrategias podrían operar y vuelve a validar sus fichas.</p>
          {onOpenStrategies && (
            <button className="button" onClick={onOpenStrategies}>
              Revisar estrategias
            </button>
          )}
        </section>
      )}
      {checklist && checklist.items.length > 0 && (
        <section
          data-layout-block="requisitos"
          className="live-sheet"
          data-tour="dinero-real-lista"
          aria-labelledby={`${id}-checklist`}
        >
          <h3 id={`${id}-checklist`}>Requisitos previos</h3>
          <p>
            Los requisitos automáticos se verifican en el proceso principal; las declaraciones se
            guardan con fecha.
          </p>
          {checklist.evaluatedAt && (
            <p className="live-meta">
              Última evaluación:{' '}
              <time dateTime={checklist.evaluatedAt}>{timestamp(checklist.evaluatedAt)}</time>
            </p>
          )}
          <ul className="live-checklist">
            {checklist.items.map((item) => (
              <ChecklistRow
                key={item.requirement}
                item={item}
                disabled={disabled}
                stopDisabled={active || !!state.snapshot?.stopActive}
                onDeclare={state.declare}
                onTestStop={() => void state.testStop()}
                onTestAlert={() => void state.testAlert(channel)}
                channel={channel}
                onChannel={setChannel}
                onOpenValidation={onOpenValidation}
                onOpenPaper={onOpenPaper}
                onOpenAlerts={onOpenAlerts}
              />
            ))}
          </ul>
        </section>
      )}
      <ShortReadiness
        checklist={state.snapshot?.checklist}
        loading={state.loading}
        disabled={disabled || !!error || !state.snapshot}
        blocked={shortBlocked}
        savedShort={savedShort}
        onDeclare={state.declare}
        onReload={() => void state.reload()}
      />
      <div data-layout-block="limites-activacion" className="live-bottom-grid">
        <div data-layout-block="limites-confirmacion">
          <LimitsForm
            key={state.limits ? liveConfirmationPhrase(state.limits) : 'unsaved'}
            saved={state.limits}
            disabled={disabled || !!error || !state.snapshot || active}
            shortBlocked={shortBlocked}
            shortBlockReason={shortBlockReason}
            shortSaveError={state.shortSaveError}
            onSave={state.save}
            onDirty={setDirty}
            confirmed={active}
          />
          {state.limits && !dirty && (
            <p className="live-phrase">{liveConfirmationPhrase(state.limits)}</p>
          )}
        </div>
        <section
          data-layout-block="activacion"
          className="live-sheet live-activation"
          aria-labelledby={`${id}-reasons`}
          aria-live="polite"
        >
          <h3 id={`${id}-reasons`} ref={reasonsTitle} tabIndex={-1}>
            {active
              ? 'Dinero real está activo con los límites confirmados'
              : ready
                ? 'Todos los requisitos están vigentes'
                : 'No se puede activar todavía'}
          </h3>
          {reasons.length > 0 && (
            <ul id={`${id}-reasons-list`}>
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p>
            Los límites se confirman por escrito en el diálogo final. El proceso principal vuelve a
            validar todos los requisitos.
          </p>
          <button
            ref={activateButton}
            className="button live-primary"
            disabled={!ready}
            aria-describedby={reasons.length ? `${id}-reasons-list` : `${id}-reasons`}
            onClick={async () => {
              if (!ready) return;
              const canOpen = await state.prepare();
              if (canOpen && state.limits) {
                activateButton.current?.focus();
                setDialog(state.limits);
              } else reasonsTitle.current?.focus();
            }}
          >
            Activar dinero real
          </button>
        </section>
      </div>
      {dialog && state.snapshot?.state.accountMasked && (
        <LiveActivationDialog
          limits={dialog}
          account={state.snapshot.state.accountMasked}
          busy={state.busy}
          onCancel={() => setDialog(null)}
          onConfirm={async (phrase) => {
            const activated = await state.activate(phrase);
            setDialog(null);
            // The dialog cleanup restores its trigger first; then announce outcome.
            window.setTimeout(
              () => (activated ? status.current : reasonsTitle.current)?.focus(),
              0,
            );
          }}
        />
      )}
    </div>
  );
}
