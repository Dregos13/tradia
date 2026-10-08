import type { NotificationConstructorOptions } from 'electron';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  IpcValidationError,
  type AlertPrefs,
  type NewsItem,
  type NewsItemSource,
  type NotificationPrefs,
  type Reliability,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createNotificationsService, type NotificationLike } from '../services/notifications';
import { createSettingsService } from '../services/settings';
import {
  ALERT_BURST_MAX,
  ALERT_BURST_WINDOW_MS,
  alertTicker,
  createAlertsRepository,
  createNewsAlerts,
  decideItemAlert,
  registerAlerts,
  type AlertsPowerMonitorLike,
  type NewsAlertsDeps,
} from './alerts';
import { createNewsClock } from './poller';

// electron solo aporta ipcMain/app/powerMonitor; se captura el mapa de handlers.
const env = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  isPackaged: true,
  powerListeners: new Set<() => void>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      env.handlers.set(channel, handler),
  },
  app: {
    get isPackaged() {
      return env.isPackaged;
    },
  },
  powerMonitor: {
    on: (_event: 'resume', listener: () => void) => env.powerListeners.add(listener),
    removeListener: (_event: 'resume', listener: () => void) => env.powerListeners.delete(listener),
  },
}));

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z'); // jueves
const MINUTE = 60_000;

const dbs: Database.Database[] = [];
const db = (): Database.Database => {
  const instance = openDatabase(':memory:');
  dbs.push(instance);
  return instance;
};

/** Notification de Electron simulada (mismo patrón que notifications.test.ts). */
class FakeNotification implements NotificationLike {
  static instances: FakeNotification[] = [];
  static supported = true;

  readonly options: NotificationConstructorOptions;
  shown = false;
  private clickListeners: Array<() => void> = [];

  constructor(options: NotificationConstructorOptions) {
    this.options = options;
    FakeNotification.instances.push(this);
  }

  static isSupported(): boolean {
    return FakeNotification.supported;
  }

  show(): void {
    this.shown = true;
  }

  close(): void {
    this.shown = false;
  }

  on(event: 'click', listener: () => void): this {
    if (event === 'click') this.clickListeners.push(listener);
    return this;
  }

  emitClick(): void {
    for (const listener of this.clickListeners) listener();
  }
}

const ALL_ON: NotificationPrefs = { info: true, alerta: true, critica: true };

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

const source = (id: number, reliability: Reliability, name = `Fuente ${id}`): NewsItemSource => ({
  id,
  name,
  reliability,
});

let nextItemId = 1;
const item = (overrides: Partial<NewsItem>): NewsItem => ({
  id: nextItemId++,
  title: 'Titular de prueba',
  url: 'https://example.com/n',
  publishedAt: new Date(FIXED_NOW).toISOString(),
  summary: null,
  priority: 'baja',
  confirmed: false,
  sources: [source(1, 'prensa')],
  assets: [],
  ...overrides,
});

interface FakePowerMonitor extends AlertsPowerMonitorLike {
  emitResume(): void;
  listeners: Set<() => void>;
}

const fakePowerMonitor = (): FakePowerMonitor => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    on: (_event, listener) => listeners.add(listener),
    removeListener: (_event, listener) => listeners.delete(listener),
    emitResume: () => listeners.forEach((listener) => listener()),
  };
};

const insertEvent = (
  database: Database.Database,
  event: {
    tipo?: string;
    titulo: string;
    fechaUtc: string;
    impacto?: string;
    pais?: string | null;
    clave: string;
  },
): number => {
  const result = database
    .prepare(
      `INSERT INTO calendar_events (tipo, titulo, fecha_utc, impacto, pais, activo, origen, clave)
       VALUES (?, ?, ?, ?, ?, NULL, 'oficial', ?)`,
    )
    .run(
      event.tipo ?? 'fomc',
      event.titulo,
      event.fechaUtc,
      event.impacto ?? 'alto',
      event.pais === undefined ? 'US' : event.pais,
      event.clave,
    );
  return Number(result.lastInsertRowid);
};

const logRows = (database: Database.Database) =>
  database
    .prepare('SELECT clave, tipo, ref_id, nivel, titulo, cuerpo FROM notification_log ORDER BY id')
    .all() as Array<{
    clave: string;
    tipo: string;
    ref_id: number | null;
    nivel: string;
    titulo: string;
    cuerpo: string;
  }>;

