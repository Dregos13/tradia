import type { CautionState } from '../../../../shared/risk';
export function CautionBanner({ caution }: { caution?: CautionState }) {
  if (!caution?.active) return null;
  return (
    <div className="risk-caution" role="status">
      <strong>Modo cautela activo</strong>
      <p>
        {caution.eventTitle ?? caution.cause} ·{' '}
        {caution.effect === 'bloquear'
          ? 'Entradas bloqueadas'
          : `Tamaño × ${caution.sizeFactor.toLocaleString('es-ES')}`}
      </p>
      {caution.until && (
        <p>
          Hasta{' '}
          <time dateTime={caution.until}>
            {new Date(caution.until).toLocaleString('es-ES', { timeZoneName: 'short' })}
          </time>
        </p>
      )}
    </div>
  );
}
