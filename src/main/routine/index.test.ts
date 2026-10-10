import { tmpdir } from 'node:os';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarEvent, NewsItem, NewsListQuery } from '../../shared/ipc';
import {
  ROUTINE_DEFAULTS,
  type JournalEntry,
  type JournalListQuery,
  type JournalRecordInput,
  type RoutineConfig,
} from '../../shared/journal';
import type { PaperPortfolioOverview, Signal, SignalsListQuery } from '../../shared/signals';
import { openDatabase } from '../db/database';
import { createJournalService, type JournalService } from '../journal';
import { createJournalRepository } from '../journal/repository';
import { zonedToUtcMs } from '../market/calendar';
import type { StoredBar } from '../market/repository';
import type { ServiceContext } from '../services';
import type { DeliveryMessage } from '../delivery';
import {
  createRoutineClock,
  createRoutineService,
  registerRoutine,
  RoutineServiceError,
  ROUTINE_CONFIG_KEY,
  type RoutineTimerHandle,
} from './index';
import { createRoutineReads, createRoutineRunsRepository } from './repository';

// electron solo aporta app/ipcMain/powerMonitor (y lo que importa el módulo
// del diario): mismo patrón que las demás pruebas de servicios de main.
const electron = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  resumeListeners: new Set<() => void>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
    getPath: () => tmpdir(),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  powerMonitor: {
    on: (_event: string, listener: () => void) => electron.resumeListeners.add(listener),
    removeListener: (_event: string, listener: () => void) =>
      electron.resumeListeners.delete(listener),
  },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const NY = 'America/New_York';
/** Instante UTC (ms) de una hora civil de Nueva York. */
const at = (y: number, m: number, d: number, h: number, mi: number): number =>
  zonedToUtcMs(y, m, d, h, mi, NY);

// Miércoles 7 de octubre de 2026, día de mercado (EDT, UTC-4).
const DIA = '2026-10-07';
const OPEN_DAY = {
  preapertura: at(2026, 10, 7, 8, 30),
  cierre: at(2026, 10, 7, 16, 15),
  conciliacion: at(2026, 10, 7, 17, 30),
};

let db: Database.Database;
let journal: JournalService;
let current: number;
let clock: ReturnType<typeof createRoutineClock>;
let sent: { kind: string; message: DeliveryMessage }[];
let timers: { id: number; cb: () => void; ms: number }[];
let nextTimerId: number;
let newsItems: NewsItem[];
let calendarEvents: CalendarEvent[];
let barsByTicker: Record<string, StoredBar[]>;
let signalsList: Signal[];
let portfolio: PaperPortfolioOverview;
let persistedConfig: RoutineConfig | null;

const makeNews = (patch: Partial<NewsItem> = {}): NewsItem => ({
  id: 1,
  title: 'Titular',
  url: null,
  publishedAt: '2026-10-07T01:00:00.000Z',
  summary: null,
  priority: 'media',
  confirmed: false,
  sources: [],
  assets: [],
  ...patch,
});

const makeEvent = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 1,
  kind: 'fomc',
  title: 'Decisión del FOMC',
  dateUtc: '2026-10-07T18:00:00.000Z', // 14:00 ET del día
  impact: 'alto',
  country: 'US',
  asset: null,
  origin: 'regla',
  ...patch,
});

const makeBar = (date: string, open: number, close: number): StoredBar => ({
  id: 1,
  ticker: 'AAPL',
  date,
  source: 'simulado',
  batchId: 1,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume: 1_000_000,
  adjOpen: null,
  adjHigh: null,
  adjLow: null,
  adjClose: null,
  adjVolume: null,
});

const makeSignal = (patch: Partial<Signal> = {}): Signal => ({
  id: 1,
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 110,
  confidence: 0.6,
  reason: 'Cruce de medias alcista',
  strategies: [],
  dataUsed: {
    barDate: DIA,
    desde: '2026-09-01',
    hasta: DIA,
    barCount: 25,
    batchId: 1,
    batchVersion: 2,
    source: 'simulado',
  },
  decision: {
    status: 'aprobada',
    size: 5,
    sizeFactor: 1,
    riskAmount: 25,
    notional: 500,
    reasons: [],
    decidedAt: '2026-10-07T20:00:00.000Z',
  },
  createdAt: '2026-10-07T20:00:00.000Z',
  ...patch,
});

