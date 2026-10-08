import { describe, expect, it } from 'vitest';

import {
  allIpcChannels,
  INITIAL_UNIVERSE_TICKERS,
  IPC_CHANNELS,
  isDataStatusState,
  isE2eEnabled,
  isGetBarsRequest,
  isIsoDate,
  isMacroSeriesQuery,
  isNotificationLevel,
  isNotificationPayload,
  isNotificationPrefs,
  isSettingsPatch,
  isTicker,
  NOTIFICATION_LEVELS,
  WATCHLIST_MAX_ITEMS,
} from './ipc';

describe('contrato IPC', () => {
  it('los nombres de canal son únicos', () => {
    const channels = allIpcChannels();
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.length).toBeGreaterThan(0);
  });

  it('todos los canales usan el prefijo dominio:accion', () => {
    for (const channel of allIpcChannels()) {
      expect(channel).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });

  it('cubre los dominios de la fase: connectivity, notifications, settings, secrets, agents, watchlist, market, macro y dataStatus', () => {
    expect(Object.keys(IPC_CHANNELS).sort()).toEqual([
      'agents',
      'connectivity',
      'dataStatus',
      'macro',
      'market',
      'notifications',
      'secrets',
      'settings',
      'watchlist',
    ]);
  });

  it('incluye los canales de mercado del contrato', () => {
    expect(IPC_CHANNELS.watchlist).toEqual({
      list: 'watchlist:list',
      add: 'watchlist:add',
      remove: 'watchlist:remove',
      addUniverse: 'watchlist:add-universe',
    });
    expect(IPC_CHANNELS.market).toEqual({
      getBars: 'market:get-bars',
      refreshNow: 'market:refresh-now',
      updated: 'market:updated',
      advanceClock: 'market:advance-clock',
    });
    expect(IPC_CHANNELS.macro.getSeries).toBe('macro:get-series');
    expect(IPC_CHANNELS.dataStatus).toEqual({
      get: 'data-status:get',
      changed: 'data-status:changed',
    });
  });

  it('el universo inicial cabe en el límite de la lista', () => {
    expect(INITIAL_UNIVERSE_TICKERS.length).toBeLessThanOrEqual(WATCHLIST_MAX_ITEMS);
    expect(new Set(INITIAL_UNIVERSE_TICKERS).size).toBe(INITIAL_UNIVERSE_TICKERS.length);
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

  it('valida tickers y fechas ISO reales', () => {
    expect(isTicker('AAPL')).toBe(true);
    expect(isTicker('BRK.B')).toBe(true);
    expect(isTicker('')).toBe(false);
    expect(isTicker('DROP TABLE bars;--')).toBe(false);
    expect(isTicker(42)).toBe(false);

    expect(isIsoDate('2026-10-08')).toBe(true);
    expect(isIsoDate('2020-02-30')).toBe(false);
    expect(isIsoDate('08/10/2026')).toBe(false);
    expect(isIsoDate('2026-10-08T23:15:00Z')).toBe(false);
    expect(isIsoDate(20261008)).toBe(false);
  });

  it('valida peticiones de velas con rango opcional', () => {
    expect(isGetBarsRequest({ ticker: 'AAPL' })).toBe(true);
    expect(isGetBarsRequest({ ticker: 'AAPL', desde: '2021-01-01', hasta: '2026-01-01' })).toBe(
      true,
    );
    expect(isGetBarsRequest({ ticker: 'a a' })).toBe(false);
    expect(isGetBarsRequest({ ticker: 'AAPL', desde: '2026-01-01', hasta: '2021-01-01' })).toBe(
      false,
    );
    expect(isGetBarsRequest({ ticker: 'AAPL', desde: 'ayer' })).toBe(false);
    expect(isGetBarsRequest({ ticker: 'AAPL', apiKey: 'x' })).toBe(false);
    expect(isGetBarsRequest('AAPL')).toBe(false);
  });

  it('valida la consulta macro y los estados de salud del dato', () => {
    expect(isMacroSeriesQuery(undefined)).toBe(true);
    expect(isMacroSeriesQuery({})).toBe(true);
    expect(isMacroSeriesQuery({ desde: '2024-01-01' })).toBe(true);
    expect(isMacroSeriesQuery({ desde: 'mañana' })).toBe(false);
    expect(isMacroSeriesQuery({ otra: 1 })).toBe(false);
    expect(isMacroSeriesQuery(null)).toBe(false);

    for (const state of ['fiable', 'actualizando', 'desactualizado', 'no-fiable']) {
      expect(isDataStatusState(state)).toBe(true);
    }
    expect(isDataStatusState('caido')).toBe(false);
    expect(isDataStatusState(null)).toBe(false);
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
