/**
 * Avisos de eventos y noticias críticas en segundo plano — Fase 1b.
 *
 * `createNewsAlerts` es el núcleo, con todo lo externo inyectado (reloj,
 * `notify`, powerMonitor, preferencias): las pruebas lo montan sin Electron,
 * con reloj falso y un Notification simulado. `registerAlerts` lo cablea en
 * la app: vive en el proceso principal, así que sigue avisando con la
 * ventana cerrada y la app residente en la bandeja.
 *
 * - Aviso previo de eventos: cada evento de `calendar_events` con impacto
 *   'alto' recibe una notificación de nivel 'alerta' `leadMinutes` antes
 *   (30 por defecto; 15/30/45/60 ajustable por `alerts:get-prefs` /
 *   `alerts:set-prefs`, persistido en settings). El temporizador se arma
 *   para el próximo aviso y se reevalúa al arrancar, al reanudar el equipo,
 *   al cambiar el calendario (evento `calendar:updated`, observado en
 *   `ctx.broadcast` como hace el lector con `connectivity:changed`) y en
 *   cada pasada de rescan. Tras dormir el equipo no se avisa de eventos ya
 *   pasados: solo disparan los que siguen en el futuro.
 * - Aviso de noticias: el lector entrega los titulares de cada pasada por
 *   `poller.onItemsStored`. Prioridad 'activo' con alguna fuente que no sea
 *   de redes → 'critica' («Noticia crítica: {TICKER}»); 'maxima' confirmada
 *   → 'critica' («Alerta de mercado: Máxima prioridad»); solo fuentes de
 *   redes → como máximo 'info' con «(Sin confirmar)», jamás 'critica'.
 *   Prioridad 'media'/'baja' y 'maxima' sin confirmar no avisan.
 * - Todo sale por el servicio `notifications`, que respeta las preferencias
 *   por nivel del usuario. El clic enfoca la ventana y navega a Noticias
 *   (noticias y ráfagas) o Calendario (avisos previos).
 * - Anti-repetición: `notification_log` guarda cada aviso con clave única
 *   ('evento-previo:<id>', 'noticia-critica:<id>', 'rafaga:<instante>'), así
 *   nada se repite aunque el programador corra o la app se reinicie. La
 *   fila se escribe al emitir el aviso (también si el nivel está
 *   desactivado o el SO no soporta toasts: la prueba E2E la lee de aquí).
 * - Anti-ráfaga: más de `ALERT_BURST_MAX` (3) avisos de noticias en
 *   `ALERT_BURST_WINDOW_MS` (5 min) se consolidan en un solo resumen de
 *   nivel 'alerta'; cada noticia queda registrada igualmente (un aviso por
 *   noticia como máximo). Si ya hubo resumen en la ventana, lo nuevo queda
 *   cubierto por él y no emite nada más.
 */
import type Database from 'better-sqlite3';
import { ipcMain, powerMonitor } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isAlertPrefs,
  type AlertPrefs,
  type NewsItem,
  type NewsItemSource,
  type NotificationLevel,
  type NotificationPayload,
  type Reliability,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createNewsClock, type NewsClock, type NewsItemsStoredEvent } from './poller';
import type { WatchlistEntry } from './priority';

/** Máximo de avisos de noticias individuales en la ventana de ráfaga. */
export const ALERT_BURST_MAX = 3;
/** Ventana de la ráfaga: más de 3 avisos en 5 minutos → un solo resumen. */
export const ALERT_BURST_WINDOW_MS = 5 * 60_000;
/** Rescan de seguridad entre temporizadores exactos de aviso previo. */
export const ALERTS_RESCAN_MS = 60_000;
/** Horizonte de la agenda de avisos previos (los lejanos llegan por rescan). */
export const ALERT_EVENT_HORIZON_MS = 30 * 86_400_000;
/** Preferencias por defecto: aviso previo 30 minutos antes. */
export const DEFAULT_ALERT_PREFS: AlertPrefs = { leadMinutes: 30 };
/** Clave de settings donde se persisten las preferencias. */
export const ALERTS_PREFS_KEY = 'alerts.prefs';

