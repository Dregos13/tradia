import { LIVE_FIXED_SHORT_CAPS } from '../../../../shared/live';
import { useLiveState } from '../live/useLiveState';
import { usd } from '../live/presentation';

/** Solo los límites confirmados habilitan el corto; cada orden conserva su guarda. */
export function LiveShortStatus() {
  const { state, loading, error, reload } = useLiveState();
  if (error)
    return (
      <p role="alert">
        No se pudo comprobar si el corto con dinero real está permitido.{' '}
        <button onClick={() => void reload()}>Reintentar estado del corto</button>
      </p>
    );
  if (loading || !state) return <p role="status">Comprobando límites del corto…</p>;
  const limits = state.limits;
  const enabled =
    limits && limits.shortOrderUsd > 0 && limits.shortExposureUsd > 0 && limits.shortPositions > 0;
  return (
    <div aria-live="polite">
      <p>
        {enabled
          ? `Corto con dinero real permitido por los límites confirmados: ${usd(limits.shortOrderUsd)} por orden, ${usd(limits.shortExposureUsd)} de exposición total y ${limits.shortPositions} posición en corto.`
          : 'Corto con dinero real desactivado: límites a 0 o pendientes de confirmación.'}
      </p>
      <p>
        Cada entrada pasa por el motor de riesgo y exige dinero real activo, una cuenta con margen y
        corto habilitado en Alpaca, un título prestable y un stop obligatorio como máximo al{' '}
        {LIVE_FIXED_SHORT_CAPS.shortMaxStopPct} % por encima de la entrada.
      </p>
      <a href="#dinero-real">Revisar y confirmar límites del corto</a>
    </div>
  );
}
