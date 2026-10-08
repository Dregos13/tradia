import type { NotificationConstructorOptions } from 'electron';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationLevel, NotificationPrefs } from '../../shared/ipc';
import {
  APP_USER_MODEL_ID,
  createNotificationsService,
  type NotificationLike,
  type NotificationsDeps,
} from './notifications';

/** Notification de Electron simulada: registra instancias y permite emitir clics. */
class FakeNotification implements NotificationLike {
  static instances: FakeNotification[] = [];
  static supported = true;
  static failOnConstruct = false;

  readonly options: NotificationConstructorOptions;
  shown = false;
  private clickListeners: Array<() => void> = [];

  constructor(options: NotificationConstructorOptions) {
    if (FakeNotification.failOnConstruct) {
      throw new Error('el sistema rechazó la notificación');
    }
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

function makeDeps(overrides: Partial<NotificationsDeps> = {}): {
  deps: NotificationsDeps;
  prefs: { current: NotificationPrefs };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  focusMainWindow: ReturnType<typeof vi.fn>;
  setAppUserModelId: ReturnType<typeof vi.fn>;
} {
  const prefs = { current: { ...ALL_ON } };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const focusMainWindow = vi.fn();
  const setAppUserModelId = vi.fn();
  const deps: NotificationsDeps = {
    Notification: FakeNotification,
    getPrefs: () => prefs.current,
    setPrefs: (next) => {
      prefs.current = { ...next };
    },
    focusMainWindow,
    platform: 'darwin',
    setAppUserModelId,
    logger,
    ...overrides,
  };
  return { deps, prefs, logger, focusMainWindow, setAppUserModelId };
}

beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
  FakeNotification.failOnConstruct = false;
});

describe('servicio de notificaciones', () => {
  it('muestra una notificación nativa con el título y el cuerpo del payload', () => {
    const { deps } = makeDeps();
    const service = createNotificationsService(deps);

    service.notify({ level: 'info', title: 'Señal de compra', body: 'AAPL supera la media' });

    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0]!;
    expect(notification.options.title).toBe('Señal de compra');
    expect(notification.options.body).toBe('AAPL supera la media');
    expect(notification.shown).toBe(true);
  });

  it('descarta los niveles desactivados en las preferencias', () => {
    const { deps, prefs, logger } = makeDeps();
    prefs.current = { info: false, alerta: true, critica: true };
    const service = createNotificationsService(deps);

    service.notify({ level: 'info', title: 'Info', body: 'descartada' });
    service.notify({ level: 'alerta', title: 'Alerta', body: 'mostrada' });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.options.title).toBe('Alerta');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("'info'"));
  });

  it('el nivel critica se muestra salvo desactivación explícita', () => {
    const { deps, prefs } = makeDeps();
    const service = createNotificationsService(deps);

    service.notify({ level: 'critica', title: 'Crítica', body: 'siempre visible' });
    expect(FakeNotification.instances).toHaveLength(1);

    service.setPrefs({ info: true, alerta: true, critica: false });
    expect(prefs.current.critica).toBe(false);

    service.notify({ level: 'critica', title: 'Crítica', body: 'filtrada' });
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('fija urgency critical en Linux solo para el nivel critica', () => {
    const { deps } = makeDeps({ platform: 'linux' });
    const service = createNotificationsService(deps);

    const levels: NotificationLevel[] = ['info', 'alerta', 'critica'];
    for (const level of levels) {
      service.notify({ level, title: level, body: '' });
    }

    expect(FakeNotification.instances[0]!.options.urgency).toBeUndefined();
    expect(FakeNotification.instances[1]!.options.urgency).toBeUndefined();
    expect(FakeNotification.instances[2]!.options.urgency).toBe('critical');
  });

  it('no fija urgency en macOS ni en Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      FakeNotification.instances = [];
      const { deps } = makeDeps({ platform });
      const service = createNotificationsService(deps);

      service.notify({ level: 'critica', title: 'Crítica', body: '' });
      expect(FakeNotification.instances[0]!.options.urgency).toBeUndefined();
    }
  });

  it('fija el AppUserModelId al crearse en Windows', () => {
    const { deps, setAppUserModelId } = makeDeps({ platform: 'win32' });
    createNotificationsService(deps);
    expect(setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID);
  });

  it('no fija AppUserModelId fuera de Windows', () => {
    const { deps, setAppUserModelId } = makeDeps({ platform: 'darwin' });
    createNotificationsService(deps);
    expect(setAppUserModelId).not.toHaveBeenCalled();
  });

  it('al hacer clic en la notificación se abre o enfoca la ventana', () => {
    const { deps, focusMainWindow } = makeDeps();
    const service = createNotificationsService(deps);

    service.notify({ level: 'info', title: 'T', body: '' });
    FakeNotification.instances[0]!.emitClick();

    expect(focusMainWindow).toHaveBeenCalledTimes(1);
  });

  it('registra en el log y no envía cuando el sistema no soporta notificaciones', () => {
    FakeNotification.supported = false;
    const { deps, logger } = makeDeps();
    const service = createNotificationsService(deps);

    service.notify({ level: 'critica', title: 'Crítica', body: 'sin soporte' });
    service.notify({ level: 'critica', title: 'Crítica', body: 'sin soporte' });

    expect(FakeNotification.instances).toHaveLength(0);
    // Solo se registra una vez para no inundar el log.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('registra el error sin propagarlo si el sistema rechaza la notificación', () => {
    FakeNotification.failOnConstruct = true;
    const { deps, logger } = makeDeps();
    const service = createNotificationsService(deps);

    expect(() => service.notify({ level: 'alerta', title: 'A', body: '' })).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("'alerta'"));
  });

  it('test envía una notificación del nivel indicado respetando preferencias', () => {
    const { deps, prefs } = makeDeps();
    const service = createNotificationsService(deps);

    service.test('alerta');
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.options.title).toContain('Prueba');

    prefs.current = { info: true, alerta: false, critica: true };
    service.test('alerta');
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('getPrefs y setPrefs leen y persisten las preferencias', () => {
    const { deps, prefs } = makeDeps();
    const service = createNotificationsService(deps);

    expect(service.getPrefs()).toEqual(ALL_ON);

    const next: NotificationPrefs = { info: false, alerta: true, critica: true };
    expect(service.setPrefs(next)).toEqual(next);
    expect(prefs.current).toEqual(next);
    expect(service.getPrefs()).toEqual(next);
  });
});
