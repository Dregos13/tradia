import { useEffect, useRef, useState } from 'react';
import { sessionDateLabel } from '../../../shared/dates';
import type {
  DataFreshnessSummary,
  MacroRefreshResult,
  MarketRefreshResult,
} from '../../../shared/ipc';
import './dataFreshness.css';
import { DataStateIcon } from './DataStateIcon';
import { dataStateTokenStylesheet } from './dataStateTokens';
import { useDataFreshness } from '../hooks/useDataFreshness';
import { UncoveredAssets } from './UncoveredAssets';
import { assetSymbol, FX_CALENDAR_HELP } from './assetPresentation';
import { isFxSymbol } from '../../../shared/fxTrading';

export { sessionDateLabel } from '../../../shared/dates';

export function freshnessTitle(
  summary: Pick<DataFreshnessSummary, 'state' | 'sinceDate'>,
  {
    offline = false,
    snapshotSessionDate,
  }: { offline?: boolean; snapshotSessionDate?: string } = {},
): string {
  if (offline && !summary.sinceDate)
    return `Sin conexión${snapshotSessionDate ? ` · datos del ${sessionDateLabel(snapshotSessionDate)}` : ' · última instantánea local conservada'}. No se pudo comprobar si hay datos más recientes.`;
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
// Con la última vela por detrás de la sesión esperada, el motor no evalúa señales, no crea
// predicciones y no recalcula el régimen de ese activo (guardas de frescura de
// signals/engine, ai/prediction/service y ai/regime/service). Lo ya emitido se conserva.
// Con datos «no fiables» el motor no pausa nada por sí mismo, así que no se afirma.
export const STALE_PAUSE_TEXT =
  'Mientras los datos estén atrasados no se calculan régimen, predicciones ni señales nuevas para esos activos. Lo ya calculado se conserva.';
export function providerSettingsLink(provider: 'tiingo' | 'fred', focus: 'key' | 'test' = 'test') {
  return `#ajustes?provider=${provider}&focus=${focus}`;
}
export function refreshResultMessage(
  result: MarketRefreshResult | MacroRefreshResult,
  summary?: DataFreshnessSummary,
): string {
  const failed = 'failedTickers' in result ? (result.failedTickers ?? []) : [];
  const counts =
    'updated' in result && result.updated !== undefined && result.total !== undefined
      ? `Actualizados ${result.updated} de ${result.total}`
      : 'Actualización parcial';
  if (failed.length) return `${counts} · sin datos: ${failed.join(', ')}`;
  if (
    'updated' in result &&
    result.updated !== undefined &&
    result.total !== undefined &&
    result.updated < result.total
  )
    return `${counts} · quedan activos pendientes.`;
  if (
    result.ok === true &&
    summary &&
    (summary.uncovered.length || summary.items.length || summary.state !== 'current')
  ) {
    const uncovered = summary.uncovered.map((asset) => asset.ticker);
    const pending = summary.items
      .filter((item) => item.key.startsWith('ticker:'))
      .map((item) => assetSymbol(item.key.slice(7)));
    return uncovered.length
      ? `${counts} · sin datos: ${uncovered.join(', ')}${pending.length ? ` · pendientes: ${pending.join(', ')}` : ''}`
      : pending.length
        ? `${counts} · pendientes: ${pending.join(', ')}`
        : 'Actualización recibida. Quedan datos pendientes de verificar.';
  }
  if (result.ok === false)
    return `No se pudo actualizar: ${result.detail ?? 'el proveedor no pudo completar la descarga.'}`;
  if (result.accepted)
    return result.ok === true && summary
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
type DataFreshnessProps = {
  variant?: 'banner' | 'inline';
  offline?: boolean;
  snapshotSessionDate?: string;
  snapshotStale?: boolean;
  /** Marca el contenedor como bloque medible de la página (`data-layout-block`). */
  layoutBlock?: string;
};

const onlyUncovered = (summary: DataFreshnessSummary | null) =>
  !!summary &&
  (summary.state === 'current' || summary.state === 'no-data') &&
  summary.uncovered.length > 0;

export function DataFreshness(props: DataFreshnessProps) {
  const focusTarget = useRef<HTMLDivElement>(null);
  const [actionMessage, setActionMessage] = useState('');
  const { summary } = useDataFreshness();
  // El aviso por activo vive solo en la franja global: repetirlo en cada pantalla duplicaría
  // la región, sus botones y el anuncio del lector de pantalla.
  if ((props.variant ?? 'inline') === 'inline' && onlyUncovered(summary)) return null;
  return (
    <div
      className="data-freshness-container"
      data-layout-block={props.layoutBlock}
      ref={focusTarget}
      tabIndex={-1}
      role="group"
      aria-label="Avisos de datos"
    >
      <style>{dataStateTokenStylesheet()}</style>
      <DataFreshnessContent
        {...props}
        onActionCompleted={(message) => {
          setActionMessage(message);
          focusTarget.current?.focus();
        }}
      />
      {props.variant === 'banner' && (
        <p className="data-freshness-action-result" role="status">
          {actionMessage}
        </p>
      )}
    </div>
  );
}

function DataFreshnessContent({
  variant = 'inline',
  offline = false,
  snapshotSessionDate,
  snapshotStale = false,
  onActionCompleted,
}: DataFreshnessProps & { onActionCompleted: (message: string) => void }) {
  const { summary: storedSummary, error, reload } = useDataFreshness();
  const summary =
    storedSummary?.state === 'current' && snapshotStale
      ? { ...storedSummary, state: 'stale' as const, sinceDate: snapshotSessionDate ?? null }
      : storedSummary;
  const complete = summary?.state === 'current' && summary.uncovered.length === 0;
  const incident = JSON.stringify([
    summary?.state,
    summary?.sinceDate,
    summary?.items,
    summary?.uncovered,
    offline,
  ]);
  const attempt = useRef(0);
  const refreshing = useRef(false);
  useEffect(() => {
    // Intermediate download events belong to this refresh, not a new incident.
    if (!refreshing.current || complete || offline) {
      attempt.current++;
      setMessages([]);
    }
  }, [incident, complete, offline]);
  const [messages, setMessages] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);
  const ready = summary !== null;
  const previous = useRef<boolean | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!offline && complete && previous.current === false) setAnnouncement('Datos al día.');
    else setAnnouncement('');
    if (ready) previous.current = complete;
  }, [complete, ready, offline]);
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
              ? refreshResultMessage(result.value, summary)
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
  if (complete && offline)
    return <p role="status">{freshnessTitle(summary, { offline, snapshotSessionDate })}</p>;
  if (complete)
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
  const uncoveredOnly = onlyUncovered(summary);
  const oldest = summary.items[0];
  const staleAssets = summary.items
    .filter((item) => item.key.startsWith('ticker:') && item.state === 'desactualizado')
    .map((item) => assetSymbol(item.key.slice(7)));
  const sentence = (text: string) => text.charAt(0).toLocaleUpperCase('es') + text.slice(1);
  const paused = summary.state === 'stale' || summary.state === 'unreliable';
  const provider =
    oldest?.key.startsWith('macro:') || oldest?.key.includes('fred') ? 'fred' : 'tiingo';
  const title = freshnessTitle(summary, { offline, snapshotSessionDate });
  const fxTicker = (key: string) => key.startsWith('ticker:') && isFxSymbol(key.slice(7));
  const fxAffected = summary.items.some((item) => fxTicker(item.key));
  const modifier = uncoveredOnly
    ? 'uncovered'
    : summary.state === 'unreliable'
      ? 'unreliable'
      : summary.state === 'stale'
        ? 'stale'
        : summary.state === 'catching-up'
          ? 'updating'
          : 'no-data';
  // La franja global (ProviderBanner) está en todas las pantallas y lleva el motivo, «Por qué
  // ocurre» y las acciones. Aquí basta un chip con el título: repetirlo todo duplicaría los
  // botones en el orden de Tab y el anuncio del lector de pantalla.
  if (variant === 'inline')
    return (
      <section
        className={`provider-banner provider-banner--${modifier} data-freshness-inline`}
        role="group"
        aria-label="Frescura de datos"
      >
        <strong>
          <DataStateIcon kind={paused ? 'warning' : 'pending'} />
          {title}
        </strong>
      </section>
    );
  return (
    <section
      className={`provider-banner provider-banner--${modifier} data-freshness-${variant}`}
      role={variant === 'banner' ? 'region' : 'group'}
      aria-label={variant === 'banner' ? 'Estado de los datos' : 'Frescura de datos'}
    >
      <div className="data-freshness-content">
        {!uncoveredOnly && (
          <div role="status">
            <strong>
              <DataStateIcon kind={paused ? 'warning' : 'pending'} />
              {title}
            </strong>
            {summary.state === 'stale' && staleAssets.length > 0 && (
              <p>Faltan datos recientes de {staleAssets.join(', ')}.</p>
            )}
            {paused && (
              <p>
                {sentence(
                  oldest?.reason ??
                    `Faltan ${summary.missingSessions} sesiones: la última esperada es la del ${sessionDateLabel(summary.expectedSessionDate)}.`,
                )}
              </p>
            )}
            {summary.state === 'stale' && <p>{STALE_PAUSE_TEXT}</p>}
            {fxAffected && <p className="data-freshness-fx">{FX_CALENDAR_HELP}</p>}
            {summary.state === 'catching-up' && (
              <p>
                {summary.progress
                  ? `Descargando ${summary.progress.done} de ${summary.progress.total} activos.`
                  : 'Poniéndose al día…'}{' '}
                Régimen, predicciones y señales siguen con el último dato fiable; un activo vuelve a
                emitir señal cuando su última vela está al día.
              </p>
            )}
            {summary.state === 'no-data' && (
              <p>Sin configurar · añade tus claves de Tiingo y FRED para empezar.</p>
            )}
            {error && <p>No se pudo comprobar si hay datos más recientes.</p>}
          </div>
        )}
        {!uncoveredOnly && (
          <details>
            <summary>Por qué ocurre</summary>
            <ul>
              {summary.items.map((item) => (
                <li key={item.key}>
                  {fxTicker(item.key)
                    ? `${assetSymbol(item.key.slice(7))} · divisa 24/5`
                    : item.label}{' '}
                  · último dato{' '}
                  <time dateTime={item.lastDataDate ?? undefined}>
                    {sessionDateLabel(item.lastDataDate)}
                  </time>{' '}
                  · {sentence(item.reason ?? 'Sin motivo registrado')}
                </li>
              ))}
            </ul>
          </details>
        )}
        {summary.uncovered.length > 0 && variant === 'banner' && (
          <UncoveredAssets
            assets={summary.uncovered}
            current={summary.state === 'current' && !offline}
            offline={offline}
            reload={reload}
            onActionCompleted={onActionCompleted}
          />
        )}
        {uncoveredOnly && error && (
          <p role="status">No se pudo comprobar si hay datos más recientes.</p>
        )}
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
        {summary.state === 'no-data' && !uncoveredOnly && (
          <a className="button" href={providerSettingsLink('tiingo', 'key')}>
            Ir a Ajustes
          </a>
        )}
      </div>
    </section>
  );
}
