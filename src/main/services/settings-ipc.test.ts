import { beforeEach, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type SettingsPatch } from '../../shared/ipc';
const os = vi.hoisted(() => ({
  enabled: false,
  apply: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      os.handlers.set(channel, handler),
  },
}));
vi.mock('./tray', () => ({ readOsAutostart: () => os.enabled, applyOsAutostart: os.apply }));
import { registerSettings } from './settings';
beforeEach(() => {
  os.enabled = false;
  os.apply.mockReset();
  os.handlers.clear();
});
it('lee el SO, aplica el cambio y devuelve el estado confirmado al renderer', () => {
  const refresh = vi.fn();
  registerSettings({
    broadcast: vi.fn(),
    services: {
      tray: { refresh, isActive: () => true, isQuitting: () => false, destroy: vi.fn() },
    },
  });
  os.enabled = true;
  expect(os.handlers.get(IPC_CHANNELS.settings.get)!(null)).toMatchObject({ autostart: true });
  os.apply.mockImplementation((enabled: boolean) => {
    os.enabled = enabled;
  });
  expect(
    os.handlers.get(IPC_CHANNELS.settings.set)!(null, { autostart: false } satisfies SettingsPatch),
  ).toMatchObject({ autostart: false });
  expect(os.apply).toHaveBeenCalledWith(false);
  expect(refresh).toHaveBeenCalledOnce();
});
it('no persiste un cambio si el SO rechaza aplicarlo', () => {
  const settings = registerSettings({ broadcast: vi.fn(), services: {} });
  os.apply.mockImplementation(() => {
    throw new Error('SO');
  });
  expect(() => os.handlers.get(IPC_CHANNELS.settings.set)!(null, { autostart: true })).toThrow(
    'SO',
  );
  expect(settings.get().autostart).toBe(false);
});
