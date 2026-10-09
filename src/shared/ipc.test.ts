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
  isResumeKillSwitchRequest,
  isRiskLimits,
  isRiskVetoesQuery,
  isSeedPortfolioRequest,
  isSignalIntent,
  isSimulateCalendarEventRequest,
  isKillSwitchCause,
  isVetoReasonCode,
  isSettingsPatch,
  isSourceConnector,
  isSourceId,
  isSourceKind,
  isSourceParams,
  isSourceUrl,
  isTestSourceRequest,
  isTicker,
  isUpdateSourceRequest,
  isBacktestFinalTestRequest,
  isBacktestListQuery,
  isBacktestRunId,
  isBacktestRunRequest,
  isCreateStrategyRequest,
  isGetStrategyRequest,
  isSetStrategyStatusRequest,
  isStressRequest,
  isStrategyCosts,
  isStrategyMarkets,
  isStrategyParameterRanges,
  isStrategyPeriod,
  isStrategyStatus,
  isUpdateStrategyRequest,
  NEWS_LIST_MAX_LIMIT,
  NEWS_PRIORITIES,
  NOTIFICATION_LEVELS,
  RELIABILITY_LEVELS,
  RISK_DEFAULTS,
  RISK_VETOES_MAX_LIMIT,
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

  it('cubre los dominios de la fase: connectivity, notifications, settings, secrets, agents, watchlist, market, macro, dataStatus, sources, news, calendar, alerts, strategies, backtest, stress y risk', () => {
    expect(Object.keys(IPC_CHANNELS).sort()).toEqual([
      'agents',
      'alerts',
      'backtest',
      'calendar',
      'connectivity',
      'dataStatus',
      'macro',
      'market',
      'news',
      'notifications',
      'risk',
      'secrets',
      'settings',
      'sources',
      'strategies',
      'stress',
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

  it('incluye los canales de estrategias del contrato (fase 2)', () => {
    expect(IPC_CHANNELS.strategies).toEqual({
      list: 'strategies:list',
      get: 'strategies:get',
      create: 'strategies:create',
      update: 'strategies:update',
      setStatus: 'strategies:set-status',
      history: 'strategies:history',
    });
  });

  it('incluye los canales de backtest y de estrés del contrato (fase 2)', () => {
    expect(IPC_CHANNELS.backtest).toEqual({
      run: 'backtest:run',
      list: 'backtest:list',
      get: 'backtest:get',
      runFinalTest: 'backtest:run-final-test',
      progress: 'backtest:progress',
    });
    expect(IPC_CHANNELS.stress).toEqual({ get: 'stress:get', run: 'stress:run' });
  });

  it('incluye los canales del motor de riesgo del contrato (fase 3)', () => {
    expect(IPC_CHANNELS.risk).toEqual({
      getLimits: 'risk:get-limits',
      setLimits: 'risk:set-limits',
      listVetoes: 'risk:list-vetoes',
      submitSignal: 'risk:submit-signal',
      getKillSwitch: 'risk:get-kill-switch',
      activateKillSwitch: 'risk:activate-kill-switch',
      resumeKillSwitch: 'risk:resume-kill-switch',
      getCaution: 'risk:get-caution',
      simulateCause: 'risk:simulate-cause',
      simulateCalendarEvent: 'risk:simulate-calendar-event',
      seedPortfolio: 'risk:seed-portfolio',
      changed: 'risk:changed',
      vetoed: 'risk:vetoed',
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

  it('valida estados, periodos, costes y mercados de la ficha', () => {
    for (const status of ['investigacion', 'paper', 'activa', 'degradada', 'retirada']) {
      expect(isStrategyStatus(status)).toBe(true);
    }
    expect(isStrategyStatus('en-vivo')).toBe(false);
    expect(isStrategyStatus(null)).toBe(false);

    expect(isStrategyPeriod({ desde: '2010-01-01', hasta: '2015-12-31' })).toBe(true);
    expect(isStrategyPeriod({ desde: '2015-12-31', hasta: '2010-01-01' })).toBe(false);
    expect(isStrategyPeriod({ desde: '2020-02-30', hasta: '2020-03-01' })).toBe(false);
    expect(isStrategyPeriod({ desde: '2010-01-01' })).toBe(false);

    expect(
      isStrategyCosts({ commissionPct: 0.05, commissionMin: 1, slippageBps: 5, spreadBps: 2 }),
    ).toBe(true);
    expect(
      isStrategyCosts({ commissionPct: -1, commissionMin: 1, slippageBps: 5, spreadBps: 2 }),
    ).toBe(false);
    expect(isStrategyCosts({ commissionPct: 0.05, commissionMin: 1, slippageBps: 5 })).toBe(false);
    expect(
      isStrategyCosts({
        commissionPct: 0.05,
        commissionMin: 1,
        slippageBps: 5,
        spreadBps: 2,
        fee: 9,
      }),
    ).toBe(false);

    expect(isStrategyMarkets(['SPY', 'ETF sectoriales US'])).toBe(true);
    expect(isStrategyMarkets([])).toBe(false);
    expect(isStrategyMarkets([''])).toBe(false);
    expect(isStrategyMarkets('SPY')).toBe(false);
  });

  it('valida rangos de sensibilidad ligados a los parámetros', () => {
    const params = { fast: 50, slow: 200 };
    expect(isStrategyParameterRanges({ fast: { min: 10, max: 100, step: 5 } }, params)).toBe(true);
    // Rango de un parámetro que no existe, invertido o con paso cero.
    expect(isStrategyParameterRanges({ medium: { min: 1, max: 2, step: 1 } }, params)).toBe(false);
    expect(isStrategyParameterRanges({ fast: { min: 100, max: 10, step: 5 } }, params)).toBe(false);
    expect(isStrategyParameterRanges({ fast: { min: 10, max: 100, step: 0 } }, params)).toBe(false);
    expect(isStrategyParameterRanges({ fast: { min: 10, max: 100 } }, params)).toBe(false);
    // Sin `parameters` de referencia solo se valida la forma.
    expect(isStrategyParameterRanges({ cualquiera: { min: 1, max: 2, step: 1 } })).toBe(true);
  });

  it('valida el alta y la edición de estrategias', () => {
    const draft = {
      name: 'Cruce de medias 50/200',
      hypothesis: 'La tendencia persiste.',
      rules: { entry: 'e', exit: 's', stop: 'st', target: 't' },
      parameters: { fast: 50, slow: 200 },
      markets: ['SPY'],
      regime: 'tendencial',
    };
    expect(isCreateStrategyRequest(draft)).toBe(true);
    expect(
      isCreateStrategyRequest({
        ...draft,
        note: 'Alta inicial',
        parameterRanges: { fast: { min: 10, max: 100, step: 10 } },
        trainingPeriod: { desde: '2005-01-01', hasta: '2015-12-31' },
        assumedCosts: { commissionPct: 0.05, commissionMin: 1, slippageBps: 5, spreadBps: 2 },
      }),
    ).toBe(true);

    // Campos obligatorios que faltan, inválidos o claves ajenas.
    expect(isCreateStrategyRequest({ ...draft, name: '' })).toBe(false);
    expect(
      isCreateStrategyRequest({ ...draft, rules: { entry: 'e', exit: 's', stop: 'st' } }),
    ).toBe(false);
    expect(isCreateStrategyRequest({ ...draft, markets: [] })).toBe(false);
    expect(isCreateStrategyRequest({ ...draft, apiKey: 'sk-...' })).toBe(false);
    expect(isCreateStrategyRequest({ ...draft, note: '' })).toBe(false);
    expect(isCreateStrategyRequest(null)).toBe(false);

    // La edición exige id, nota y al menos un campo versionable.
    expect(isUpdateStrategyRequest({ id: 1, note: 'cambio', parameters: { fast: 40 } })).toBe(true);
    expect(isUpdateStrategyRequest({ id: 1, note: 'cambio' })).toBe(false);
    expect(isUpdateStrategyRequest({ id: 1, parameters: { fast: 40 } })).toBe(false);
    expect(isUpdateStrategyRequest({ id: 'x', note: 'cambio', name: 'y' })).toBe(false);
    expect(isUpdateStrategyRequest({ id: 1, note: 'cambio', metricsSummary: {} })).toBe(false);
  });

  it('valida la consulta de ficha y el cambio de estado', () => {
    expect(isGetStrategyRequest({ id: 1 })).toBe(true);
    expect(isGetStrategyRequest({ id: 1, version: 2 })).toBe(true);
    expect(isGetStrategyRequest({ id: 1, version: 0 })).toBe(false);
    expect(isGetStrategyRequest({ id: -1 })).toBe(false);
    expect(isGetStrategyRequest({ id: 1, truco: true })).toBe(false);
    expect(isGetStrategyRequest(1)).toBe(false);

    expect(isSetStrategyStatusRequest({ id: 1, status: 'paper' })).toBe(true);
    expect(isSetStrategyStatusRequest({ id: 1, status: 'retirada', note: 'motivo' })).toBe(true);
    expect(isSetStrategyStatusRequest({ id: 1, status: 'en-vivo' })).toBe(false);
    expect(isSetStrategyStatusRequest({ id: 1 })).toBe(false);
    expect(isSetStrategyStatusRequest({ id: 1, status: 'paper', note: '' })).toBe(false);
  });
});

describe('guardas del backtest y del estrés', () => {
  it('valida la petición de ejecución: campos, periodo y límites', () => {
    expect(isBacktestRunRequest({ strategyId: 1 })).toBe(true);
    expect(
      isBacktestRunRequest({
        strategyId: 2,
        version: 3,
        desde: '2020-01-01',
        hasta: '2024-12-31',
        universe: ['SPY', 'QQQ'],
        initialCash: 25_000,
        riskPerTrade: 0.01,
        maxPositions: 5,
        costs: { commissionPct: 0.1, slippageBps: 10 },
        params: { fastPeriod: 30 },
        split: { train: 0.6, validation: 0.2, test: 0.2 },
        walkForward: { trainSize: 100, testSize: 40, objective: 'sharpe' },
        sensitivity: { xParam: 'fastPeriod', yParam: 'slowPeriod' },
        monteCarlo: { seed: 7, simulations: 500, method: 'bootstrap' },
      }),
    ).toBe(true);
    expect(
      isBacktestRunRequest({
        strategyId: 1,
        walkForward: false,
        sensitivity: false,
        monteCarlo: false,
      }),
    ).toBe(true);

    expect(isBacktestRunRequest({})).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 0 })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, truco: true })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, desde: '2024-01-01', hasta: '2020-01-01' })).toBe(
      false,
    );
    expect(isBacktestRunRequest({ strategyId: 1, universe: [] })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, universe: ['no es ticker'] })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, initialCash: 0 })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, riskPerTrade: 0.5 })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, maxPositions: 0 })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, costs: { commissionPct: -1 } })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, split: { train: 1.5 } })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, monteCarlo: { simulations: 0 } })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, monteCarlo: { method: 'azar' } })).toBe(false);
    expect(isBacktestRunRequest({ strategyId: 1, walkForward: { trainSize: 2.5 } })).toBe(false);
    expect(
      isBacktestRunRequest({ strategyId: 1, walkForward: { objective: 'rentabilidad' } }),
    ).toBe(false);
  });

  it('valida la lista, la ficha de ejecución, la prueba final y el estrés', () => {
    expect(isBacktestListQuery(undefined)).toBe(true);
    expect(isBacktestListQuery({})).toBe(true);
    expect(isBacktestListQuery({ strategyId: 1, version: 2, limit: 50 })).toBe(true);
    expect(isBacktestListQuery({ limit: 0 })).toBe(false);
    expect(isBacktestListQuery({ limit: 501 })).toBe(false);
    expect(isBacktestListQuery({ strategyId: 'x' })).toBe(false);
    expect(isBacktestListQuery(null)).toBe(false);

    expect(isBacktestRunId(1)).toBe(true);
    expect(isBacktestRunId(0)).toBe(false);
    expect(isBacktestRunId(1.5)).toBe(false);
    expect(isBacktestRunId('1')).toBe(false);

    expect(isBacktestFinalTestRequest({ strategyId: 1 })).toBe(true);
    expect(isBacktestFinalTestRequest({ strategyId: 1, version: 2 })).toBe(true);
    expect(isBacktestFinalTestRequest({ strategyId: 1, version: 0 })).toBe(false);
    expect(isBacktestFinalTestRequest({})).toBe(false);

    expect(isStressRequest({ strategyId: 1 })).toBe(true);
    expect(isStressRequest({ strategyId: 1, version: 2 })).toBe(true);
    expect(isStressRequest({ strategyId: -1 })).toBe(false);
    expect(isStressRequest({ strategyId: 1, crisis: '2008' })).toBe(false);
  });
});

