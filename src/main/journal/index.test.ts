import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  IpcValidationError,
  type JournalRecordInput,
  type JournalUpdatedEvent,
  type RiskVeto,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import {
  createJournalService,
  JournalServiceError,
  registerJournal,
  type JournalServiceDeps,
} from './index';
import { createJournalRepository, type JournalRepository } from './repository';

// electron solo aporta app/ipcMain/dialog/BrowserWindow a registerJournal;
// mismo patrón que las demás pruebas de servicios del proceso principal.
const electron = vi.hoisted(() => ({
  isPackaged: true,
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  saveDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
    getPath: (name: string) => (name === 'userData' ? electron.userData : tmpdir()),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  dialog: {
    showSaveDialog: (options: unknown) => electron.saveDialog(options),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

const NOW = Date.parse('2026-10-09T15:42:08.000Z');

let db: Database.Database;
let repo: JournalRepository;
let sent: { channel: string; payload: unknown }[];
let workDir: string;

const input = (patch: Partial<JournalRecordInput> = {}): JournalRecordInput => ({
  type: 'senal',
  ticker: 'aapl',
  reason: '  Cierre sobre SMA 50  ',
  result: 'aprobada',
  strategies: [{ strategyId: 7, name: 'Tendencia SMA', version: 3 }],
  ...patch,
});

const vetoEvent = (patch: Partial<RiskVeto> = {}): RiskVeto => ({
  id: 12,
  signal: {
    ticker: 'nvda',
    direction: 'largo',
    entry: 100,
    stop: 95,
    target: 105,
    confidence: 0.6,
    origin: 'estrategia',
  },
  ticker: 'NVDA',
  decision: 'vetada',
  code: 'RR_TOO_LOW',
  message: 'Beneficio/riesgo por debajo del mínimo',
  details: { ratio: 1, minimo: 2 },
  size: 4,
  createdAt: '2026-10-09T15:40:00.000Z',
  ...patch,
});

const makeService = (extra: Partial<JournalServiceDeps> = {}) =>
  createJournalService({
    repo,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    now: () => NOW,
    ...extra,
  });

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  electron.saveDialog.mockReset();
  db = openDatabase(':memory:');
  repo = createJournalRepository(db);
  sent = [];
  workDir = mkdtempSync(join(tmpdir(), 'tradia-journal-'));
  electron.userData = workDir;
});

afterEach(() => {
  db.close();
  delete process.env.TRADIA_E2E;
});

describe('createJournalService: registro', () => {
  it('record() persiste, normaliza el activo y emite journal:updated', () => {
    const service = makeService();
    const entry = service.record(input());

    expect(entry.ticker).toBe('AAPL');
    expect(entry.reason).toBe('Cierre sobre SMA 50');
    expect(entry.createdAt).toBe('2026-10-09T15:42:08.000Z');
    expect(service.get(entry.id)).toEqual(entry);

    const event = sent.find((s) => s.channel === IPC_CHANNELS.journal.updated)
      ?.payload as JournalUpdatedEvent;
    expect(event.entry.id).toBe(entry.id);
  });

  it('record() rechaza entradas mal formadas con error legible', () => {
    const service = makeService();
    expect(() => service.record(input({ type: 'aviso' as never }))).toThrowError(
      JournalServiceError,
    );
    expect(() => service.record(input({ reason: '  ' }))).toThrowError(/motivo/);
    expect(() => service.record(input({ result: 'quizas' as never }))).toThrowError(/resultado/);
    expect(() => service.record(input({ ruleChecks: [{ code: 'X' } as never] }))).toThrowError(
      /reglas/,
    );
    expect(sent).toHaveLength(0);
  });

  it('recordRiskVeto convierte el veto del motor en una entrada con la regla incumplida', () => {
    const service = makeService();
    const entry = service.recordRiskVeto(vetoEvent());

    expect(entry.type).toBe('veto');
    expect(entry.ticker).toBe('NVDA');
    expect(entry.result).toBe('vetada');
    expect(entry.reason).toBe('Beneficio/riesgo por debajo del mínimo');
    expect(entry.ruleChecks).toEqual([
      {
        code: 'RR_TOO_LOW',
        label: 'Beneficio/riesgo por debajo del mínimo',
        cumplida: false,
        observed: '1',
        limit: '2',
      },
    ]);
    expect(entry.dataUsed).toMatchObject({ vetoId: 12, tamano: 4 });
    expect(entry.signalId).toBeNull();
  });
});

describe('createJournalService: exportación CSV', () => {
  it('en E2E escribe en la ruta indicada dentro del entorno de pruebas', async () => {
    const service = makeService({
      e2e: true,
      allowedExportDirs: () => [workDir],
      writeFile: writeFileSync,
    });
    service.record(input());
    service.record(input({ type: 'error', reason: 'Fallo, con coma\ny salto' }));

    const target = join(workDir, 'diario.csv');
    const result = await service.exportCsv({ path: target });
    expect(result).toEqual({ canceled: false, path: target, entries: 2 });

    const csv = readFileSync(target, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split('\r\n')[0]).toContain('id,fecha,tipo,activo');
    expect(csv).toContain('"Fallo, con coma\ny salto"');
  });

  it('en E2E rechaza rutas fuera de las carpetas permitidas', async () => {
    const service = makeService({ e2e: true, allowedExportDirs: () => [workDir] });
    await expect(service.exportCsv({ path: '/etc/passwd.csv' })).rejects.toMatchObject({
      code: 'ruta-no-permitida',
    });
  });

  it('en la app abre el diálogo de guardar y escribe el CSV elegido', async () => {
    const target = join(workDir, 'elegido.csv');
    electron.saveDialog.mockResolvedValue({ canceled: false, filePath: target });
    const service = makeService({
      showSaveDialog: (options: unknown) => electron.saveDialog(options),
      writeFile: writeFileSync,
    });
    service.record(input({ ticker: 'nvda' }));
    service.record(input({ ticker: 'msft' }));

    const result = await service.exportCsv({ query: { ticker: 'nvda' } });
    expect(result.entries).toBe(1);
    expect(result.path).toBe(target);
    expect(electron.saveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'tradia-diario-2026-10-09.csv' }),
    );
    expect(readFileSync(target, 'utf8').split('\r\n').filter(Boolean)).toHaveLength(2);
  });

  it('una cancelación del diálogo no crea archivo ni error', async () => {
    electron.saveDialog.mockResolvedValue({ canceled: true });
    const service = makeService({
      showSaveDialog: (options: unknown) => electron.saveDialog(options),
      writeFile: writeFileSync,
    });
    service.record(input());
    const result = await service.exportCsv();
    expect(result).toEqual({ canceled: true, path: null, entries: 0 });
  });
});