const makePortfolio = (patch: Partial<PaperPortfolioOverview> = {}): PaperPortfolioOverview => ({
  equity: 100_000,
  currency: 'USD',
  positions: [],
  drawdownPct: 2.4,
  drawdownLimitPct: 15,
  dailyLossPct: 0.3,
  dailyLossLimitPct: 5,
  exposureByAsset: [],
  exposureBySector: [],
  openPositions: 2,
  maxOpenPositions: 8,
  updatedAt: '2026-10-07T20:15:00.000Z',
  ...patch,
});

const fireTimers = (): void => {
  const pending = [...timers];
  timers.length = 0;
  for (const t of pending) t.cb();
};

const makeService = () =>
  createRoutineService({
    runs: createRoutineRunsRepository(db),
    reads: createRoutineReads(db),
    clock,
    getConfig: () => persistedConfig ?? { ...ROUTINE_DEFAULTS },
    persistConfig: (config) => {
      persistedConfig = config;
    },
    listNews: (query: NewsListQuery) => {
      return newsItems.filter(
        (item) =>
          (query.desde === undefined || item.publishedAt.slice(0, 10) >= query.desde) &&
          (query.hasta === undefined || item.publishedAt.slice(0, 10) <= query.hasta),
      );
    },
    listCalendarEvents: (desde, hasta) =>
      calendarEvents.filter(
        (e) => e.dateUtc.slice(0, 10) >= desde && e.dateUtc.slice(0, 10) <= hasta,
      ),
    listWatchlistTickers: () => Object.keys(barsByTicker),
    getBars: (ticker) => barsByTicker[ticker] ?? [],
    listSignals: (query: SignalsListQuery) =>
      signalsList.filter(
        (s) =>
          (query.desde === undefined || s.dataUsed.barDate >= query.desde) &&
          (query.hasta === undefined || s.dataUsed.barDate <= query.hasta),
      ),
    listJournal: (query: JournalListQuery) => journal.list(query),
    recordJournal: (input: JournalRecordInput) => journal.record(input),
    getPortfolio: () => portfolio,
    sendEvent: (kind, message) => {
      sent.push({ kind, message });
    },
    setTimer: (cb, ms) => {
      const timer = { id: ++nextTimerId, cb, ms };
      timers.push(timer);
      return timer.id as unknown as RoutineTimerHandle;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== (id as unknown as number));
    },
    powerMonitor: {
      on: (_e, listener) => electron.resumeListeners.add(listener),
      removeListener: (_e, listener) => electron.resumeListeners.delete(listener),
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

beforeEach(() => {
  db = openDatabase(':memory:');
  journal = createJournalService({
    repo: createJournalRepository(db),
    broadcast: () => undefined,
    now: () => current,
  });
  current = at(2026, 10, 7, 7, 0); // 07:00 ET del día de mercado
  clock = createRoutineClock(() => current);
  sent = [];
  timers = [];
  nextTimerId = 0;
  newsItems = [];
  calendarEvents = [];
  barsByTicker = {};
  signalsList = [];
  portfolio = makePortfolio();
  persistedConfig = null;
});

afterEach(() => {
  db.close();
});

const entries = (type?: string): JournalEntry[] =>
  journal.list({ type: type as never, limit: 1000 }).entries;

describe('rutina diaria · horarios y deduplicación', () => {
  it('envía las tres tareas a su hora como aviso y entrada del diario', () => {
    const service = makeService();
    service.start();
    expect(sent).toEqual([]);

    // 08:30 ET: resumen previo a la apertura.
    service.advanceClock!(OPEN_DAY.preapertura - at(2026, 10, 7, 7, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('resumen-diario');
    expect(sent[0]!.message.title).toBe(`Resumen previo a la apertura · ${DIA}`);
    expect(sent[0]!.message.body).toContain('0 noticias relevantes');
    expect(sent[0]!.message.body).toContain('Aviso informativo: Tradia no ejecuta órdenes reales.');
    expect(sent[0]!.message.body).not.toContain('con retraso');

    // 16:15 ET: revisión al cierre.
    service.advanceClock!(OPEN_DAY.cierre - OPEN_DAY.preapertura);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message.title).toBe(`Revisión al cierre · ${DIA}`);
    expect(sent[1]!.message.body).toContain('2 posiciones simuladas');
    expect(sent[1]!.message.body).toContain('Drawdown: 2.4 %');

    // 17:30 ET: conciliación.
    service.advanceClock!(OPEN_DAY.conciliacion - OPEN_DAY.cierre);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.message.title).toBe(`Conciliación completada · ${DIA}`);
    expect(sent[2]!.message.body).toContain('Sin discrepancias');

    const resumenes = entries('resumen');
    expect(resumenes).toHaveLength(3);
    expect(resumenes.map((e) => e.result)).toEqual(['completado', 'completado', 'completado']);
    // routine_runs quedó enlazado con cada entrada.
    const runs = db
      .prepare('SELECT rutina, con_retraso, journal_id FROM routine_runs ORDER BY id')
      .all() as {
      rutina: string;
      con_retraso: number;
      journal_id: number;
    }[];
    expect(runs.map((r) => r.rutina)).toEqual(['preapertura', 'cierre', 'conciliacion']);
    expect(runs.every((r) => r.con_retraso === 0 && r.journal_id > 0)).toBe(true);
    service.stop();
  });

  it('no envía en fin de semana ni festivo, y no repite el día siguiente', () => {
    // Viernes 9 de octubre: se envía la preapertura a su hora.
    current = at(2026, 10, 9, 7, 0);
    const service = makeService();
    service.start();
    service.advanceClock!(at(2026, 10, 9, 8, 30) - current);
    expect(sent).toHaveLength(1);

    // Sábado y domingo: nada.
    service.advanceClock!(at(2026, 10, 10, 10, 0) - at(2026, 10, 9, 8, 30));
    expect(sent).toHaveLength(1);
    service.advanceClock!(at(2026, 10, 11, 10, 0) - at(2026, 10, 10, 10, 0));
    expect(sent).toHaveLength(1);

    // Lunes a las 09:00: la preapertura del lunes sale «con retraso»
    // (se perdió su hora de las 08:30) y la del viernes no se reenvía.
    service.advanceClock!(at(2026, 10, 12, 9, 0) - at(2026, 10, 11, 10, 0));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message.title).toBe('Resumen previo a la apertura · 2026-10-12');
    expect(sent[1]!.message.body).toContain('Enviado con retraso.');
    service.stop();
  });

  it('omite festivos NYSE (Año Nuevo)', () => {
    // Jueves 1 de enero de 2026: festivo; nada que enviar a ninguna hora.
    current = at(2026, 1, 1, 7, 0);
    const service = makeService();
    service.start();
    service.advanceClock!(at(2026, 1, 1, 18, 0) - current);
    expect(sent).toEqual([]);
    expect(entries('resumen')).toEqual([]);
    service.stop();
  });

  it('recupera al despertar marcado «con retraso», como mucho una vez al día', () => {
    const service = makeService();
    service.start();
    // El equipo «despierta» a las 10:00: las 08:30 ya pasaron.
    const outcomes = service.advanceClock!(at(2026, 10, 7, 10, 0) - current);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.body).toContain('Enviado con retraso.');

    const run = db
      .prepare('SELECT con_retraso FROM routine_runs WHERE rutina = ?')
      .get('preapertura') as { con_retraso: number };
    expect(run.con_retraso).toBe(1);
    expect(entries('resumen')[0]!.result).toBe('con-retraso');
    void outcomes;

    // Reevaluar el mismo día no repite el envío.
    service.evaluate();
    fireTimers();
    expect(sent).toHaveLength(1);
    service.stop();
  });

  it('un despertar del sistema (powerMonitor resume) reevalúa los envíos', () => {
    const service = makeService();
    service.start();
    current = at(2026, 10, 7, 17, 45); // el equipo despierta tras las tres horas
    for (const listener of electron.resumeListeners) listener();
    expect(sent).toHaveLength(3);
    expect(sent.every((s) => s.message.body.includes('Enviado con retraso.'))).toBe(true);
    service.stop();
    // Tras stop() el despertar ya no evalúa.
    for (const listener of electron.resumeListeners) listener();
    expect(sent).toHaveLength(3);
  });

  it('el temporizador armado dispara la evaluación a la hora exacta', () => {
    const service = makeService();
    service.start();
    expect(timers).toHaveLength(1);
    // El próximo envío es la preapertura de las 08:30 (dentro de 90 min).
    expect(timers[0]!.ms).toBe(OPEN_DAY.preapertura - at(2026, 10, 7, 7, 0));
    current = OPEN_DAY.preapertura;
    fireTimers();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.body).not.toContain('Enviado con retraso.');
    service.stop();
  });
});