describe('guardas del motor de riesgo (fase 3)', () => {
  const senal = {
    ticker: 'AAPL',
    direction: 'largo',
    entry: 200,
    stop: 190,
    target: 220,
    confidence: 0.8,
    origin: 'estrategia',
  };

  it('valida la forma de la señal sin rechazar las anomalías del motor', () => {
    expect(isSignalIntent(senal)).toBe(true);
    // Sin stop ni objetivo: la forma es válida; el veto lo decide el motor.
    expect(isSignalIntent({ ...senal, stop: null, target: null })).toBe(true);
    // La confianza fuera de 0–1 llega al motor (modelo errático), no se rechaza.
    expect(isSignalIntent({ ...senal, confidence: 1.7 })).toBe(true);
    expect(isSignalIntent({ ...senal, direction: 'corto', origin: 'probador' })).toBe(true);
    expect(isSignalIntent({ ...senal, origin: 'e2e' })).toBe(true);

    expect(isSignalIntent({ ...senal, ticker: 'DROP TABLE' })).toBe(false);
    expect(isSignalIntent({ ...senal, direction: 'compra' })).toBe(false);
    expect(isSignalIntent({ ...senal, entry: 0 })).toBe(false);
    expect(isSignalIntent({ ...senal, entry: -5 })).toBe(false);
    expect(isSignalIntent({ ...senal, stop: -1 })).toBe(false);
    expect(isSignalIntent({ ...senal, confidence: 'alta' })).toBe(false);
    expect(isSignalIntent({ ...senal, confidence: Number.NaN })).toBe(false);
    expect(isSignalIntent({ ...senal, origin: 'usuario' })).toBe(false);
    expect(isSignalIntent({ ...senal, apiKey: 'x' })).toBe(false);
    expect(isSignalIntent({ ticker: 'AAPL' })).toBe(false);
    expect(isSignalIntent(null)).toBe(false);
  });

  it('exige los límites completos dentro de los márgenes duros', () => {
    expect(isRiskLimits({ ...RISK_DEFAULTS })).toBe(true);
    expect(isRiskLimits({ ...RISK_DEFAULTS, riskPerTradePct: 2 })).toBe(true);
    expect(isRiskLimits({ ...RISK_DEFAULTS, riskPerTradePct: 0.5 })).toBe(true);
    // Los ejemplos de los criterios: 3 % por operación y ratio 1:1,5.
    expect(isRiskLimits({ ...RISK_DEFAULTS, riskPerTradePct: 3 })).toBe(false);
    expect(isRiskLimits({ ...RISK_DEFAULTS, riskPerTradePct: 0.4 })).toBe(false);
    expect(isRiskLimits({ ...RISK_DEFAULTS, minRewardRiskRatio: 1.5 })).toBe(false);
    // Apalancamiento fijo 1x.
    expect(isRiskLimits({ ...RISK_DEFAULTS, maxLeverage: 2 })).toBe(false);
    // Objeto incompleto, claves ajenas y no números.
    const { maxLeverage: _omitido, ...incompletos } = RISK_DEFAULTS;
    expect(isRiskLimits(incompletos)).toBe(false);
    expect(isRiskLimits({ ...RISK_DEFAULTS, truco: 1 })).toBe(false);
    expect(isRiskLimits({ ...RISK_DEFAULTS, maxOpenPositions: '5' })).toBe(false);
    expect(isRiskLimits({ ...RISK_DEFAULTS, maxDrawdownPct: Number.NaN })).toBe(false);
    expect(isRiskLimits(null)).toBe(false);
  });

  it('valida la consulta del registro de vetos', () => {
    expect(isRiskVetoesQuery(undefined)).toBe(true);
    expect(isRiskVetoesQuery({})).toBe(true);
    expect(
      isRiskVetoesQuery({
        rule: 'RR_TOO_LOW',
        decision: 'vetada',
        ticker: 'AAPL',
        limit: 50,
        offset: 10,
      }),
    ).toBe(true);
    expect(isRiskVetoesQuery({ rule: 'TODO_MAL' })).toBe(false);
    expect(isRiskVetoesQuery({ decision: 'aprobada' })).toBe(false);
    expect(isRiskVetoesQuery({ ticker: 'no ticker' })).toBe(false);
    expect(isRiskVetoesQuery({ limit: 0 })).toBe(false);
    expect(isRiskVetoesQuery({ limit: RISK_VETOES_MAX_LIMIT + 1 })).toBe(false);
    expect(isRiskVetoesQuery({ offset: -1 })).toBe(false);
    expect(isRiskVetoesQuery({ offset: 1.5 })).toBe(false);
    expect(isRiskVetoesQuery({ extra: 1 })).toBe(false);
    expect(isRiskVetoesQuery(null)).toBe(false);
  });

  it('la reanudación de la parada exige una confirmación explícita', () => {
    expect(isResumeKillSwitchRequest({ confirm: true })).toBe(true);
    expect(isResumeKillSwitchRequest({ confirm: true, note: 'Revisado' })).toBe(true);
    expect(isResumeKillSwitchRequest({ confirm: false })).toBe(false);
    expect(isResumeKillSwitchRequest({})).toBe(false);
    expect(isResumeKillSwitchRequest({ confirm: 'true' })).toBe(false);
    expect(isResumeKillSwitchRequest({ confirm: true, note: ' ' })).toBe(false);
    expect(isResumeKillSwitchRequest({ confirm: true, forzar: 1 })).toBe(false);
    expect(isResumeKillSwitchRequest(null)).toBe(false);
  });

  it('valida los ganchos E2E de la parada, el calendario y la cartera', () => {
    for (const cause of [
      'manual',
      'perdida-anomala',
      'dato-anomalo',
      'sin-conexion',
      'modelo-erratico',
    ] as const) {
      expect(isKillSwitchCause(cause)).toBe(true);
    }
    expect(isKillSwitchCause('bug')).toBe(false);
    expect(isKillSwitchCause(null)).toBe(false);

    const evento = {
      kind: 'ipc',
      title: 'IPC de EE. UU. (mensual)',
      dateUtc: '2026-10-09T12:30:00.000Z',
      impact: 'alto',
    };
    expect(isSimulateCalendarEventRequest(evento)).toBe(true);
    expect(isSimulateCalendarEventRequest({ ...evento, asset: 'AAPL' })).toBe(true);
    expect(isSimulateCalendarEventRequest({ ...evento, kind: 'fiesta' })).toBe(false);
    expect(isSimulateCalendarEventRequest({ ...evento, title: '' })).toBe(false);
    expect(isSimulateCalendarEventRequest({ ...evento, dateUtc: '2026-10-09' })).toBe(false);
    expect(isSimulateCalendarEventRequest({ ...evento, dateUtc: 'no-fecha' })).toBe(false);
    expect(isSimulateCalendarEventRequest({ ...evento, impact: 'brutal' })).toBe(false);
    expect(isSimulateCalendarEventRequest({ ...evento, asset: 'no ticker' })).toBe(false);
    expect(isSimulateCalendarEventRequest(null)).toBe(false);

    expect(isVetoReasonCode('STOP_MISSING')).toBe(true);
    expect(isVetoReasonCode('CAUTION_MODE')).toBe(true);
    expect(isVetoReasonCode('TODO_MAL')).toBe(false);
  });

  it('valida la siembra de la cartera simulada', () => {
    expect(isSeedPortfolioRequest({})).toBe(true);
    expect(isSeedPortfolioRequest({ equity: 100_000 })).toBe(true);
    expect(
      isSeedPortfolioRequest({
        equity: 100_000,
        positions: [
          { ticker: 'AAPL', direction: 'largo', entry: 200, size: 10, sector: 'tecnologia' },
          { ticker: 'MSFT', direction: 'corto', entry: 400, size: 5, currency: 'USD' },
        ],
        equityHistory: [
          { at: '2026-10-08T20:00:00.000Z', equity: 100_000 },
          { at: '2026-10-09T20:00:00.000Z', equity: 98_000 },
        ],
      }),
    ).toBe(true);

    expect(isSeedPortfolioRequest({ equity: 0 })).toBe(false);
    expect(isSeedPortfolioRequest({ equity: -1 })).toBe(false);
    expect(
      isSeedPortfolioRequest({
        positions: [{ ticker: 'AAPL', direction: 'compra', entry: 1, size: 1 }],
      }),
    ).toBe(false);
    expect(
      isSeedPortfolioRequest({
        positions: [{ ticker: 'AAPL', direction: 'largo', entry: 0, size: 1 }],
      }),
    ).toBe(false);
    expect(
      isSeedPortfolioRequest({
        positions: [{ ticker: 'AAPL', direction: 'largo', entry: 1, size: -1 }],
      }),
    ).toBe(false);
    expect(
      isSeedPortfolioRequest({
        positions: [{ ticker: 'AAPL', direction: 'largo', entry: 1, size: 1, currency: 'us' }],
      }),
    ).toBe(false);
    expect(isSeedPortfolioRequest({ equityHistory: [{ at: 'ayer', equity: 100 }] })).toBe(false);
    expect(
      isSeedPortfolioRequest({ equityHistory: [{ at: '2026-10-09T00:00:00.000Z', equity: 0 }] }),
    ).toBe(false);
    expect(isSeedPortfolioRequest({ extra: 1 })).toBe(false);
    expect(isSeedPortfolioRequest(null)).toBe(false);
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
