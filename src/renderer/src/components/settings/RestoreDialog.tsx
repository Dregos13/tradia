import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { BackupInfo } from '../../../../shared/journal';
import tokens from '../../design/dashboard.tokens.json';
import { SettingsFeedback } from './SettingsSection';
import { BackupSummary } from './BackupSummary';

export function RestoreDialog({
  backup,
  busy,
  error,
  onCancel,
  onRestore,
}: {
  backup: BackupInfo;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onRestore: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    // Keep the rest of the renderer out of the keyboard and accessibility tree.
    const root = document.getElementById('root');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    return () => {
      if (root) root.inert = wasInert;
      trigger?.focus();
    };
  }, []);
  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy]);
  return createPortal(
    <div className="settings-modal-backdrop">
      <style>{`.settings-restore-dialog{--settings-dialog-max:${tokens.size.dialogMax};}`}</style>
      <div
        className="settings-restore-dialog"
        ref={dialog}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="restore-title"
        aria-describedby="restore-description"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!busy) onCancel();
          }
          if (event.key === 'Tab') {
            const controls =
              dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (!controls?.length) {
              event.preventDefault();
              return;
            }
            const first = controls[0];
            const last = controls[controls.length - 1];
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
        <h2 id="restore-title">Restaurar esta copia</h2>
        <p id="restore-description">
          Tradia guardará primero una copia del estado actual, sustituirá la base local y se
          reiniciará. Los cambios posteriores a esta copia dejarán de estar activos.
        </p>
        <div className="backup-summary">
          <BackupSummary backup={backup} />
        </div>
        <SettingsFeedback error={error} />
        {busy && <p role="status">Restaurando copia… Tradia se reiniciará.</p>}
        <div className="settings-actions">
          <button ref={cancel} className="button" disabled={busy} onClick={onCancel}>
            Cancelar
          </button>
          <button className="button danger" disabled={busy} onClick={onRestore}>
            Restaurar y reiniciar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