// ---------------------------------------------------------------------------
// Repositorio (notification_log + lectura de calendar_events)
// ---------------------------------------------------------------------------

/** Evento de alto impacto pendiente de avisar (fila de calendar_events). */
export interface UpcomingEvent {
  id: number;
  title: string;
  dateUtc: string;
  country: string | null;
}

export type AlertLogType = 'evento-previo' | 'noticia-critica';

/** Fila a registrar en `notification_log` (clave única anti-repetición). */
export interface AlertLogRecord {
  clave: string;
  tipo: AlertLogType;
  /** calendar_events.id o news_items.id; null en el resumen de ráfaga. */
  refId: number | null;
  nivel: NotificationLevel;
  titulo: string;
  cuerpo: string;
  enviadoEn: string;
}

export interface AlertsRepository {
  /** Eventos de impacto 'alto' con fecha_utc en [desdeUtc, hastaUtc]. */
  upcomingHighImpactEvents(desdeUtc: string, hastaUtc: string): UpcomingEvent[];
  /** true si la clave ya está en el registro (el aviso no se repite). */
  wasSent(clave: string): boolean;
  /** INSERT OR IGNORE; true si la fila es nueva (primera vez que se avisa). */
  recordSent(record: AlertLogRecord): boolean;
  /** Avisos de noticias emitidos desde `desdeIso` (sin contar resúmenes). */
  newsAlertsSince(desdeIso: string): number;
  /** true si ya se emitió un resumen de ráfaga desde `desdeIso`. */
  burstSince(desdeIso: string): boolean;
}

