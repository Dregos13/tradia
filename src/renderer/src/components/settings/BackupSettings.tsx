import { useEffect, useRef, useState } from 'react';
import {
  BACKUP_RETENTION_COUNT,
  BACKUP_SCHEDULE_HHMM,
  type BackupInfo,
} from '../../../../shared/journal';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
import { BackupSummary, backupDate } from './BackupSummary';
import { RestoreDialog } from './RestoreDialog';

export function BackupSettings() {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<'create' | 'restore' | null>(null);
  const [selected, setSelected] = useState<BackupInfo | null>(null);
  const [error, setError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const restoring = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void window.tradia.backup
      .list()
      .then((value) => {
        if (active) setBackups(value);
      })
      .catch(() => {
        if (active) setError('No se pudieron cargar las copias. Inténtalo de nuevo.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  async function create() {
    setPending('create');
    setError('');
    setMessage('');
    try {
      const created = await window.tradia.backup.create();
      setBackups((old) => [
        created,
        ...(old ?? []).filter((item) => item.fileName !== created.fileName),
      ]);
      setMessage(`Copia creada · ${backupDate(created.createdAt)}`);
      setRetry((value) => value + 1);
    } catch {
      setError('No se pudo crear la copia. Revisa el espacio disponible e inténtalo de nuevo.');
    } finally {
      setPending(null);
    }
  }
  async function restore() {
    if (!selected || restoring.current) return;
    restoring.current = true;
    setPending('restore');
    setRestoreError('');
    try {
      const result = await window.tradia.backup.restore({
        fileName: selected.fileName,
        confirm: true,
      });
      if (!result.accepted) throw new Error('Restauración rechazada');
      // Remain locked while the main process restarts the application.
    } catch {
      restoring.current = false;
      setPending(null);
      setRestoreError('No se pudo restaurar. La base actual no se ha sustituido.');
    }
  }
  return (
    <SettingsSection
      title="Copias de seguridad"
      description={`Base local, una copia diaria a las ${BACKUP_SCHEDULE_HHMM} y retención de ${BACKUP_RETENTION_COUNT}.`}
    >
      <div className="setting-row backup-header">
        <div>
          <strong>{backups ? `${backups.length} copias disponibles` : 'Copias locales'}</strong>
          <p>Destino: carpeta backups del directorio de datos de Tradia. Hora local del equipo.</p>
        </div>
        <button
          className="button primary"
          disabled={pending !== null || loading}
          onClick={() => void create()}
        >
          {pending === 'create' ? 'Creando copia…' : 'Crear copia ahora'}
        </button>
      </div>
      {loading && (
        <p className="settings-message" role="status">
          Cargando copias…
        </p>
      )}
      {backups?.length === 0 && !loading && (
        <p className="settings-message">
          Todavía no hay copias. Crea una copia para proteger la base local.
        </p>
      )}
      {backups && (
        <ul className="backup-list">
          {backups.map((backup) => (
            <li className="backup-row" key={backup.fileName}>
              <div className="backup-summary">
                <BackupSummary backup={backup} />
              </div>
              <button
                className="button"
                disabled={!backup.integrityOk || pending !== null || loading}
                aria-label={`Restaurar copia del ${backupDate(backup.createdAt)}`}
                onClick={() => {
                  setRestoreError('');
                  setSelected(backup);
                }}
              >
                Restaurar
              </button>
            </li>
          ))}
        </ul>
      )}
      <SettingsFeedback error={error} message={message} />
      {error && (
        <div className="settings-actions">
          <button
            className="button"
            disabled={pending !== null || loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            Reintentar copias
          </button>
        </div>
      )}
      {selected && (
        <RestoreDialog
          backup={selected}
          busy={pending === 'restore'}
          error={restoreError}
          onCancel={() => {
            if (!restoring.current) setSelected(null);
          }}
          onRestore={() => void restore()}
        />
      )}
    </SettingsSection>
  );
}
