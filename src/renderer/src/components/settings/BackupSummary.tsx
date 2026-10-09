import type { BackupInfo } from '../../../../shared/journal';

export function backupDate(date: string) {
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(date),
  );
}
export function BackupSummary({ backup }: { backup: BackupInfo }) {
  const size = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(
    backup.sizeBytes / (1024 * 1024),
  );
  return (
    <>
      <time dateTime={backup.createdAt}>{backupDate(backup.createdAt)} (hora local)</time>
      <span className="operational-data">
        {size} MB · Esquema {backup.schemaVersion}
      </span>
      <span className={backup.integrityOk ? 'online' : 'error'}>
        {backup.integrityOk ? 'Integridad verificada' : 'Integridad no verificada'}
      </span>
    </>
  );
}