export function createAlertsRepository(db: Database.Database): AlertsRepository {
  const upcomingStmt = db.prepare(`
    SELECT id, titulo, fecha_utc, pais
    FROM calendar_events
    WHERE impacto = 'alto' AND fecha_utc >= ? AND fecha_utc <= ?
    ORDER BY fecha_utc, id
  `);
  const wasSentStmt = db.prepare('SELECT 1 AS ok FROM notification_log WHERE clave = ?');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO notification_log (clave, tipo, ref_id, nivel, titulo, cuerpo, enviado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const newsCountStmt = db.prepare(`
    SELECT COUNT(*) AS total FROM notification_log
    WHERE clave LIKE 'noticia-critica:%' AND enviado_en >= ?
  `);
  const burstStmt = db.prepare(`
    SELECT 1 AS ok FROM notification_log
    WHERE clave LIKE 'rafaga:%' AND enviado_en >= ? LIMIT 1
  `);

  return {
    upcomingHighImpactEvents: (desdeUtc, hastaUtc) =>
      (
        upcomingStmt.all(desdeUtc, hastaUtc) as Array<{
          id: number;
          titulo: string;
          fecha_utc: string;
          pais: string | null;
        }>
      ).map((row) => ({
        id: row.id,
        title: row.titulo,
        dateUtc: row.fecha_utc,
        country: row.pais,
      })),

    wasSent: (clave) => wasSentStmt.get(clave) !== undefined,

    recordSent: (record) =>
      insertStmt.run(
        record.clave,
        record.tipo,
        record.refId,
        record.nivel,
        record.titulo,
        record.cuerpo,
        record.enviadoEn,
      ).changes > 0,

    newsAlertsSince: (desdeIso) => (newsCountStmt.get(desdeIso) as { total: number }).total,

    burstSince: (desdeIso) => burstStmt.get(desdeIso) !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Reglas de aviso (textos de la guía de diseño §7.1)
// ---------------------------------------------------------------------------

const RELIABILITY_LABEL: Record<Reliability, string> = {
  oficial: 'Oficial',
  agencia: 'Agencia',
  prensa: 'Prensa',
  redes: 'Redes',
};

/** Oficial > agencia > prensa > redes, para citar la fuente más solvente. */
const RELIABILITY_RANK: Record<Reliability, number> = {
  oficial: 0,
  agencia: 1,
  prensa: 2,
  redes: 3,
};

function bestSource(sources: readonly NewsItemSource[]): NewsItemSource | null {
  let best: NewsItemSource | null = null;
  for (const source of sources) {
    if (
      best === null ||
      RELIABILITY_RANK[source.reliability] < RELIABILITY_RANK[best.reliability]
    ) {
      best = source;
    }
  }
  return best;
}

/**
 * Ticker del titular para el texto del aviso: el primer activo relacionado
 * que además esté en la lista de seguimiento; si ninguno lo está, el
 * primero relacionado. null si el titular no lleva activos.
 */
export function alertTicker(
  item: Pick<NewsItem, 'assets'>,
  watchlist: readonly WatchlistEntry[],
): string | null {
  const watched = new Set(
    watchlist
      .map((entry) => (typeof entry === 'string' ? entry : entry.ticker).trim().toUpperCase())
      .filter(Boolean),
  );
  for (const asset of item.assets) {
    const ticker = asset.toUpperCase();
    if (watched.has(ticker)) return ticker;
  }
  return item.assets[0]?.toUpperCase() ?? null;
}

/** Aviso decidido para un titular: nivel y textos ya montados. */
export interface ItemAlert {
  level: 'info' | 'critica';
  title: string;
  body: string;
}

/**
 * Decisión de aviso de un titular según la sección 6 y la guía §7:
 * - 'activo' (activo seguido) con alguna fuente que no sea de redes →
 *   'critica' («Noticia crítica: {TICKER}», fuente y fiabilidad).
 * - 'maxima' confirmada → 'critica' («Alerta de mercado: Máxima prioridad»).
 * - solo fuentes de redes → como máximo 'info' con «(Sin confirmar)».
 * - 'media'/'baja' y 'maxima' sin confirmar → null (sin aviso).
 */
export function decideItemAlert(
  item: NewsItem,
  watchlist: readonly WatchlistEntry[],
): ItemAlert | null {
  if (item.priority !== 'maxima' && item.priority !== 'activo') return null;

  const ticker = alertTicker(item, watchlist);
  const onlyRedes =
    item.sources.length > 0 && item.sources.every((source) => source.reliability === 'redes');
  if (onlyRedes) {
    return {
      level: 'info',
      title: `Tradia · Rumor en redes${ticker !== null ? `: ${ticker}` : ''} (Sin confirmar)`,
      body: `${item.title}. [Aviso: Fuente no oficial]`,
    };
  }

  const source = bestSource(item.sources);
  const sourceName = source?.name ?? 'fuente desconocida';
  const reliability = source !== null ? RELIABILITY_LABEL[source.reliability] : null;

  if (item.priority === 'activo') {
    return {
      level: 'critica',
      title: `Tradia · Noticia crítica: ${ticker ?? 'activo'}`,
      body: `${item.title}. Fuente: ${sourceName} (${reliability ?? 'Prensa'}).`,
    };
  }

  // 'maxima': solo avisa como crítica si está confirmada por oficial/agencia.
  if (!item.confirmed) return null;
  return {
    level: 'critica',
    title: 'Tradia · Alerta de mercado: Máxima prioridad',
    body: `${item.title}. Fuente: ${sourceName} (Confirmada).`,
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

/** Mínimo de `Electron.PowerMonitor` que usa el servicio (inyectable). */
export interface AlertsPowerMonitorLike {
  on(event: 'resume', listener: () => void): unknown;
  removeListener(event: 'resume', listener: () => void): unknown;
}

export interface NewsAlertsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface NewsAlertsDeps {
  repo: AlertsRepository;
  /** Punto único de envío: `notifications.notify` (respeta preferencias). */
  notify(payload: NotificationPayload): void;
  /** Preferencias persistidas (settings 'alerts.prefs'); memoria si faltan. */
  getPrefs?: () => AlertPrefs;
  setPrefs?: (prefs: AlertPrefs) => void;
  /** Lista de seguimiento actual (ticker del aviso de noticia). */
  listWatchlist?: () => readonly WatchlistEntry[];
  /** Reloj con avance manual; habilita `advanceClock` (desarrollo/E2E). */
  clock?: NewsClock;
  /** Reloj simple (ms epoch); ignorado si hay `clock`. */
  now?: () => number;
  /** Reevalúa la agenda al volver de la suspensión. */
  powerMonitor?: AlertsPowerMonitorLike;
  rescanMs?: number;
  horizonMs?: number;
  logger?: Partial<NewsAlertsLogger>;
}

export interface NewsAlertsService {
  /**
   * Reglas de aviso sobre los titulares de una pasada del lector
   * (`poller.onItemsStored`): decide, agrupa ráfagas, notifica y registra.
   */
  handleItemsStored(event: NewsItemsStoredEvent): void;
  getPrefs(): AlertPrefs;
  /** Guarda la antelación y reprograma los avisos previos. */
  setPrefs(prefs: AlertPrefs): AlertPrefs;
  /**
   * Revisa los eventos de alto impacto: emite los avisos vencidos y arma el
   * temporizador del siguiente. Se llama al arrancar, al reanudar el
   * equipo, cuando cambia el calendario y en cada rescan.
   */
  evaluate(): void;
  /** Gancho de desarrollo: avanza el reloj y reevalúa (necesita `clock`). */
  advanceClock?(deltaMs: number): { now: string };
  start(): void;
  stop(): void;
}

/** 'HH:mm' en la zona local del usuario, con la abreviatura si la hay. */
export function formatEventTime(dateMs: number): string {
  const parts = new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(new Date(dateMs));
  const part = (type: Intl.DateTimeFormatPartTypes): string | null =>
    parts.find((p) => p.type === type)?.value ?? null;
  const hhmm = `${part('hour') ?? '00'}:${part('minute') ?? '00'}`;
  const zone = part('timeZoneName');
  return zone !== null ? `${hhmm} ${zone}` : hhmm;
}

export function createNewsAlerts(deps: NewsAlertsDeps): NewsAlertsService {
  const repo = deps.repo;
  const now = deps.clock ? deps.clock.now : (deps.now ?? (() => Date.now()));
  const listWatchlist = deps.listWatchlist ?? (() => []);
  const rescanMs = deps.rescanMs ?? ALERTS_RESCAN_MS;
  const horizonMs = deps.horizonMs ?? ALERT_EVENT_HORIZON_MS;
  const logger = deps.logger ?? console;

  let started = false;
  let timer: NodeJS.Timeout | null = null;
  let memoryPrefs: AlertPrefs = { ...DEFAULT_ALERT_PREFS };
  const getPrefs = deps.getPrefs ?? (() => ({ ...memoryPrefs }));
  const setPrefsRaw = deps.setPrefs ?? ((prefs: AlertPrefs) => (memoryPrefs = { ...prefs }));

  const isoNow = (): string => new Date(now()).toISOString();

  const emit = (payload: NotificationPayload, record: AlertLogRecord): void => {
    deps.notify(payload);
    repo.recordSent(record);
  };

  // -- Aviso previo de eventos de alto impacto --------------------------------

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** Arma el próximo despertar: el aviso que venza antes, con tope rescan. */
  const armTimer = (nextDueMs: number): void => {
    if (!started) return;
    clearTimer();
    const delayMs = Math.max(0, Math.min(nextDueMs - now(), rescanMs));
    timer = setTimeout(() => {
      timer = null;
      evaluateSafely();
    }, delayMs);
    // El temporizador no debe mantener vivo el proceso por sí solo.
    timer.unref?.();
  };

  /**
   * Una pasada sobre los eventos de alto impacto del horizonte: emite el
   * aviso previo de los que están dentro de la ventana de antelación y
   * arma el despertar para el siguiente. Los eventos ya pasados no avisan
   * (regla de la suspensión: al despertar solo interesa lo que viene).
   */
  const evaluateEvents = (): void => {
    const nowMs = now();
    const leadMs = getPrefs().leadMinutes * 60_000;
    const events = repo.upcomingHighImpactEvents(
      new Date(nowMs).toISOString(),
      new Date(nowMs + horizonMs).toISOString(),
    );
    let nextDueMs = Number.POSITIVE_INFINITY;
    for (const event of events) {
      const eventMs = Date.parse(event.dateUtc);
      if (Number.isNaN(eventMs) || eventMs <= nowMs) continue;
      const clave = `evento-previo:${event.id}`;
      if (repo.wasSent(clave)) continue;
      const notifyAtMs = eventMs - leadMs;
      if (nowMs >= notifyAtMs) {
        // La ventana ya está abierta (arranque, despertar o cambio de
        // preferencias): el evento sigue en el futuro, así que se avisa ya.
        const title = `Tradia · Evento de alto impacto en ${getPrefs().leadMinutes}m`;
        const body = `${event.title}${event.country !== null ? ` (${event.country})` : ''} a las ${formatEventTime(eventMs)}. Impacto: Alto.`;
        emit(
          { level: 'alerta', title, body, navigateTo: 'calendario' },
          {
            clave,
            tipo: 'evento-previo',
            refId: event.id,
            nivel: 'alerta',
            titulo: title,
            cuerpo: body,
            enviadoEn: isoNow(),
          },
        );
      } else {
        nextDueMs = Math.min(nextDueMs, notifyAtMs);
      }
    }
    armTimer(nextDueMs);
  };

  const evaluateSafely = (): void => {
    try {
      evaluateEvents();
    } catch (error: unknown) {
      logger.error?.(`[alerts] la pasada de avisos falló: ${String(error)}`);
      armTimer(Number.POSITIVE_INFINITY);
    }
  };

  const onResume = (): void => {
    logger.info?.('[alerts] el equipo despertó; se reevalúan los avisos previos');
    evaluateSafely();
  };

  // -- Avisos de noticias -----------------------------------------------------

  const recordItemAlert = (item: NewsItem, alert: ItemAlert): void => {
    repo.recordSent({
      clave: `noticia-critica:${item.id}`,
      tipo: 'noticia-critica',
      refId: item.id,
      nivel: alert.level,
      titulo: alert.title,
      cuerpo: alert.body,
      enviadoEn: isoNow(),
    });
  };

  const handleItemsStored = (event: NewsItemsStoredEvent): void => {
    const items = [...event.added, ...event.updated];
    if (items.length === 0) return;
    const watchlist = listWatchlist();
    const pending: Array<{ item: NewsItem; alert: ItemAlert }> = [];
    for (const item of items) {
      const alert = decideItemAlert(item, watchlist);
      if (alert === null) continue;
      if (repo.wasSent(`noticia-critica:${item.id}`)) continue;
      pending.push({ item, alert });
    }
    if (pending.length === 0) return;

    const windowStartIso = new Date(now() - ALERT_BURST_WINDOW_MS).toISOString();
    const recentCount = repo.newsAlertsSince(windowStartIso);
    if (recentCount + pending.length > ALERT_BURST_MAX) {
      // Ráfaga: un solo resumen de nivel 'alerta' (o nada si ya lo hubo en
      // la ventana); cada noticia queda registrada para no repetirse.
      if (!repo.burstSince(windowStartIso)) {
        const total = recentCount + pending.length;
        const title = `Tradia · ${total} noticias relevantes`;
        const body = `Recibidos ${total} titulares en los últimos 5 minutos.`;
        emit(
          { level: 'alerta', title, body, navigateTo: 'noticias' },
          {
            clave: `rafaga:${isoNow()}`,
            tipo: 'noticia-critica',
            refId: null,
            nivel: 'alerta',
            titulo: title,
            cuerpo: body,
            enviadoEn: isoNow(),
          },
        );
      }
      for (const { item, alert } of pending) recordItemAlert(item, alert);
      return;
    }

    for (const { item, alert } of pending) {
      emit(
        { level: alert.level, title: alert.title, body: alert.body, navigateTo: 'noticias' },
        {
          clave: `noticia-critica:${item.id}`,
          tipo: 'noticia-critica',
          refId: item.id,
          nivel: alert.level,
          titulo: alert.title,
          cuerpo: alert.body,
          enviadoEn: isoNow(),
        },
      );
    }
  };

  // -- API pública ------------------------------------------------------------

  const service: NewsAlertsService = {
    handleItemsStored,

    getPrefs: () => getPrefs(),

    setPrefs: (prefs) => {
      setPrefsRaw(prefs);
      evaluateSafely();
      return getPrefs();
    },

    evaluate: evaluateSafely,

    ...(deps.clock
      ? {
          advanceClock: (deltaMs: number): { now: string } => {
            const instant = deps.clock!.advance(deltaMs);
            logger.info?.(`[alerts] reloj adelantado ${deltaMs} ms (desarrollo)`);
            evaluateSafely();
            return { now: new Date(instant).toISOString() };
          },
        }
      : {}),

    start: () => {
      if (started) return;
      started = true;
      deps.powerMonitor?.on('resume', onResume);
      // La primera pasada cubre los avisos que vencieron con la app cerrada.
      evaluateSafely();
    },

    stop: () => {
      started = false;
      clearTimer();
      deps.powerMonitor?.removeListener('resume', onResume);
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

export function registerAlerts(ctx: ServiceContext): NewsAlertsService {
  // Sin base de datos el registro anti-repetición no puede persistir: se
  // degrada a memoria para que el resto de la app siga arrancando.
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[alerts] almacén no disponible: el registro de avisos solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createAlertsRepository(db);

  // Las preferencias viven en settings (clave 'alerts.prefs'); si settings
  // no está registrado se usa memoria (mismo patrón que notifications).
  const settings = ctx.services.settings;
  let memoryPrefs: AlertPrefs = { ...DEFAULT_ALERT_PREFS };

  const service = createNewsAlerts({
    repo,
    notify: (payload) => ctx.services.notifications?.notify(payload),
    getPrefs: () => {
      const raw = settings?.getValue(ALERTS_PREFS_KEY);
      if (raw === null || raw === undefined) return { ...memoryPrefs };
      try {
        const parsed: unknown = JSON.parse(raw);
        return isAlertPrefs(parsed) ? { ...parsed } : { ...memoryPrefs };
      } catch {
        return { ...memoryPrefs };
      }
    },
    setPrefs: (prefs) => {
      if (settings) {
        settings.setValue(ALERTS_PREFS_KEY, JSON.stringify(prefs));
      } else {
        memoryPrefs = { ...prefs };
      }
    },
    listWatchlist: () => ctx.services.market?.listWatchlist() ?? [],
    clock: createNewsClock(),
    powerMonitor,
  });

  // Los titulares de cada pasada del lector alimentan las reglas de aviso.
  ctx.services.poller?.onItemsStored((event) => service.handleItemsStored(event));

  // Reprogramar cuando el calendario se recalcula: se observa el evento
  // calendar:updated atravesando ctx.broadcast (mismo patrón que el lector
  // con connectivity:changed).
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.calendar.updated) {
      service.evaluate();
    }
  };

  // `news:advance-clock` mueve el reloj del lector; el calendario ya lo
  // encadenó al suyo envolviendo poller.advanceClock, así que se encadena
  // una vez más para que los avisos avancen al mismo paso en las pruebas.
  const poller = ctx.services.poller;
  if (poller?.advanceClock) {
    const advancePrev = poller.advanceClock.bind(poller);
    poller.advanceClock = (deltaMs) => {
      const result = advancePrev(deltaMs);
      service.advanceClock?.(deltaMs);
      return result;
    };
  }

  ipcMain.handle(IPC_CHANNELS.alerts.getPrefs, () => service.getPrefs());
  ipcMain.handle(IPC_CHANNELS.alerts.setPrefs, (_event, next: unknown) => {
    if (!isAlertPrefs(next)) {
      throw new IpcValidationError(
        IPC_CHANNELS.alerts.setPrefs,
        'preferencias de avisos inválidas',
      );
    }
    return service.setPrefs(next);
  });

  service.start();
  return service;
}
