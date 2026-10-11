import { useCallback, useEffect, useState } from 'react';

import type {
  DataFreshnessSummary,
  MacroRefreshResult,
  MarketRefreshResult,
} from '../../../shared/ipc';

/**
 * Franja global del estado del dato: UN solo aviso «Datos desactualizados
 * desde …» que agrega los estados de tickers, series macro y proveedores
 * (el resumen lo calcula el proceso principal en `data-status:freshness`).
 *
 * - 'unreliable'/'stale': aviso con la fecha del último dato más antiguo,
 *   el motivo y «Actualizar ahora» (refresca mercado y/o macro según lo
 *   que esté mal). Mientras dure, régimen, predicciones y señales están
 *   en pausa.
 * - 'catching-up': aviso discreto mientras corre una puesta al día.
 * - 'no-data': perfil sin datos todavía: texto neutro y acceso a Ajustes,
 *   nunca un fallo rojo.
 * - 'current': no se muestra nada.
 */

const rejections: Record<string, string> = {
  'sin-conexion': 'Sin conexión: no se pudo pedir la actualización.',
  'sin-proveedor': 'Sin proveedor configurado: añade tu clave en Ajustes.',
  'sin-activos': 'Sin activos en seguimiento: añade un ticker primero.',
  'en-curso': 'Actualización ya en curso.',
};

/** Fecha de sesión ('YYYY-MM-DD') en formato corto español. */
export function sessionDateLabel(date: string | null): string {
  if (date === null) return 'sin datos';
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

const affectedProviders = (summary: DataFreshnessSummary): { market: boolean; macro: boolean } => {
  let market = false;
  let macro = false;
  for (const item of summary.items) {
    if (item.key.startsWith('ticker:')) market = true;
    else if (item.key.startsWith('macro:')) macro = true;
    else if (item.key === 'provider:tiingo' || item.key === 'provider:simulated') market = true;
    else macro = true;
  }
  // Sin entradas malas concretas (p. ej. 'no-data'), intentar ambos.
  if (!market && !macro) return { market: true, macro: true };
  return { market, macro };
};

export function ProviderBanner() {
  const [summary, setSummary] = useState<DataFreshnessSummary | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await window.tradia.dataStatus.freshness());
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    void load();
    return window.tradia.dataStatus.onChanged(() => {
      void load();
    });
  }, [load]);

  const retry = async () => {
    if (summary === null) return;
    const { market, macro } = affectedProviders(summary);
    setRetrying(true);
    try {
      const results: string[] = [];
      const requests: Promise<MarketRefreshResult | MacroRefreshResult>[] = [];
      if (market) requests.push(window.tradia.market.refreshNow());
      if (macro) requests.push(window.tradia.macro.refreshNow());
      for (const result of await Promise.all(requests)) {
        results.push(
          result.accepted
            ? 'Actualización solicitada.'
            : (rejections[result.reason ?? ''] ??
                `No se pudo pedir la actualización (${result.reason}).`),
        );
      }
      setMessages(results);
    } finally {
      setRetrying(false);
    }
  };

  if (summary === null || summary.state === 'current') return null;

  const oldest = summary.items[0] ?? null;
  const since = sessionDateLabel(summary.sinceDate);
  const pauseNote = 'Régimen, predicciones y señales en pausa hasta ponerse al día.';
  const missing =
    summary.missingSessions > 0
      ? ` · faltan ${summary.missingSessions} ${summary.missingSessions === 1 ? 'sesión' : 'sesiones'}`
      : '';

  let title: string;
  let modifier: string;
  let showRetry = true;
  switch (summary.state) {
    case 'unreliable':
      title = `Datos no fiables desde el ${since}${missing}`;
      modifier = 'provider-banner--unreliable';
      break;
    case 'stale':
      title = `Datos desactualizados desde el ${since}${missing}`;
      modifier = 'provider-banner--stale';
      break;
    case 'catching-up':
      title = 'Poniéndose al día…';
      modifier = 'provider-banner--updating';
      showRetry = false;
      break;
    default:
      title = 'Aún no hay datos de mercado';
      modifier = 'provider-banner--no-data';
      showRetry = false;
  }

  return (
    <div className="provider-banners">
      <section className={`provider-banner ${modifier}`} aria-label="Datos del mercado">
        <div>
          <strong>{title}</strong>
          {summary.state === 'no-data' ? (
            <p>
              Añade tus claves de Tiingo y FRED en Ajustes para empezar.{' '}
              <a href="#ajustes">Abrir Ajustes</a>
            </p>
          ) : (
            <>
              {oldest?.reason ? <p>{oldest.reason}</p> : null}
              {summary.state === 'stale' || summary.state === 'unreliable' ? (
                <p>{pauseNote}</p>
              ) : null}
            </>
          )}
          {messages.map((message) => (
            <p role="status" key={message}>
              {message}
            </p>
          ))}
        </div>
        {showRetry && (
          <button className="button" disabled={retrying} onClick={() => void retry()}>
            {retrying ? 'Actualizando…' : 'Actualizar ahora'}
          </button>
        )}
      </section>
    </div>
  );
}
