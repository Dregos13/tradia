import { describe, expect, it } from 'vitest';

import {
  allIpcChannels,
  ALERT_LEAD_MINUTES,
  CALENDAR_EVENT_KINDS,
  IMPACT_LEVELS,
  INITIAL_UNIVERSE_TICKERS,
  IPC_CHANNELS,
  isAddSourceRequest,
  isAlertPrefs,
  isCalendarListQuery,
  isDataStatusState,
  isE2eEnabled,
  isGetBarsRequest,
  isImpactLevel,
  isIsoDate,
  isMacroSeriesQuery,
  isNewsListQuery,
  isNewsPriority,
  isNotificationLevel,
  isNotificationPayload,
  isNotificationPrefs,
  isReliability,
  isSettingsPatch,
  isSourceConnector,
  isSourceId,
  isSourceKind,
  isSourceParams,
  isSourceUrl,
  isTestSourceRequest,
  isTicker,
  isUpdateSourceRequest,
  NEWS_LIST_MAX_LIMIT,
  NEWS_PRIORITIES,
  NOTIFICATION_LEVELS,
  RELIABILITY_LEVELS,
  SOURCE_KINDS,
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

  it('cubre los dominios de la fase: connectivity, notifications, settings, secrets, agents, watchlist, market, macro, dataStatus, sources, news, calendar y alerts', () => {
    expect(Object.keys(IPC_CHANNELS).sort()).toEqual([
      'agents',
      'alerts',
      'calendar',
      'connectivity',
      'dataStatus',
      'macro',
      'market',
      'news',
      'notifications',
      'secrets',
      'settings',
      'sources',
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
      simulateProviderFailure: 'data-status:simulate-provider-failure',
      changed: 'data-status:changed',
    });
  });

  it('incluye los canales de noticias, fuentes y calendario del contrato', () => {
    expect(IPC_CHANNELS.sources).toEqual({
      list: 'sources:list',
      add: 'sources:add',
      update: 'sources:update',
      remove: 'sources:remove',
      test: 'sources:test',
    });
    expect(IPC_CHANNELS.news).toEqual({
      list: 'news:list',
      updated: 'news:updated',
      pollNow: 'news:poll-now',
      advanceClock: 'news:advance-clock',
    });
    expect(IPC_CHANNELS.calendar).toEqual({
      list: 'calendar:list',
      updated: 'calendar:updated',
    });
    expect(IPC_CHANNELS.alerts).toEqual({
      getPrefs: 'alerts:get-prefs',
      setPrefs: 'alerts:set-prefs',
      navigate: 'alerts:navigate',
    });
  });

  it('los ganchos E2E de noticias son canales marcados como solo desarrollo', () => {
    // poll-now y advance-clock los registra main únicamente sin empaquetar.
    expect(IPC_CHANNELS.news.pollNow).toBe('news:poll-now');
    expect(IPC_CHANNELS.news.advanceClock).toBe('news:advance-clock');
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

  it('valida la ruta opcional del payload de notificación', () => {
    expect(
      isNotificationPayload({ level: 'alerta', title: 'T', body: 'b', navigateTo: 'calendario' }),
    ).toBe(true);
    expect(
      isNotificationPayload({ level: 'alerta', title: 'T', body: 'b', navigateTo: 'noticias' }),
    ).toBe(true);
    expect(
      isNotificationPayload({ level: 'alerta', title: 'T', body: 'b', navigateTo: 'mercado' }),
    ).toBe(false);
    expect(isNotificationPayload({ level: 'alerta', title: 'T', body: 'b', navigateTo: 3 })).toBe(
      false,
    );
  });

  it('valida las preferencias de avisos (antelación del diseño)', () => {
    for (const leadMinutes of ALERT_LEAD_MINUTES) {
      expect(isAlertPrefs({ leadMinutes })).toBe(true);
    }
    expect(isAlertPrefs({ leadMinutes: 20 })).toBe(false);
    expect(isAlertPrefs({ leadMinutes: '30' })).toBe(false);
    expect(isAlertPrefs({ leadMinutes: 30, extra: true })).toBe(false);
    expect(isAlertPrefs({})).toBe(false);
    expect(isAlertPrefs(null)).toBe(false);
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

  it('valida los catálogos de fuentes, noticias y calendario', () => {
    for (const kind of SOURCE_KINDS) expect(isSourceKind(kind)).toBe(true);
    expect(isSourceKind('blog')).toBe(false);
    expect(isSourceKind(2)).toBe(false);

    for (const reliability of RELIABILITY_LEVELS) expect(isReliability(reliability)).toBe(true);
    expect(isReliability('anonima')).toBe(false);

    for (const priority of NEWS_PRIORITIES) expect(isNewsPriority(priority)).toBe(true);
    expect(isNewsPriority('urgente')).toBe(false);

    for (const impact of IMPACT_LEVELS) expect(isImpactLevel(impact)).toBe(true);
    expect(isImpactLevel('brutal')).toBe(false);

    expect(CALENDAR_EVENT_KINDS).toContain('fomc');
    expect(CALENDAR_EVENT_KINDS).toContain('nfp');
    expect(CALENDAR_EVENT_KINDS).toContain('vencimiento');
  });

  it('valida ids, conectores y URLs de fuente', () => {
    expect(isSourceId(1)).toBe(true);
    expect(isSourceId(0)).toBe(false);
    expect(isSourceId(-3)).toBe(false);
    expect(isSourceId(1.5)).toBe(false);
    expect(isSourceId('1')).toBe(false);

    expect(isSourceConnector('rss')).toBe(true);
    expect(isSourceConnector('sec-edgar')).toBe(true);
    expect(isSourceConnector('RSS')).toBe(false);
    expect(isSourceConnector('-rss')).toBe(false);
    expect(isSourceConnector('drop table')).toBe(false);
    expect(isSourceConnector('')).toBe(false);

    expect(isSourceUrl('https://feeds.test/rss')).toBe(true);
    expect(isSourceUrl('http://localhost:8080/feed.xml')).toBe(true);
    // Los feeds locales de las pruebas E2E.
    expect(isSourceUrl('file:///tmp/feed.xml')).toBe(true);
    expect(isSourceUrl('javascript:alert(1)')).toBe(false);
    expect(isSourceUrl('ftp://ejemplo.test/feed')).toBe(false);
    expect(isSourceUrl('no-es-una-url')).toBe(false);
    expect(isSourceUrl(42)).toBe(false);
  });

  it('valida parámetros de conector sin admitir cargas anidadas', () => {
    expect(isSourceParams({})).toBe(true);
    expect(isSourceParams({ form: '8-K', cik: '0000320193' })).toBe(true);
    expect(isSourceParams({ forms: ['8-K', '4'], activo: true })).toBe(true);
    expect(isSourceParams({ anidado: { a: 1 } })).toBe(false);
    expect(isSourceParams([1, 2])).toBe(false);
    expect(isSourceParams('form=8-K')).toBe(false);
    expect(isSourceParams(null)).toBe(false);
  });

  it('valida el alta de fuentes con URL obligatoria para feeds', () => {
    const rss = {
      name: 'Mi feed',
      kind: 'rss',
      connector: 'rss',
      url: 'https://feeds.test/rss',
      reliability: 'prensa',
    };
    expect(isAddSourceRequest(rss)).toBe(true);
    expect(isAddSourceRequest({ ...rss, intervalSeconds: 300, params: {} })).toBe(true);
    // Una fuente 'api' u 'oficial' puede ir sin URL: el conector fija el endpoint.
    expect(
      isAddSourceRequest({
        name: 'EDGAR 8-K',
        kind: 'oficial',
        connector: 'sec-edgar',
        params: { form: '8-K' },
        reliability: 'oficial',
      }),
    ).toBe(true);

    // 'rss' y 'redes' sin URL quedan rechazados.
    expect(isAddSourceRequest({ ...rss, url: undefined })).toBe(false);
    const { url: _url, ...rssSinUrl } = rss;
    expect(isAddSourceRequest(rssSinUrl)).toBe(false);
    expect(
      isAddSourceRequest({
        name: 'Reddit',
        kind: 'redes',
        connector: 'rss',
        reliability: 'redes',
      }),
    ).toBe(false);

    // Campos inválidos o claves ajenas.
    expect(isAddSourceRequest({ ...rss, kind: 'blog' })).toBe(false);
    expect(isAddSourceRequest({ ...rss, reliability: 'desconocida' })).toBe(false);
    expect(isAddSourceRequest({ ...rss, connector: 'DROP TABLE' })).toBe(false);
    expect(isAddSourceRequest({ ...rss, name: '' })).toBe(false);
    expect(isAddSourceRequest({ ...rss, url: 'javascript:alert(1)' })).toBe(false);
    expect(isAddSourceRequest({ ...rss, intervalSeconds: 5 })).toBe(false);
    expect(isAddSourceRequest({ ...rss, apiKey: 'sk-...' })).toBe(false);
    expect(isAddSourceRequest(null)).toBe(false);
    expect(isAddSourceRequest('rss')).toBe(false);
  });

  it('valida el cambio y la prueba de fuentes', () => {
    expect(isUpdateSourceRequest({ id: 1, active: false })).toBe(true);
    expect(isUpdateSourceRequest({ id: 1, name: 'Nuevo nombre' })).toBe(true);
    expect(isUpdateSourceRequest({ id: 1, intervalSeconds: 600 })).toBe(true);
    expect(isUpdateSourceRequest({ id: 1 })).toBe(false);
    expect(isUpdateSourceRequest({ id: 'x', active: true })).toBe(false);
    expect(isUpdateSourceRequest({ id: 1, active: 'sí' })).toBe(false);
    expect(isUpdateSourceRequest({ id: 1, intervalSeconds: 10 })).toBe(false);
    expect(isUpdateSourceRequest({ id: 1, apiKey: 'sk-...' })).toBe(false);

    // La prueba acepta una fuente guardada o el borrador del alta.
    expect(isTestSourceRequest({ id: 3 })).toBe(true);
    expect(isTestSourceRequest({ id: 0 })).toBe(false);
    expect(isTestSourceRequest({ id: 3, name: 'x' })).toBe(false);
    expect(
      isTestSourceRequest({
        name: 'Feed',
        kind: 'rss',
        connector: 'rss',
        url: 'https://feeds.test/rss',
        reliability: 'prensa',
      }),
    ).toBe(true);
    expect(isTestSourceRequest({ kind: 'rss' })).toBe(false);
  });

  it('valida los filtros del feed y el rango del calendario', () => {
    expect(isNewsListQuery(undefined)).toBe(true);
    expect(isNewsListQuery({})).toBe(true);
    expect(
      isNewsListQuery({
        desde: '2026-10-01',
        hasta: '2026-10-08',
        priority: 'maxima',
        reliability: 'oficial',
        ticker: 'AAPL',
        confirmed: true,
        sourceId: 2,
        limit: 50,
      }),
    ).toBe(true);
    expect(isNewsListQuery({ priority: 'urgente' })).toBe(false);
    expect(isNewsListQuery({ reliability: 'blog' })).toBe(false);
    expect(isNewsListQuery({ ticker: 'DROP TABLE' })).toBe(false);
    expect(isNewsListQuery({ confirmed: 'sí' })).toBe(false);
    expect(isNewsListQuery({ sourceId: -1 })).toBe(false);
    expect(isNewsListQuery({ limit: 0 })).toBe(false);
    expect(isNewsListQuery({ limit: NEWS_LIST_MAX_LIMIT + 1 })).toBe(false);
    expect(isNewsListQuery({ desde: '2026-10-08', hasta: '2026-10-01' })).toBe(false);
    expect(isNewsListQuery({ texto: 'fed' })).toBe(false);
    expect(isNewsListQuery(null)).toBe(false);

    expect(isCalendarListQuery({ desde: '2026-10-05', hasta: '2026-10-11' })).toBe(true);
    expect(isCalendarListQuery({ desde: '2026-10-05' })).toBe(false);
    expect(isCalendarListQuery({ desde: '2026-10-11', hasta: '2026-10-05' })).toBe(false);
    expect(isCalendarListQuery({ desde: '2026-10-05', hasta: 'mañana' })).toBe(false);
    expect(isCalendarListQuery({ desde: '2026-10-05', hasta: '2026-10-11', extra: 1 })).toBe(false);
    expect(isCalendarListQuery(undefined)).toBe(false);
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
