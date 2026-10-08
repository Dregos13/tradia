import { describe, expect, it } from 'vitest';

import {
  allIpcChannels,
  IPC_CHANNELS,
  isE2eEnabled,
  isNotificationLevel,
  isNotificationPayload,
  isNotificationPrefs,
  isSettingsPatch,
  NOTIFICATION_LEVELS,
} from './ipc';

describe('contrato IPC', () => {
  it('los nombres de canal son únicos', () => {
    const channels = allIpcChannels();
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.length).toBeGreaterThan(0);
  });

  it('todos los canales usan el prefijo dominio:accion', () => {
    for (const channel of allIpcChannels()) {
      expect(channel).toMatch(/^[a-z]+:[a-z-]+$/);
    }
  });

  it('cubre los dominios de la fase: connectivity, notifications, settings, secrets y agents', () => {
    expect(Object.keys(IPC_CHANNELS).sort()).toEqual([
      'agents',
      'connectivity',
      'notifications',
      'secrets',
      'settings',
    ]);
  });

  it('secrets no expone ningún canal de lectura', () => {
    const secretChannels = Object.values(IPC_CHANNELS.secrets);
    expect(secretChannels).toHaveLength(3);
    for (const channel of secretChannels) {
      expect(channel).not.toContain('get');
    }
  });
});

describe('guardas de entrada', () => {
  it('valida niveles de notificación', () => {
    for (const level of NOTIFICATION_LEVELS) {
      expect(isNotificationLevel(level)).toBe(true);
    }
    expect(isNotificationLevel('urgente')).toBe(false);
    expect(isNotificationLevel(3)).toBe(false);
    expect(isNotificationLevel(undefined)).toBe(false);
  });

  it('valida payloads de notificación', () => {
    expect(isNotificationPayload({ level: 'info', title: 'T', body: 'b' })).toBe(true);
    expect(isNotificationPayload({ level: 'info', title: '', body: 'b' })).toBe(false);
    expect(isNotificationPayload({ level: 'info', title: 'T' })).toBe(false);
    expect(isNotificationPayload('texto')).toBe(false);
    expect(isNotificationPayload(null)).toBe(false);
  });

  it('valida preferencias de notificación', () => {
    expect(isNotificationPrefs({ info: true, alerta: false, critica: true })).toBe(true);
    expect(isNotificationPrefs({ info: 'sí', alerta: false, critica: true })).toBe(false);
    expect(isNotificationPrefs({ info: true })).toBe(false);
  });

  it('valida patches de ajustes y rechaza claves ajenas', () => {
    expect(isSettingsPatch({ autostart: true })).toBe(true);
    expect(isSettingsPatch({ disclaimerAcceptedVersion: '1.0' })).toBe(true);
    expect(isSettingsPatch({ disclaimerAcceptedAt: '2026-10-08T10:00:00Z' })).toBe(false);
    expect(isSettingsPatch({ autostart: 'sí' })).toBe(false);
    expect(isSettingsPatch({})).toBe(false);
    expect(isSettingsPatch({ autostart: true, apiKey: 'sk-...' })).toBe(false);
    expect(isSettingsPatch(null)).toBe(false);
  });
});

describe('ganchos E2E', () => {
  it('isE2eEnabled exige la variable y una ejecución no empaquetada', () => {
    expect(isE2eEnabled(false, '1')).toBe(true);
    expect(isE2eEnabled(true, '1')).toBe(false);
    expect(isE2eEnabled(false, '0')).toBe(false);
    expect(isE2eEnabled(false, 'true')).toBe(false);
    expect(isE2eEnabled(false, undefined)).toBe(false);
  });
});