describe('registerJournal', () => {
  const makeCtx = (): ServiceContext => ({
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    services: {
      storage: { getDb: () => db },
    } as unknown as ServiceContext['services'],
  });

  const invoke = (channel: string, arg?: unknown): unknown =>
    electron.handlers.get(channel)!(null, arg);

  it('registra journal:list/get/export-csv con validación de entrada', () => {
    registerJournal(makeCtx());
    expect(() => invoke(IPC_CHANNELS.journal.list, { type: 'aviso' })).toThrowError(
      IpcValidationError,
    );
    expect(() => invoke(IPC_CHANNELS.journal.get, -3)).toThrowError(IpcValidationError);
    expect(() => invoke(IPC_CHANNELS.journal.exportCsv, { path: 'relativo.csv' })).toThrowError(
      IpcValidationError,
    );

    const page = invoke(IPC_CHANNELS.journal.list, { type: 'senal' }) as {
      entries: unknown[];
      total: number;
    };
    expect(page).toMatchObject({ entries: [], total: 0 });
    expect(invoke(IPC_CHANNELS.journal.get, 1)).toBeNull();
  });

  it('escucha risk:vetoed envolviendo ctx.broadcast: cada veto entra al diario', () => {
    const ctx = makeCtx();
    const service = registerJournal(ctx);

    ctx.broadcast(IPC_CHANNELS.risk.vetoed, vetoEvent());
    ctx.broadcast(IPC_CHANNELS.risk.vetoed, vetoEvent({ id: 13, decision: 'reducida' }));
    ctx.broadcast(IPC_CHANNELS.risk.vetoed, { roto: true });
    ctx.broadcast('otro:canal', {});

    const page = service.list({ type: 'veto' });
    expect(page.total).toBe(2);
    expect(page.entries.map((e) => e.result)).toEqual(['reducida', 'vetada']);
    // Además del veto persistido, el renderer recibió journal:updated.
    expect(sent.filter((s) => s.channel === IPC_CHANNELS.journal.updated)).toHaveLength(2);
  });

  it('stop() deja de registrar vetos pero record() sigue disponible', () => {
    const ctx = makeCtx();
    const service = registerJournal(ctx);
    service.stop();

    ctx.broadcast(IPC_CHANNELS.risk.vetoed, vetoEvent());
    expect(service.list({ type: 'veto' }).total).toBe(0);

    service.record(input({ type: 'resumen', result: 'completado' }));
    expect(service.list({ type: 'resumen' }).total).toBe(1);
  });

  it('en E2E el handler exporta a la ruta indicada bajo userData', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const ctx = makeCtx();
    const service = registerJournal(ctx);
    service.record(input());

    const target = join(electron.userData, 'diario.csv');
    const result = (await invoke(IPC_CHANNELS.journal.exportCsv, { path: target })) as {
      canceled: boolean;
      path: string;
      entries: number;
    };
    expect(result).toEqual({ canceled: false, path: target, entries: 1 });
    expect(readFileSync(target, 'utf8').charCodeAt(0)).toBe(0xfeff);

    await expect(
      invoke(IPC_CHANNELS.journal.exportCsv, { path: '/etc/fuera.csv' }) as Promise<unknown>,
    ).rejects.toMatchObject({ code: 'ruta-no-permitida' });
  });
});