/** Servicio real de notificaciones con Notification simulado y prefs en memoria. */
const realNotifications = (prefs: { current: NotificationPrefs } = { current: { ...ALL_ON } }) => {
  const focused: string[] = [];
  const navigated: string[] = [];
  const service = createNotificationsService({
    Notification: FakeNotification,
    getPrefs: () => prefs.current,
    setPrefs: (next) => {
      prefs.current = { ...next };
    },
    focusMainWindow: () => focused.push('focus'),
    onNavigate: (route) => navigated.push(route),
    platform: 'darwin',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { service, focused, navigated, prefs };
};

const makeService = (
  database: Database.Database,
  overrides: Partial<NewsAlertsDeps> = {},
): {
  service: ReturnType<typeof createNewsAlerts>;
  notify: ReturnType<typeof vi.fn>;
  power: FakePowerMonitor;
} => {
  const notify = vi.fn();
  const power = fakePowerMonitor();
  const service = createNewsAlerts({
    repo: createAlertsRepository(database),
    notify,
    clock: createNewsClock(() => Date.now()),
    powerMonitor: power,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  });
  return { service, notify, power };
};

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  env.handlers.clear();
  env.isPackaged = true;
  env.powerListeners.clear();
  FakeNotification.instances = [];
  FakeNotification.supported = true;
  nextItemId = 1;
});

afterEach(() => {
  vi.useRealTimers();
  for (const instance of dbs.splice(0)) instance.close();
});

describe('decideItemAlert (reglas de la sección 6)', () => {
  it('activo con fuente no redes → critica «Noticia crítica: {TICKER}»', () => {
    const news = item({
      priority: 'activo',
      confirmed: true,
      assets: ['AAPL', 'MSFT'],
      sources: [source(1, 'agencia', 'Reuters')],
    });
    const alert = decideItemAlert(news, ['AAPL']);
    expect(alert).not.toBeNull();
    expect(alert!.level).toBe('critica');
    expect(alert!.title).toBe('Tradia · Noticia crítica: AAPL');
    expect(alert!.body).toBe('Titular de prueba. Fuente: Reuters (Agencia).');
  });

  it('máxima confirmada → critica «Alerta de mercado: Máxima prioridad»', () => {
    const news = item({
      priority: 'maxima',
      confirmed: true,
      title: 'La Fed recorta tipos 25 puntos básicos',
      sources: [source(1, 'oficial', 'Fed · comunicados')],
    });
    const alert = decideItemAlert(news, []);
    expect(alert!.level).toBe('critica');
    expect(alert!.title).toBe('Tradia · Alerta de mercado: Máxima prioridad');
    expect(alert!.body).toBe(
      'La Fed recorta tipos 25 puntos básicos. Fuente: Fed · comunicados (Confirmada).',
    );
  });

  it('solo fuentes de redes → como máximo info «(Sin confirmar)», jamás critica', () => {
    const news = item({
      priority: 'activo',
      confirmed: false,
      assets: ['TSLA'],
      sources: [source(1, 'redes'), source(2, 'redes')],
    });
    const alert = decideItemAlert(news, ['TSLA']);
    expect(alert!.level).toBe('info');
    expect(alert!.title).toBe('Tradia · Rumor en redes: TSLA (Sin confirmar)');
    expect(alert!.body).toBe('Titular de prueba. [Aviso: Fuente no oficial]');
  });

  it('máxima solo de redes tampoco sube de info', () => {
    const news = item({
      priority: 'maxima',
      confirmed: false,
      sources: [source(1, 'redes')],
    });
    const alert = decideItemAlert(news, []);
    expect(alert!.level).toBe('info');
    expect(alert!.title).toBe('Tradia · Rumor en redes (Sin confirmar)');
  });

  it('máxima sin confirmar por prensa → sin aviso', () => {
    const news = item({ priority: 'maxima', confirmed: false, sources: [source(1, 'prensa')] });
    expect(decideItemAlert(news, [])).toBeNull();
  });

  it('media y baja → sin aviso', () => {
    expect(
      decideItemAlert(item({ priority: 'media', sources: [source(1, 'agencia')] }), []),
    ).toBeNull();
    expect(
      decideItemAlert(item({ priority: 'baja', sources: [source(1, 'oficial')] }), []),
    ).toBeNull();
  });

  it('cita la fuente más solvente y el ticker seguido', () => {
    const news = item({
      priority: 'activo',
      assets: ['AAPL'],
      sources: [source(1, 'redes'), source(2, 'oficial', 'SEC EDGAR')],
    });
    const alert = decideItemAlert(news, ['AAPL']);
    expect(alert!.level).toBe('critica');
    expect(alert!.body).toContain('Fuente: SEC EDGAR (Oficial)');
  });

  it('alertTicker prefiere el activo seguido', () => {
    expect(alertTicker({ assets: ['XOM', 'AAPL'] }, [{ ticker: 'aapl' }])).toBe('AAPL');
    expect(alertTicker({ assets: ['XOM'] }, ['AAPL'])).toBe('XOM');
    expect(alertTicker({ assets: [] }, ['AAPL'])).toBeNull();
  });
});

