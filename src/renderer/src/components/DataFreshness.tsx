import { useEffect, useRef, useState } from 'react';
import type {
  DataFreshnessSummary,
  MacroRefreshResult,
  MarketRefreshResult,
} from '../../../shared/ipc';
import './dataFreshness.css';
import { DataStateIcon } from './DataStateIcon';
import { dataStateTokenStylesheet } from './dataStateTokens';
import { useDataFreshness } from '../hooks/useDataFreshness';

export function sessionDateLabel(date: string | null): string {
  if (date === null) return 'sin datos';
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('es-ES', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
}
export function freshnessTitle(summary: Pick<DataFreshnessSummary, 'state' | 'sinceDate'>): string {
  return summary.state === 'stale'
    ? summary.sinceDate
      ? `Datos desactualizados desde el ${sessionDateLabel(summary.sinceDate)}`
      : 'Datos desactualizados · fecha del último dato no disponible'
    : summary.state === 'unreliable'
      ? summary.sinceDate
        ? `Datos no fiables desde el ${sessionDateLabel(summary.sinceDate)}`
        : 'Datos no fiables · fecha del último dato no disponible'
      : summary.state === 'catching-up'
        ? 'Poniéndose al día…'
        : 'Aún no hay datos de mercado';
}
export function providerSettingsLink(provider: 'tiingo' | 'fred', focus: 'key' | 'test' = 'test') {
  return `#ajustes?provider=${provider}&focus=${focus}`;
}
export function refreshResultMessage(result: MarketRefreshResult | MacroRefreshResult): string {
  if (result.ok === false)
    return `No se pudo actualizar: ${result.detail ?? 'el proveedor no pudo completar la descarga.'}`;
  if (result.accepted)
    return result.ok === true
      ? 'Datos actualizados.'
      : 'Actualización solicitada. Esperando datos verificados.';
  const reasons: Record<string, string> = {
    'sin-conexion': 'Sin conexión: no se pudo pedir la actualización.',
    'sin-proveedor': 'Sin proveedor configurado: añade tu clave en Ajustes.',
    'sin-activos': 'Sin activos en seguimiento: añade un ticker primero.',
    'en-curso': 'Actualización ya en curso.',
  };
  return reasons[result.reason ?? ''] ?? 'No pudimos iniciar la actualización. Inténtalo de nuevo.';
}
export function affectedProviders(summary: DataFreshnessSummary) {
  const market = summary.items.some(
    (item) =>
      item.key.startsWith('ticker:') ||
      item.key === 'provider:tiingo' ||
      item.key === 'provider:simulated',
  );
  const macro = summary.items.some(
    (item) =>
      item.key.startsWith('macro:') ||
      item.key === 'provider:fred' ||
      item.key === 'provider:macro-simulated',
  );
  return market || macro ? { market, macro } : { market: true, macro: true };
}
export function DataFreshness({
  variant = 'inline',
  offline = false,
  snapshotSessionDate,
  snapshotStale = false,
}: {
  variant?: 'banner' | 'inline';
  offline?: boolean;
  snapshotSessionDate?: string;
  snapshotStale?: boolean;
}) {
  const { summary: storedSummary, error, reload } = useDataFreshness();
  const summary =
    storedSummary?.state === 'current' && snapshotStale
      ? { ...storedSummary, state: 'stale' as const, sinceDate: snapshotSessionDate ?? null }
      : storedSummary;
  const incident = JSON.stringify([summary?.state, summary?.sinceDate, summary?.items, offline]);
  const attempt = useRef(0);
  const refreshing = useRef(false);
  useEffect(() => {
    // Intermediate download events belong to this refresh, not a new incident.
    if (!refreshing.current || summary?.state === 'current' || offline) {
      attempt.current++;
      setMessages([]);
    }
  }, [incident, summary?.state, offline]);
  const [messages, setMessages] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);
  const previous = useRef(summary?.state);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (
      !offline &&
      summary?.state === 'current' &&
      previous.current &&
      previous.current !== 'current'
    )
      setAnnouncement('Datos al día.');
    else setAnnouncement('');
    previous.current = summary?.state;
  }, [summary?.state, offline]);
  const retry = async () => {
    if (!summary || refreshing.current) return;
    refreshing.current = true;
    const providers = affectedProviders(summary);
    const request = ++attempt.current;
    setRetrying(true);
    setMessages([]);
    const requests: Promise<MarketRefreshResult | MacroRefreshResult>[] = [];
    if (providers.market) requests.push(window.tradia.market.refreshNow());
    if (providers.macro) requests.push(window.tradia.macro.refreshNow());
    try {
      const results = await Promise.allSettled(requests);
      if (request === attempt.current)
        setMessages(
          results.map((result) =>
            result.status === 'fulfilled'
              ? refreshResultMessage(result.value)
              : 'No pudimos iniciar la actualización. Inténtalo de nuevo.',
          ),
        );
      await reload();
    } finally {
      refreshing.current = false;
      setRetrying(false);
    }
  };
  if (!summary)
    return (
      <p role="status">
        {error
          ? 'No se pudo comprobar la frescura de los datos.'
          : 'Comprobando frescura de los datos…'}
        {error && (
          <button className="button" onClick={() => void reload()}>
            Reintentar
          </button>
        )}
      </p>
    );
  if (summary.state === 'current' && offline)
    return (
      <p role="status">
        Sin conexión
        {snapshotSessionDate
          ? ` · datos del ${sessionDateLabel(snapshotSessionDate)}`
          : ' · última instantánea local conservada'}
        . No se pudo comprobar si hay datos más recientes.
      </p>
    );
  if (summary.state === 'current')
    return variant === 'banner' ? (
      <p className="sr-only" role="status">
        {announcement}
      </p>
    ) : (
      <span className="data-freshness-current">
        Al día
        {summary.expectedSessionDate
          ? ` · cierre del ${sessionDateLabel(summary.expectedSessionDate)}`
          : ''}
      </span>
    );
  const oldest = summary.items[0];
  const paused = summary.state === 'stale' || summary.state === 'unreliable';
  const provider =
    oldest?.key.startsWith('macro:') || oldest?.key.includes('fred') ? 'fred' : 'tiingo';
  const title = freshnessTitle(summary);
  const modifier =
    summary.state === 'unreliable'
      ? 'unreliable'
      : summary.state === 'stale'
        ? 'stale'
        : summary.state === 'catching-up'
          ? 'updating'
          : 'no-data';
  return (
    <section
      className={`provider-banner provider-banner--${modifier} data-freshness-${variant}`}
      role={variant === 'banner' ? 'region' : 'group'}
      aria-label={variant === 'banner' ? 'Estado de los datos' : 'Frescura de datos'}
    >
      <div>
        <div role="status">
          <style>{dataStateTokenStylesheet()}</style>
          <strong>
            <DataStateIcon kind={paused ? 'warning' : 'pending'} />
            {title}
          </strong>
          {paused && (
            <p>
              {oldest?.reason ??
                `Faltan ${summary.missingSessions} sesiones: la última esperada es la del ${sessionDateLabel(summary.expectedSessionDate)}.`}
            </p>
          )}
          {paused && <p>Régimen, predicciones y señales en pausa hasta ponerse al día.</p>}
          {summary.state === 'catching-up' && (
            <p>
              {summary.progress
                ? `Descargando ${summary.progress.done} de ${summary.progress.total} activos.`
                : 'Poniéndose al día…'}{' '}
              Régimen, predicciones y señales esperan a terminar.
            </p>
          )}
          {summary.state === 'no-data' && (
            <p>Sin configurar · añade tus claves de Tiingo y FRED para empezar.</p>
          )}
          {error && <p>No se pudo comprobar si hay datos más recientes.</p>}
        </div>
        <details>
          <summary>Ver detalles</summary>
          <ul>
            {summary.items.map((item) => (
              <li key={item.key}>
                {item.label} · último dato{' '}
                <time dateTime={item.lastDataDate ?? undefined}>
                  {sessionDateLabel(item.lastDataDate)}
                </time>{' '}
                · {item.reason ?? 'Sin motivo registrado'}
              </li>
            ))}
          </ul>
        </details>
        {messages.map((message, index) => (
          <p role="status" key={index}>
            {message}
          </p>
        ))}
      </div>
      <div className="data-freshness-actions">
        {paused && !offline && (
          <>
            <button
              className="button primary"
              disabled={retrying}
              aria-disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? 'Actualizando…' : 'Actualizar ahora'}
            </button>
            <a className="button" href={providerSettingsLink(provider)}>
              Probar conexión
            </a>
          </>
        )}
        {summary.state === 'no-data' && (
          <a className="button" href={providerSettingsLink('tiingo', 'key')}>
            Ir a Ajustes
          </a>
        )}
      </div>
    </section>
  );
}