describe('rutina diaria · contenido de los resúmenes', () => {
  it('la preapertura cuenta noticias de la noche por prioridad, eventos y huecos', () => {
    // Sesión anterior: martes 6, cierre 16:00 ET = 20:00 UTC.
    newsItems = [
      makeNews({ id: 1, priority: 'maxima', publishedAt: '2026-10-06T21:00:00.000Z' }),
      makeNews({
        id: 2,
        priority: 'activo',
        publishedAt: '2026-10-07T11:00:00.000Z',
        assets: ['AAPL'],
      }),
      makeNews({ id: 3, priority: 'baja', publishedAt: '2026-10-07T01:00:00.000Z' }),
      // Durante la sesión del martes: no es «de la noche».
      makeNews({ id: 4, priority: 'maxima', publishedAt: '2026-10-06T15:00:00.000Z' }),
    ];
    calendarEvents = [
      makeEvent({ id: 1 }),
      // Evento del día siguiente: no cuenta.
      makeEvent({ id: 2, dateUtc: '2026-10-08T14:00:00.000Z', impact: 'bajo' }),
    ];
    barsByTicker = {
      // AAPL: 100 → apertura 103 (+3 %): hueco en seguimiento.
      AAPL: [makeBar('2026-10-05', 99, 100), makeBar('2026-10-06', 103, 104)],
      // MSFT: hueco del 0,4 %: por debajo del umbral.
      MSFT: [makeBar('2026-10-05', 50, 50), makeBar('2026-10-06', 50.2, 51)],
    };
    const service = makeService();
    service.start();
    service.advanceClock!(OPEN_DAY.preapertura - at(2026, 10, 7, 7, 0));
    expect(sent[0]!.message.body).toBe(
      '2 noticias relevantes, 1 evento de calendario y 1 hueco en seguimiento. ' +
        'Aviso informativo: Tradia no ejecuta órdenes reales.',
    );
    const resumen = entries('resumen')[0]!;
    const data = resumen.dataUsed as { noticias: { porPrioridad: Record<string, number> } };
    expect(data.noticias.porPrioridad).toMatchObject({ maxima: 1, activo: 1, baja: 1 });
    service.stop();
  });

  it('la revisión al cierre cuenta señales y vetos del día', () => {
    signalsList = [
      makeSignal({ id: 1 }),
      makeSignal({
        id: 2,
        decision: { ...makeSignal().decision, status: 'vetada', size: 0 },
      }),
    ];
    const service = makeService();
    service.start();
    service.advanceClock!(OPEN_DAY.cierre - at(2026, 10, 7, 7, 0));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message.body).toContain('1 señal, 1 veto y 2 posiciones simuladas.');
    service.stop();
  });

  it('la conciliación anota las discrepancias como error en el diario', () => {
    // Señal aprobada del día sin posición enlazada: descuadre.
    signalsList = [makeSignal({ id: 7 })];
    const service = makeService();
    service.start();
    service.advanceClock!(OPEN_DAY.conciliacion - at(2026, 10, 7, 7, 0));
    expect(sent).toHaveLength(3);
    expect(sent[2]!.message.body).toContain('1 discrepancia detectada');

    const errores = entries('error');
    expect(errores).toHaveLength(1);
    expect(errores[0]!.reason).toContain('Conciliación del 2026-10-07');
    expect(errores[0]!.errors[0]).toContain('señal #7');
    expect(errores[0]!.errors[0]).toContain('posición simulada');
    service.stop();
  });

  it('el postmercado invoca a los oyentes de onPostMarket una vez por día', () => {
    const service = makeService();
    const calls: string[] = [];
    service.onPostMarket((dia) => calls.push(dia));
    service.start();
    service.advanceClock!(OPEN_DAY.conciliacion - at(2026, 10, 7, 7, 0));
    expect(calls).toEqual([DIA]);
    // Reevaluar el mismo día no repite: la deduplicación por día manda.
    service.evaluate();
    expect(calls).toEqual([DIA]);
    // El desregistro quita al oyente para el día siguiente.
    const off = service.onPostMarket((dia) => calls.push(`extra-${dia}`));
    off();
    service.stop();
  });

  it('una tarea que falla deja entrada de error y no bloquea a las demás', () => {
    const service = createRoutineService({
      runs: createRoutineRunsRepository(db),
      reads: createRoutineReads(db),
      clock,
      getConfig: () => ({ ...ROUTINE_DEFAULTS }),
      listNews: () => {
        throw new Error('almacén de noticias roto');
      },
      listJournal: (query) => journal.list(query),
      recordJournal: (input) => journal.record(input),
      sendEvent: (kind, message) => {
        sent.push({ kind, message });
      },
      setTimer: (cb, ms) => {
        const timer = { id: ++nextTimerId, cb, ms };
        timers.push(timer);
        return timer.id as unknown as RoutineTimerHandle;
      },
      clearTimer: (id) => {
        timers = timers.filter((t) => t.id !== (id as unknown as number));
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    service.start();
    const outcomes = service.advanceClock!(OPEN_DAY.conciliacion - at(2026, 10, 7, 7, 0));
    // La preapertura falló y quedó anotada; las otras dos salieron.
    expect(outcomes.now).toBe(new Date(OPEN_DAY.conciliacion).toISOString());
    expect(sent).toHaveLength(2);
    expect(entries('error')[0]!.errors[0]).toContain('almacén de noticias roto');
    service.stop();
  });
});

describe('rutina diaria · configuración', () => {
  it('getConfig/setConfig persisten y reprograman; el inválido se rechaza', () => {
    const service = makeService();
    service.start();
    expect(service.getConfig()).toEqual(ROUTINE_DEFAULTS);
    expect(() => service.setConfig({ ...ROUTINE_DEFAULTS, cierre: '25:00' })).toThrow(
      RoutineServiceError,
    );

    const custom: RoutineConfig = { preapertura: '07:45', cierre: '16:30', conciliacion: '18:00' };
    expect(service.setConfig(custom)).toEqual(custom);
    expect(persistedConfig).toEqual(custom);
    // Reprogramado: el próximo temporizador apunta a las 07:45 ET.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(at(2026, 10, 7, 7, 45) - at(2026, 10, 7, 7, 0));
    service.stop();
  });
});

describe('registerRoutine · cableado IPC', () => {
  it('registra get-config/set-config y advanceClock solo con E2E', () => {
    const settingsStore = new Map<string, string>();
    const ctx: ServiceContext = {
      broadcast: () => undefined,
      services: {
        storage: {
          dbPath: ':memory:',
          getDb: () => db,
          close: () => undefined,
        } as never,
        settings: {
          getValue: (key: string) => settingsStore.get(key) ?? null,
          setValue: (key: string, value: string) => {
            settingsStore.set(key, value);
          },
        } as never,
        journal,
      },
    };
    electron.isPackaged = true;
    const service = registerRoutine(ctx);
    expect(electron.handlers.has('routine:get-config')).toBe(true);
    expect(electron.handlers.has('routine:set-config')).toBe(true);
    // Sin E2E (empaquetada): el gancho de reloj no existe.
    expect(electron.handlers.has('routine:advance-clock')).toBe(false);

    const getConfig = electron.handlers.get('routine:get-config')!;
    expect(getConfig()).toEqual(ROUTINE_DEFAULTS);
    const setConfig = electron.handlers.get('routine:set-config')!;
    setConfig(null, { preapertura: '09:00', cierre: '16:15', conciliacion: '17:30' });
    expect(JSON.parse(settingsStore.get(ROUTINE_CONFIG_KEY)!)).toMatchObject({
      preapertura: '09:00',
    });
    expect(() => setConfig(null, { preapertura: 'nada' })).toThrow();
    service.stop();
  });
});