describe('aviso previo de eventos de alto impacto', () => {
  it('avisa en nivel alerta 30 min antes y registra evento-previo', () => {
    const database = db();
    const eventMs = FIXED_NOW + 45 * MINUTE;
    const id = insertEvent(database, {
      titulo: 'Decisión de tipos del FOMC',
      fechaUtc: new Date(eventMs).toISOString(),
      clave: 'fomc-1',
    });
    const { service, notify } = makeService(database);

    service.start();
    vi.advanceTimersByTime(15 * MINUTE + 1);

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0] as {
      level: string;
      title: string;
      body: string;
      navigateTo: string;
    };
    expect(payload.level).toBe('alerta');
    expect(payload.title).toBe('Tradia · Evento de alto impacto en 30m');
    expect(payload.body).toMatch(/^Decisión de tipos del FOMC \(US\) a las \d{2}:\d{2}/);
    expect(payload.body).toContain('Impacto: Alto.');
    expect(payload.navigateTo).toBe('calendario');

    const rows = logRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clave: `evento-previo:${id}`,
      tipo: 'evento-previo',
      ref_id: id,
      nivel: 'alerta',
      titulo: payload.title,
      cuerpo: payload.body,
    });
    service.stop();
  });

  it('no repite el aviso en pasadas siguientes', () => {
    const database = db();
    insertEvent(database, {
      titulo: 'IPC de EE. UU.',
      fechaUtc: new Date(FIXED_NOW + 40 * MINUTE).toISOString(),
      clave: 'ipc-1',
    });
    const { service, notify } = makeService(database);
    service.start();
    vi.advanceTimersByTime(20 * MINUTE);
    service.evaluate();
    service.evaluate();
    expect(notify).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('no avisa de eventos ya pasados (tras dormir o al arrancar tarde)', () => {
    const database = db();
    insertEvent(database, {
      titulo: 'NFP pasado',
      fechaUtc: new Date(FIXED_NOW - 10 * MINUTE).toISOString(),
      clave: 'nfp-past',
    });
    const { service, notify } = makeService(database);
    service.start();
    service.evaluate();
    expect(notify).not.toHaveBeenCalled();
    expect(logRows(database)).toHaveLength(0);
    service.stop();
  });

  it('al despertar dentro de la ventana de antelación avisa al instante', () => {
    const database = db();
    // El aviso vencía hace 10 min pero el evento sigue en el futuro.
    insertEvent(database, {
      titulo: 'PIB preliminar',
      fechaUtc: new Date(FIXED_NOW + 20 * MINUTE).toISOString(),
      clave: 'pib-1',
    });
    const { service, notify } = makeService(database);
    service.start();
    expect(notify).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('ignora eventos de impacto medio o bajo', () => {
    const database = db();
    insertEvent(database, {
      titulo: 'Inventarios EIA',
      tipo: 'eia',
      impacto: 'medio',
      fechaUtc: new Date(FIXED_NOW + 20 * MINUTE).toISOString(),
      clave: 'eia-1',
    });
    const { service, notify } = makeService(database);
    service.start();
    vi.advanceTimersByTime(60 * MINUTE);
    expect(notify).not.toHaveBeenCalled();
    service.stop();
  });

  it('la antelación se ajusta con setPrefs', () => {
    const database = db();
    insertEvent(database, {
      titulo: 'FOMC',
      fechaUtc: new Date(FIXED_NOW + 25 * MINUTE).toISOString(),
      clave: 'fomc-2',
    });
    let prefs: AlertPrefs = { leadMinutes: 15 };
    const { service, notify } = makeService(database, {
      getPrefs: () => prefs,
      setPrefs: (next) => {
        prefs = { ...next };
      },
    });
    service.start();
    // Con 15 min de antelación el evento a 25 min todavía no avisa.
    expect(notify).not.toHaveBeenCalled();
    // Cambiar a 45 min reprograma y avisa al instante (ventana abierta).
    service.setPrefs({ leadMinutes: 45 });
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0] as { title: string };
    expect(payload.title).toBe('Tradia · Evento de alto impacto en 45m');
    service.stop();
  });

  it('al reanudar el equipo reevalúa: no avisa lo pasado, sí lo que viene', () => {
    const database = db();
    const { service, notify, power } = makeService(database);
    service.start();
    // Mientras el equipo duerme 30 min vence un evento; el otro sigue vivo.
    insertEvent(database, {
      titulo: 'Evento durante la suspensión',
      fechaUtc: new Date(FIXED_NOW + 10 * MINUTE).toISOString(),
      clave: 'ev-sleep',
    });
    insertEvent(database, {
      titulo: 'Evento que viene',
      fechaUtc: new Date(FIXED_NOW + 50 * MINUTE).toISOString(),
      clave: 'ev-next',
    });
    vi.setSystemTime(FIXED_NOW + 30 * MINUTE);
    power.emitResume();
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0] as { body: string };
    expect(payload.body).toContain('Evento que viene');
    expect(payload.body).not.toContain('suspensión');
    service.stop();
  });

  it('advanceClock mueve el reloj y dispara avisos vencidos', () => {
    const database = db();
    insertEvent(database, {
      titulo: 'IPC',
      fechaUtc: new Date(FIXED_NOW + 40 * MINUTE).toISOString(),
      clave: 'ipc-2',
    });
    const { service, notify } = makeService(database);
    service.start();
    const result = service.advanceClock!(20 * MINUTE);
    expect(result.now).toBe(new Date(FIXED_NOW + 20 * MINUTE).toISOString());
    expect(notify).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('un evento sin país se anuncia sin paréntesis', () => {
    const database = db();
    insertEvent(database, {
      titulo: 'Triple witching',
      tipo: 'vencimiento',
      pais: null,
      fechaUtc: new Date(FIXED_NOW + 20 * MINUTE).toISOString(),
      clave: 'tw-1',
    });
    const { service, notify } = makeService(database);
    service.start();
    const payload = notify.mock.calls[0]![0] as { body: string };
    expect(payload.body).toMatch(/^Triple witching a las \d{2}:\d{2}/);
    service.stop();
  });
});

describe('avisos de noticias (onItemsStored)', () => {
  it('emite critica por activo y registra noticia-critica', () => {
    const database = db();
    const { service, notify } = makeService(database, { listWatchlist: () => ['AAPL'] });
    const news = item({
      priority: 'activo',
      confirmed: true,
      assets: ['AAPL'],
      sources: [source(1, 'agencia', 'Bloomberg')],
    });
    service.handleItemsStored({ added: [news], updated: [] });
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0] as { level: string; navigateTo: string };
    expect(payload.level).toBe('critica');
    expect(payload.navigateTo).toBe('noticias');
    expect(logRows(database)).toEqual([
      expect.objectContaining({ clave: `noticia-critica:${news.id}`, nivel: 'critica' }),
    ]);
  });

  it('procesa también titulares actualizados (fusión de fuentes)', () => {
    const database = db();
    const { service, notify } = makeService(database);
    const news = item({ priority: 'maxima', confirmed: true, sources: [source(1, 'oficial')] });
    service.handleItemsStored({ added: [], updated: [news] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('no repite un aviso ya registrado', () => {
    const database = db();
    const { service, notify } = makeService(database, { listWatchlist: () => ['AAPL'] });
    const news = item({
      priority: 'activo',
      assets: ['AAPL'],
      sources: [source(1, 'agencia')],
    });
    service.handleItemsStored({ added: [news], updated: [] });
    service.handleItemsStored({ added: [], updated: [news] });
    service.handleItemsStored({ added: [news], updated: [] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('un rumor solo de redes avisa como máximo en info', () => {
    const database = db();
    const { service, notify } = makeService(database, { listWatchlist: () => ['NVDA'] });
    const news = item({
      priority: 'activo',
      assets: ['NVDA'],
      sources: [source(1, 'redes', 'r/wallstreetbets')],
    });
    service.handleItemsStored({ added: [news], updated: [] });
    const payload = notify.mock.calls[0]![0] as { level: string; title: string };
    expect(payload.level).toBe('info');
    expect(payload.title).toBe('Tradia · Rumor en redes: NVDA (Sin confirmar)');
  });

  it('más de 3 en 5 minutos → un solo resumen de ráfaga', () => {
    const database = db();
    const { service, notify } = makeService(database);
    const batch = Array.from({ length: ALERT_BURST_MAX + 1 }, (_, index) =>
      item({
        priority: 'maxima',
        confirmed: true,
        title: `Noticia crítica ${index}`,
        sources: [source(1, 'oficial')],
      }),
    );
    service.handleItemsStored({ added: batch, updated: [] });

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0] as { level: string; title: string; body: string };
    expect(payload.level).toBe('alerta');
    expect(payload.title).toBe(`Tradia · ${ALERT_BURST_MAX + 1} noticias relevantes`);
    expect(payload.body).toBe(
      `Recibidos ${ALERT_BURST_MAX + 1} titulares en los últimos 5 minutos.`,
    );

    const rows = logRows(database);
    // Un resumen más una fila por noticia: nada se repite después.
    expect(rows.filter((row) => row.clave.startsWith('rafaga:'))).toHaveLength(1);
    expect(rows.filter((row) => row.clave.startsWith('noticia-critica:'))).toHaveLength(
      ALERT_BURST_MAX + 1,
    );

    service.handleItemsStored({ added: batch, updated: [] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('la ráfaga también se consolida entre pasadas de la ventana', () => {
    const database = db();
    const { service, notify } = makeService(database);
    const critical = () =>
      item({ priority: 'maxima', confirmed: true, sources: [source(1, 'oficial')] });

    service.handleItemsStored({ added: [critical(), critical()], updated: [] });
    expect(notify).toHaveBeenCalledTimes(2);

    // Dos más dentro de la ventana: 4 en 5 minutos → resumen.
    service.handleItemsStored({ added: [critical(), critical()], updated: [] });
    expect(notify).toHaveBeenCalledTimes(3);
    expect((notify.mock.calls[2]![0] as { title: string }).title).toBe(
      'Tradia · 4 noticias relevantes',
    );

    // Con resumen ya emitido en la ventana, lo nuevo queda cubierto en silencio.
    service.handleItemsStored({ added: [critical()], updated: [] });
    expect(notify).toHaveBeenCalledTimes(3);
    const rows = logRows(database);
    expect(rows.filter((row) => row.clave.startsWith('rafaga:'))).toHaveLength(1);
    expect(rows.filter((row) => row.clave.startsWith('noticia-critica:'))).toHaveLength(5);

    // Fuera de la ventana vuelven a avisar de forma individual.
    vi.setSystemTime(FIXED_NOW + ALERT_BURST_WINDOW_MS + MINUTE);
    service.handleItemsStored({ added: [critical()], updated: [] });
    expect(notify).toHaveBeenCalledTimes(4);
  });
});

describe('el aviso sale por el servicio notifications', () => {
  it('un Notification simulado recibe el aviso previo y el clic navega a calendario', () => {
    const database = db();
    const { service: notifications, focused, navigated } = realNotifications();
    insertEvent(database, {
      titulo: 'FOMC',
      fechaUtc: new Date(FIXED_NOW + 20 * MINUTE).toISOString(),
      clave: 'fomc-3',
    });
    const { service } = makeService(database, { notify: (p) => notifications.notify(p) });
    service.start();

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.shown).toBe(true);
    expect(FakeNotification.instances[0]!.options.title).toContain('alto impacto');

    FakeNotification.instances[0]!.emitClick();
    expect(focused).toHaveLength(1);
    expect(navigated).toEqual(['calendario']);
    service.stop();
  });

  it('el clic de una noticia crítica navega a noticias', () => {
    const database = db();
    const { service: notifications, navigated } = realNotifications();
    const { service } = makeService(database, {
      notify: (p) => notifications.notify(p),
      listWatchlist: () => ['AAPL'],
    });
    service.handleItemsStored({
      added: [item({ priority: 'activo', assets: ['AAPL'], sources: [source(1, 'agencia')] })],
      updated: [],
    });
    FakeNotification.instances[0]!.emitClick();
    expect(navigated).toEqual(['noticias']);
  });

  it('respeta las preferencias por nivel pero deja constancia en el registro', () => {
    const database = db();
    const { service: notifications, prefs } = realNotifications();
    prefs.current = { ...ALL_ON, critica: false };
    const { service } = makeService(database, { notify: (p) => notifications.notify(p) });
    const news = item({
      priority: 'maxima',
      confirmed: true,
      sources: [source(1, 'oficial')],
    });
    service.handleItemsStored({ added: [news], updated: [] });
    expect(FakeNotification.instances).toHaveLength(0);
    // El aviso quedó registrado: no se vuelve a emitir aunque se reactive.
    expect(logRows(database)).toHaveLength(1);
  });
});

describe('registerAlerts (cableado IPC y servicios)', () => {
  const makeCtx = (database: Database.Database) => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const itemsListeners: Array<(event: { added: NewsItem[]; updated: NewsItem[] }) => void> = [];
    const notify = vi.fn();
    const pollerAdvance = vi.fn((ms: number) => ({
      now: new Date(FIXED_NOW + ms).toISOString(),
    }));
    const ctx = {
      broadcast: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      services: {
        storage: { getDb: () => database },
        settings: createSettingsService(database),
        notifications: { notify },
        market: { listWatchlist: () => [{ ticker: 'AAPL' }] },
        poller: {
          onItemsStored: (listener: (event: unknown) => void) => {
            itemsListeners.push(listener as never);
            return () => undefined;
          },
          advanceClock: pollerAdvance,
        },
      },
    } as unknown as ServiceContext;
    return {
      ctx,
      sent,
      itemsListeners,
      notify,
      pollerAdvance,
      emitItems: (event: { added: NewsItem[]; updated: NewsItem[] }) => {
        for (const listener of itemsListeners) listener(event);
      },
    };
  };

  it('registra alerts:get-prefs y alerts:set-prefs con validación', () => {
    const database = db();
    const { ctx } = makeCtx(database);
    const service = registerAlerts(ctx);

    const getPrefs = env.handlers.get(IPC_CHANNELS.alerts.getPrefs)!;
    const setPrefs = env.handlers.get(IPC_CHANNELS.alerts.setPrefs)!;
    expect(getPrefs(null)).toEqual({ leadMinutes: 30 });
    expect(() => setPrefs(null, { leadMinutes: 20 })).toThrowError(IpcValidationError);
    expect(setPrefs(null, { leadMinutes: 60 })).toEqual({ leadMinutes: 60 });
    expect(getPrefs(null)).toEqual({ leadMinutes: 60 });
    service.stop();
  });

  it('persiste las preferencias en settings', () => {
    const database = db();
    const { ctx } = makeCtx(database);
    const service = registerAlerts(ctx);
    service.setPrefs({ leadMinutes: 45 });
    expect(ctx.services.settings!.getValue('alerts.prefs')).toBe(
      JSON.stringify({ leadMinutes: 45 }),
    );
    service.stop();
  });

  it('los titulares del lector disparan las reglas de aviso', () => {
    const database = db();
    const { ctx, emitItems, notify } = makeCtx(database);
    const service = registerAlerts(ctx);
    emitItems({
      added: [item({ priority: 'activo', assets: ['AAPL'], sources: [source(1, 'agencia')] })],
      updated: [],
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0]![0] as { level: string }).level).toBe('critica');
    service.stop();
  });

  it('reprograma al emitirse calendar:updated por broadcast', () => {
    const database = db();
    const { ctx, notify } = makeCtx(database);
    const service = registerAlerts(ctx);
    insertEvent(database, {
      titulo: 'IPC próximo',
      fechaUtc: new Date(FIXED_NOW + 20 * MINUTE).toISOString(),
      clave: 'ipc-3',
    });
    ctx.broadcast(IPC_CHANNELS.calendar.updated, { updatedAt: new Date().toISOString() });
    expect(notify).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('encadena el avance del reloj de desarrollo tras poller y calendario', () => {
    const database = db();
    const { ctx, pollerAdvance, notify } = makeCtx(database);
    const service = registerAlerts(ctx);
    insertEvent(database, {
      titulo: 'FOMC',
      fechaUtc: new Date(FIXED_NOW + 50 * MINUTE).toISOString(),
      clave: 'fomc-4',
    });
    // Llamar a poller.advanceClock (como hace el handler news:advance-clock)
    // debe mover también el reloj de los avisos: +30 min entra en la ventana.
    ctx.services.poller!.advanceClock!(30 * MINUTE);
    expect(pollerAdvance).toHaveBeenCalledWith(30 * MINUTE);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0]![0] as { body: string }).body).toContain('FOMC');
    service.stop();
  });
});
