import { describe, expect, it } from 'vitest';

import {
  allIpcChannels,
  ALERT_LEAD_MINUTES,
  BACKUP_FILE_PATTERN,
  BROKER_ORDER_MODES,
  CALENDAR_EVENT_KINDS,
  DATA_PROVIDER_IDS,
  DELIVERY_EVENT_KINDS,
  IMPACT_LEVELS,
  INITIAL_UNIVERSE_TICKERS,
  IPC_CHANNELS,
  isAddSourceRequest,
  isAlertPrefs,
  isBackupFileName,
  isBackupRestoreRequest,
  isBrokerConnectRequest,
  isBrokerDiscrepancyRequest,
  isBrokerFailNextRequest,
  isBrokerOrderMode,
  isBrokerOrdersQuery,
  isBrokerSeedWeeksRequest,
  isBrokerTestRequest,
  isCalendarListQuery,
  isCancelOrderRequest,
  isCreateOrderRequest,
  isDeviationReportQuery,
  isDataStatusState,
  isDeliveryConfigInput,
  isDeliveryEventKind,
  isDeliveryTestRequest,
  isE2eEnabled,
  isGetBarsRequest,
  isImpactLevel,
  isIsoDate,
  isJournalEntryId,
  isJournalEntryType,
  isJournalExportRequest,
  isJournalListQuery,
  isJournalResult,
  isMacroSeriesQuery,
  isNewsListQuery,
  isNewsPriority,
  isNotificationLevel,
  isNotificationPayload,
  isNotificationPrefs,
  isNotificationRoute,
  isReliability,
  isResumeKillSwitchRequest,
  isRiskDecisionStatus,
  isRiskLimits,
  isRiskVetoesQuery,
  isRoutineConfig,
  isSeedPortfolioRequest,
  isSignalId,
  isSignalIntent,
  isSignalsListQuery,
  isSimulateCalendarEventRequest,
  isKillSwitchCause,
  isLiveActivateRequest,
  isLiveConnectRequest,
  isLiveDeclareRequest,
  isLiveLimitsInput,
  isLiveSeedProgressRequest,
  isLiveSimulatedBrokerRequest,
  isLiveSmokeTestRequest,
  isNewsAnalysisQuery,
  isNewsAnalyzer,
  isNewsLlmSettingsInput,
  isPredictionsQuery,
  isProviderSimulateTestRequest,
  isProviderTestRequest,
  isProviderTestStatus,
  isRegimeComparisonRequest,
  isRegimeLabelList,
  isRetrainResolveRequest,
  isSignalAiContext,
  isSimulateDriftRequest,
  isSimulateRegimeRequest,
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
  JOURNAL_ENTRY_TYPES,
  JOURNAL_LIST_MAX_LIMIT,
  NEWS_ANALYZERS,
  NEWS_LIST_MAX_LIMIT,
  NEWS_PRIORITIES,
  NOTIFICATION_LEVELS,
  ONBOARDING_TOUR_VERSION,
  RELIABILITY_LEVELS,
  RISK_DEFAULTS,
  RISK_VETOES_MAX_LIMIT,
  ROUTINE_DEFAULTS,
  SIGNALS_LIST_MAX_LIMIT,
  SOURCE_KINDS,
  WATCHLIST_MAX_ITEMS,
} from './ipc';
import type { ProviderTestResult } from './ipc';

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

  it('cubre los dominios de la fase: connectivity, notifications, settings, secrets, agents, watchlist, market, macro, dataStatus, sources, news, calendar, alerts, strategies, backtest, stress, risk, signals, journal, delivery, routine, backup, broker, orders, providers, reconcile, deviation, logs, ai y live', () => {
    expect(Object.keys(IPC_CHANNELS).sort()).toEqual([
      'agents',
      'ai',
      'alerts',
      'backtest',
      'backup',
      'broker',
      'calendar',
      'connectivity',
      'dataStatus',
      'delivery',
      'deviation',
      'journal',
      'live',
      'logs',
      'macro',
      'market',
      'news',
      'notifications',
      'orders',
      'providers',
      'reconcile',
      'risk',
      'routine',
      'secrets',
      'settings',
      'signals',
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
      coverage: 'watchlist:coverage',
      addUniverse: 'watchlist:add-universe',
    });
    expect(IPC_CHANNELS.market).toEqual({
      getBars: 'market:get-bars',
      refreshNow: 'market:refresh-now',
      updated: 'market:updated',
      advanceClock: 'market:advance-clock',
    });
    expect(IPC_CHANNELS.macro).toEqual({
      getSeries: 'macro:get-series',
      refreshNow: 'macro:refresh-now',
    });
    expect(IPC_CHANNELS.dataStatus).toEqual({
      get: 'data-status:get',
      freshness: 'data-status:freshness',
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
      regimeComparison: 'backtest:regime-comparison',
      runRegimeComparison: 'backtest:run-regime-comparison',
    });
    expect(IPC_CHANNELS.stress).toEqual({ get: 'stress:get', run: 'stress:run' });
  });

  it('incluye los canales del motor de riesgo del contrato (fase 3)', () => {
    expect(IPC_CHANNELS.risk).toEqual({
      getLimits: 'risk:get-limits',
      setLimits: 'risk:set-limits',
      listVetoes: 'risk:list-vetoes',
      submitSignal: 'risk:submit-signal',
      getPortfolio: 'risk:get-portfolio',
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

  it('incluye los canales de la fase 4: señales, diario, canales, rutina, copias y registros', () => {
    expect(IPC_CHANNELS.signals).toEqual({
      list: 'signals:list',
      get: 'signals:get',
      strategies: 'signals:strategies',
      evaluateNow: 'signals:evaluate-now',
      new: 'signals:new',
    });
    expect(IPC_CHANNELS.journal).toEqual({
      list: 'journal:list',
      get: 'journal:get',
      exportCsv: 'journal:export-csv',
      updated: 'journal:updated',
    });
    expect(IPC_CHANNELS.delivery).toEqual({
      getConfig: 'delivery:get-config',
      setConfig: 'delivery:set-config',
      test: 'delivery:test',
    });
    expect(IPC_CHANNELS.routine).toEqual({
      getConfig: 'routine:get-config',
      setConfig: 'routine:set-config',
      advanceClock: 'routine:advance-clock',
    });
    expect(IPC_CHANNELS.backup).toEqual({
      list: 'backup:list',
      create: 'backup:create',
      restore: 'backup:restore',
    });
    expect(IPC_CHANNELS.logs).toEqual({ openFolder: 'logs:open-folder' });
  });

  it('los ganchos E2E de la fase 4 son canales marcados como solo desarrollo', () => {
    expect(IPC_CHANNELS.signals.evaluateNow).toBe('signals:evaluate-now');
    expect(IPC_CHANNELS.routine.advanceClock).toBe('routine:advance-clock');
  });

  it('incluye los canales del broker paper, órdenes, conciliación y desviación (fase 5)', () => {
    expect(IPC_CHANNELS.broker).toEqual({
      connect: 'broker:connect',
      disconnect: 'broker:disconnect',
      status: 'broker:status',
      test: 'broker:test',
      failNext: 'broker:fail-next',
      createDiscrepancy: 'broker:create-discrepancy',
      seedWeeks: 'broker:seed-weeks',
      orderUpdated: 'broker:order-updated',
    });
    expect(IPC_CHANNELS.orders).toEqual({
      list: 'orders:list',
      create: 'orders:create',
      cancel: 'orders:cancel',
    });
    expect(IPC_CHANNELS.reconcile).toEqual({
      run: 'reconcile:run',
      status: 'reconcile:status',
      discrepancy: 'reconcile:discrepancy',
    });
    expect(IPC_CHANNELS.deviation).toEqual({
      report: 'deviation:report',
    });
    // Los ganchos del broker simulado también son solo desarrollo.
    expect(IPC_CHANNELS.broker.failNext).toBe('broker:fail-next');
    expect(IPC_CHANNELS.broker.createDiscrepancy).toBe('broker:create-discrepancy');
    expect(IPC_CHANNELS.broker.seedWeeks).toBe('broker:seed-weeks');
  });

  it('incluye los canales de la IA predictiva y del modo real (fases 6-7)', () => {
    expect(IPC_CHANNELS.ai).toEqual({
      regimeOverview: 'ai:regime-overview',
      predictions: 'ai:predictions',
      modelCard: 'ai:model-card',
      newsAnalysis: 'ai:news-analysis',
      newsStatus: 'ai:news-status',
      newsStatusChanged: 'ai:news-status-changed',
      getLlmSettings: 'ai:get-llm-settings',
      setLlmSettings: 'ai:set-llm-settings',
      testLlm: 'ai:test-llm',
      health: 'ai:health',
      retrainProposals: 'ai:retrain-proposals',
      resolveRetrain: 'ai:resolve-retrain',
      changed: 'ai:changed',
      simulateRegime: 'ai:simulate-regime',
      simulateDrift: 'ai:simulate-drift',
    });
    expect(IPC_CHANNELS.live).toEqual({
      checklist: 'live:checklist',
      state: 'live:state',
      declare: 'live:declare',
      setLimits: 'live:set-limits',
      connect: 'live:connect',
      activate: 'live:activate',
      deactivate: 'live:deactivate',
      testKillSwitch: 'live:test-kill-switch',
      smokeTest: 'live:smoke-test',
      scaling: 'live:scaling',
      changed: 'live:changed',
      seedProgress: 'live:seed-progress',
      useSimulatedBroker: 'live:use-simulated-broker',
    });
    expect(IPC_CHANNELS.backtest.regimeComparison).toBe('backtest:regime-comparison');
    expect(IPC_CHANNELS.backtest.runRegimeComparison).toBe('backtest:run-regime-comparison');
  });

  it('los ganchos E2E de las fases 6-7 son canales marcados como solo desarrollo', () => {
    expect(IPC_CHANNELS.ai.simulateRegime).toBe('ai:simulate-regime');
    expect(IPC_CHANNELS.ai.simulateDrift).toBe('ai:simulate-drift');
    expect(IPC_CHANNELS.live.seedProgress).toBe('live:seed-progress');
    expect(IPC_CHANNELS.live.useSimulatedBroker).toBe('live:use-simulated-broker');
  });

  it('el universo inicial cabe en el límite de la lista', () => {
    expect(INITIAL_UNIVERSE_TICKERS.length).toBeLessThanOrEqual(WATCHLIST_MAX_ITEMS);
    expect(new Set(INITIAL_UNIVERSE_TICKERS).size).toBe(INITIAL_UNIVERSE_TICKERS.length);
  });

  it('secrets no expone ningún canal de lectura', () => {
    const secretChannels = Object.values(IPC_CHANNELS.secrets);
    expect(secretChannels).toHaveLength(4);
    // secrets:changed solo notifica el nombre del proveedor, nunca lee claves.
    expect(secretChannels).toEqual([
      'secrets:set-key',
      'secrets:has-key',
      'secrets:delete-key',
      'secrets:changed',
    ]);
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
    expect(isSettingsPatch({ brokerExecutionEnabled: false })).toBe(true);
    expect(isSettingsPatch({ deviationMarginPp: 2 })).toBe(true);
    expect(isSettingsPatch({ deviationSlippageBps: 10 })).toBe(true);
    expect(isSettingsPatch({ disclaimerAcceptedAt: '2026-10-08T10:00:00Z' })).toBe(false);
    expect(isSettingsPatch({ autostart: 'sí' })).toBe(false);
    expect(isSettingsPatch({ brokerExecutionEnabled: 'sí' })).toBe(false);
    expect(isSettingsPatch({ deviationMarginPp: 0 })).toBe(false);
    expect(isSettingsPatch({ deviationMarginPp: 500 })).toBe(false);
    expect(isSettingsPatch({ deviationSlippageBps: 0 })).toBe(false);
    expect(isSettingsPatch({ deviationSlippageBps: 10_000 })).toBe(false);
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

describe('guardas de señales, diario y operativa (fase 4)', () => {
  it('valida la consulta de señales con filtros combinables', () => {
    expect(isSignalsListQuery(undefined)).toBe(true);
    expect(isSignalsListQuery({})).toBe(true);
    expect(
      isSignalsListQuery({
        ticker: 'AAPL',
        decision: 'vetada',
        strategyId: 3,
        desde: '2026-10-01',
        hasta: '2026-10-09',
        limit: 50,
        offset: 10,
      }),
    ).toBe(true);
    expect(isSignalsListQuery({ decision: 'pendiente' })).toBe(false);
    expect(isSignalsListQuery({ ticker: 'no ticker' })).toBe(false);
    expect(isSignalsListQuery({ strategyId: 'x' })).toBe(false);
    expect(isSignalsListQuery({ desde: '2026-10-09', hasta: '2026-10-01' })).toBe(false);
    expect(isSignalsListQuery({ limit: 0 })).toBe(false);
    expect(isSignalsListQuery({ limit: SIGNALS_LIST_MAX_LIMIT + 1 })).toBe(false);
    expect(isSignalsListQuery({ offset: -1 })).toBe(false);
    expect(isSignalsListQuery({ extra: 1 })).toBe(false);
    expect(isSignalsListQuery(null)).toBe(false);

    for (const status of ['aprobada', 'reducida', 'vetada'] as const) {
      expect(isRiskDecisionStatus(status)).toBe(true);
    }
    expect(isRiskDecisionStatus('cancelada')).toBe(false);
    expect(isSignalId(1)).toBe(true);
    expect(isSignalId(0)).toBe(false);
    expect(isSignalId('1')).toBe(false);
  });

  it('valida la consulta y la exportación del diario', () => {
    for (const type of JOURNAL_ENTRY_TYPES) {
      expect(isJournalEntryType(type)).toBe(true);
    }
    expect(isJournalEntryType('aviso')).toBe(false);
    expect(isJournalResult('ganancia')).toBe(true);
    expect(isJournalResult('con-retraso')).toBe(true);
    expect(isJournalResult('quizas')).toBe(false);

    expect(isJournalListQuery(undefined)).toBe(true);
    expect(
      isJournalListQuery({
        desde: '2026-10-01',
        hasta: '2026-10-09',
        type: 'senal',
        ticker: 'AAPL',
        strategyId: 2,
        result: 'vetada',
        limit: 100,
        offset: 50,
      }),
    ).toBe(true);
    expect(isJournalListQuery({ type: 'aviso' })).toBe(false);
    expect(isJournalListQuery({ result: 'quizas' })).toBe(false);
    expect(isJournalListQuery({ ticker: 'DROP TABLE' })).toBe(false);
    expect(isJournalListQuery({ limit: JOURNAL_LIST_MAX_LIMIT + 1 })).toBe(false);
    expect(isJournalListQuery({ desde: '2026-10-09', hasta: '2026-10-01' })).toBe(false);
    expect(isJournalListQuery({ extra: 1 })).toBe(false);
    expect(isJournalEntryId(7)).toBe(true);
    expect(isJournalEntryId(-1)).toBe(false);

    // La exportación acepta el conjunto filtrado y, solo en E2E, una ruta.
    expect(isJournalExportRequest(undefined)).toBe(true);
    expect(isJournalExportRequest({})).toBe(true);
    expect(isJournalExportRequest({ query: { type: 'senal' } })).toBe(true);
    expect(isJournalExportRequest({ path: '/tmp/diario.csv' })).toBe(true);
    expect(isJournalExportRequest({ path: 'C:\\tmp\\diario.csv' })).toBe(true);
    expect(isJournalExportRequest({ path: 'relativo.csv' })).toBe(false);
    expect(isJournalExportRequest({ path: '/tmp/../etc/passwd' })).toBe(false);
    expect(isJournalExportRequest({ query: { type: 'aviso' } })).toBe(false);
    expect(isJournalExportRequest({ extra: 1 })).toBe(false);
    expect(isJournalExportRequest(null)).toBe(false);
  });

  it('valida la configuración de canales sin admitir secretos inline', () => {
    for (const kind of DELIVERY_EVENT_KINDS) {
      expect(isDeliveryEventKind(kind)).toBe(true);
    }
    expect(isDeliveryEventKind('todo')).toBe(false);

    const off = {
      telegram: { enabled: false, chatId: '', events: [] },
      email: {
        enabled: false,
        host: '',
        port: 587,
        security: 'starttls',
        user: '',
        to: '',
        events: ['senal-aprobada'],
      },
    };
    expect(isDeliveryConfigInput(off)).toBe(true);

    const on = {
      telegram: {
        enabled: true,
        chatId: '123456789',
        events: ['senal-aprobada', 'resumen-diario'],
      },
      email: {
        enabled: true,
        host: 'smtp.example.com',
        port: 465,
        security: 'tls',
        user: 'tradia@example.com',
        to: 'usuario@example.com',
        events: [...DELIVERY_EVENT_KINDS],
      },
    };
    expect(isDeliveryConfigInput(on)).toBe(true);

    // Activado sin los campos requeridos queda rechazado.
    expect(isDeliveryConfigInput({ ...on, telegram: { ...on.telegram, chatId: '' } })).toBe(false);
    expect(isDeliveryConfigInput({ ...on, email: { ...on.email, host: '' } })).toBe(false);
    expect(isDeliveryConfigInput({ ...on, email: { ...on.email, to: 'no-correo' } })).toBe(false);
    expect(isDeliveryConfigInput({ ...on, email: { ...on.email, port: 0 } })).toBe(false);
    expect(isDeliveryConfigInput({ ...on, email: { ...on.email, security: 'ssl3' } })).toBe(false);
    // Eventos desconocidos o duplicados.
    expect(
      isDeliveryConfigInput({
        ...on,
        telegram: { ...on.telegram, events: ['senal-aprobada', 'senal-aprobada'] },
      }),
    ).toBe(false);
    expect(isDeliveryConfigInput({ ...on, telegram: { ...on.telegram, events: ['otro'] } })).toBe(
      false,
    );
    // Los secretos nunca viajan en la configuración.
    expect(isDeliveryConfigInput({ ...on, telegram: { ...on.telegram, token: '123:abc' } })).toBe(
      false,
    );
    expect(isDeliveryConfigInput({ ...on, email: { ...on.email, password: 'secreto' } })).toBe(
      false,
    );
    expect(isDeliveryConfigInput(null)).toBe(false);
    expect(isDeliveryConfigInput({ telegram: on.telegram })).toBe(false);
  });

  it('valida la prueba de canal y los horarios de la rutina', () => {
    expect(isDeliveryTestRequest({ channel: 'telegram' })).toBe(true);
    expect(isDeliveryTestRequest({ channel: 'correo' })).toBe(true);
    expect(isDeliveryTestRequest({ channel: 'escritorio' })).toBe(false);
    expect(isDeliveryTestRequest({})).toBe(false);
    expect(isDeliveryTestRequest({ channel: 'telegram', extra: 1 })).toBe(false);

    expect(isRoutineConfig(ROUTINE_DEFAULTS)).toBe(true);
    expect(isRoutineConfig({ preapertura: '08:30', cierre: '16:15', conciliacion: '17:30' })).toBe(
      true,
    );
    expect(isRoutineConfig({ preapertura: '8:30', cierre: '16:15', conciliacion: '17:30' })).toBe(
      false,
    );
    expect(isRoutineConfig({ preapertura: '24:00', cierre: '16:15', conciliacion: '17:30' })).toBe(
      false,
    );
    expect(isRoutineConfig({ preapertura: '08:30', cierre: '16:15' })).toBe(false);
    expect(isRoutineConfig({ ...ROUTINE_DEFAULTS, timezone: 'Europe/Madrid' })).toBe(false);
    expect(isRoutineConfig(null)).toBe(false);
  });

  it('valida nombres de copia y la restauración con confirmación', () => {
    expect(isBackupFileName('tradia-2026-10-09T02-00-00.db')).toBe(true);
    expect(BACKUP_FILE_PATTERN.test('copia.db')).toBe(true);
    expect(isBackupFileName('tradia.db')).toBe(true);
    expect(isBackupFileName('../tradia.db')).toBe(false);
    expect(isBackupFileName('carpeta/tradia.db')).toBe(false);
    expect(isBackupFileName('tradia.db.bak')).toBe(false);
    expect(isBackupFileName('.db')).toBe(false);
    expect(isBackupFileName(42)).toBe(false);

    expect(isBackupRestoreRequest({ fileName: 'tradia-1.db', confirm: true })).toBe(true);
    expect(isBackupRestoreRequest({ fileName: 'tradia-1.db' })).toBe(false);
    expect(isBackupRestoreRequest({ fileName: 'tradia-1.db', confirm: false })).toBe(false);
    expect(isBackupRestoreRequest({ fileName: '../otra.db', confirm: true })).toBe(false);
    expect(isBackupRestoreRequest({ fileName: 'a.db', confirm: true, extra: 1 })).toBe(false);
    expect(isBackupRestoreRequest(null)).toBe(false);
  });

  it('las rutas de notificación incluyen las vistas de la fase 4 y la 5', () => {
    for (const route of [
      'noticias',
      'calendario',
      'riesgo',
      'diario',
      'inicio',
      'ordenes',
      'real-vs-backtest',
    ] as const) {
      expect(isNotificationRoute(route)).toBe(true);
    }
    expect(isNotificationRoute('senales')).toBe(false);
    expect(isNotificationRoute(null)).toBe(false);
  });
});

describe('guardas del broker en modo paper (fase 5)', () => {
  it('valida las credenciales de conexión sin filtrar campos', () => {
    expect(isBrokerConnectRequest({ apiKeyId: 'PKABC123', apiSecret: 'sk-test' })).toBe(true);
    expect(isBrokerConnectRequest({ apiKeyId: 'PKABC123' })).toBe(false);
    expect(isBrokerConnectRequest({ apiKeyId: 'PKABC123', apiSecret: 'con espacios' })).toBe(false);
    expect(isBrokerConnectRequest({ apiKeyId: 'short', apiSecret: 'sk-test' })).toBe(false);
    expect(isBrokerConnectRequest({ apiKeyId: 'PKABC123', apiSecret: 'sk-test', extra: 1 })).toBe(
      false,
    );
    expect(isBrokerConnectRequest(null)).toBe(false);
    expect(isBrokerConnectRequest('PKABC123:sk-test')).toBe(false);
  });

  it('la prueba de conexión admite las dos claves o ninguna', () => {
    expect(isBrokerTestRequest(undefined)).toBe(true);
    expect(isBrokerTestRequest({})).toBe(true);
    expect(isBrokerTestRequest({ apiKeyId: 'PKABC123', apiSecret: 'sk-test' })).toBe(true);
    expect(isBrokerTestRequest({ apiKeyId: 'PKABC123' })).toBe(false);
    expect(isBrokerTestRequest({ apiSecret: 'sk-test' })).toBe(false);
    expect(isBrokerTestRequest(null)).toBe(false);
  });

  it('valida los filtros del listado de órdenes', () => {
    expect(isBrokerOrdersQuery(undefined)).toBe(true);
    expect(isBrokerOrdersQuery({})).toBe(true);
    expect(isBrokerOrdersQuery({ status: 'enviada' })).toBe(true);
    expect(isBrokerOrdersQuery({ status: 'abierta' })).toBe(false);
    expect(isBrokerOrdersQuery({ strategyId: 3, ticker: 'aapl', limit: 50, offset: 10 })).toBe(
      true,
    );
    expect(isBrokerOrdersQuery({ strategyId: 1.5 })).toBe(false);
    expect(isBrokerOrdersQuery({ ticker: '***' })).toBe(false);
    expect(isBrokerOrdersQuery({ limit: 0 })).toBe(false);
    expect(isBrokerOrdersQuery({ limit: 999 })).toBe(false);
    expect(isBrokerOrdersQuery({ offset: -1 })).toBe(false);
    expect(isBrokerOrdersQuery({ status: 'enviada', extra: 1 })).toBe(false);
    expect(isBrokerOrdersQuery(null)).toBe(false);
  });

  it('la creación de una limitada exige activo, lado, cantidad y precio válidos', () => {
    const request = { ticker: 'AAPL', side: 'buy', quantity: 2, limitPrice: 150.5 };
    expect(isCreateOrderRequest(request)).toBe(true);
    expect(isCreateOrderRequest({ ...request, side: 'sell' })).toBe(true);
    expect(isCreateOrderRequest({ ...request, side: 'comprar' })).toBe(false);
    expect(isCreateOrderRequest({ ...request, ticker: '***' })).toBe(false);
    expect(isCreateOrderRequest({ ...request, quantity: 0 })).toBe(false);
    expect(isCreateOrderRequest({ ...request, quantity: -2 })).toBe(false);
    expect(isCreateOrderRequest({ ...request, limitPrice: 0 })).toBe(false);
    expect(isCreateOrderRequest({ ...request, limitPrice: Number.NaN })).toBe(false);
    expect(isCreateOrderRequest({ ...request, type: 'limit' })).toBe(false);
    expect(isCreateOrderRequest({ ticker: 'AAPL', quantity: 2 })).toBe(false);
    expect(isCreateOrderRequest({})).toBe(false);
    expect(isCreateOrderRequest(null)).toBe(false);
  });

  it('la cancelación exige el id local de la orden', () => {
    expect(isCancelOrderRequest({ id: 7 })).toBe(true);
    expect(isCancelOrderRequest({ id: 'sim-7' })).toBe(false);
    expect(isCancelOrderRequest({ id: 0 })).toBe(false);
    expect(isCancelOrderRequest({ id: 1.5 })).toBe(false);
    expect(isCancelOrderRequest({})).toBe(false);
    expect(isCancelOrderRequest({ id: 7, extra: true })).toBe(false);
    expect(isCancelOrderRequest(null)).toBe(false);
  });

  it('el informe de desviación exige el periodo', () => {
    expect(isDeviationReportQuery({ period: 'semanal' })).toBe(true);
    expect(isDeviationReportQuery({ period: 'mensual' })).toBe(true);
    expect(isDeviationReportQuery({ period: 'diario' })).toBe(false);
    expect(isDeviationReportQuery({})).toBe(false);
    expect(isDeviationReportQuery({ period: 'semanal', desde: '2026-10-05' })).toBe(false);
    expect(isDeviationReportQuery(null)).toBe(false);
  });

  it('los ganchos E2E del broker solo aceptan fallos y descuadres conocidos', () => {
    expect(isBrokerFailNextRequest({ kind: 'timeout' })).toBe(true);
    expect(isBrokerFailNextRequest({ kind: 'rate-limit' })).toBe(true);
    expect(isBrokerFailNextRequest({ kind: 'server' })).toBe(true);
    expect(isBrokerFailNextRequest({ kind: 'reject' })).toBe(true);
    expect(isBrokerFailNextRequest({ kind: 'partial' })).toBe(true);
    expect(isBrokerFailNextRequest({ kind: 'nuclear' })).toBe(false);
    expect(isBrokerFailNextRequest({})).toBe(false);
    expect(isBrokerFailNextRequest(null)).toBe(false);

    expect(isBrokerDiscrepancyRequest({ kind: 'posicion-cantidad' })).toBe(true);
    expect(isBrokerDiscrepancyRequest({ kind: 'orden-borrada' })).toBe(true);
    expect(isBrokerDiscrepancyRequest({ kind: 'orden-fantasma' })).toBe(true);
    expect(isBrokerDiscrepancyRequest({ kind: 'orden-estado' })).toBe(false);
    expect(isBrokerDiscrepancyRequest(null)).toBe(false);

    expect(isBrokerSeedWeeksRequest(undefined)).toBe(true);
    expect(isBrokerSeedWeeksRequest({})).toBe(true);
    expect(isBrokerSeedWeeksRequest({ weeks: 8 })).toBe(true);
    expect(isBrokerSeedWeeksRequest({ weeks: 0 })).toBe(false);
    expect(isBrokerSeedWeeksRequest({ weeks: 53 })).toBe(false);
    expect(isBrokerSeedWeeksRequest({ weeks: 2.5 })).toBe(false);
    expect(isBrokerSeedWeeksRequest(null)).toBe(false);
  });
});

describe('guardas de las fases 6-7 (IA predictiva y dinero real)', () => {
  it('valida las listas de etiquetas de régimen de la ficha', () => {
    expect(isRegimeLabelList(['tendencia'])).toBe(true);
    expect(isRegimeLabelList(['lateral', 'volatilidad-alta'])).toBe(true);
    expect(isRegimeLabelList([])).toBe(true);
    expect(isRegimeLabelList(['tendencia', 'tendencia'])).toBe(false);
    expect(isRegimeLabelList(['alcista'])).toBe(false);
    expect(isRegimeLabelList('tendencia')).toBe(false);
    expect(isRegimeLabelList(null)).toBe(false);

    // Una etiqueta no puede estar a la vez en «funciona en» y «falla en».
    const ficha = {
      name: 'Estrategia',
      hypothesis: 'hipótesis',
      rules: { entry: 'e', exit: 's', stop: 't', target: 'o' },
      parameters: {},
      markets: ['SPY'],
      regime: 'texto',
    };
    expect(
      isCreateStrategyRequest({ ...ficha, worksIn: ['tendencia'], failsIn: ['lateral'] }),
    ).toBe(true);
    expect(
      isCreateStrategyRequest({ ...ficha, worksIn: ['tendencia'], failsIn: ['tendencia'] }),
    ).toBe(false);
    expect(isCreateStrategyRequest({ ...ficha, worksIn: ['alcista'] })).toBe(false);
    expect(isCreateStrategyRequest({ ...ficha, failsIn: 'lateral' })).toBe(false);
  });

  it('valida el contexto de IA de una señal (opcional en la intención)', () => {
    const ai = {
      regime: { direction: 'tendencia', volatility: 'volatilidad-alta' },
      probability: 0.62,
      horizonDays: 5,
      modelVersion: '0.1.0',
      modelHash: 'a'.repeat(64),
      newsItemIds: [3, 7],
    };
    expect(isSignalAiContext(ai)).toBe(true);
    expect(isSignalAiContext({ ...ai, regime: null })).toBe(true);
    expect(isSignalAiContext({ ...ai, probability: null })).toBe(true);
    expect(isSignalAiContext({ ...ai, probability: 1.2 })).toBe(false);
    expect(isSignalAiContext({ ...ai, regime: { direction: 'alza' } })).toBe(false);
    expect(isSignalAiContext({ ...ai, newsItemIds: [0] })).toBe(false);
    expect(isSignalAiContext({ ...ai, extra: 1 })).toBe(false);
    expect(isSignalAiContext('ia')).toBe(false);
    expect(isSignalAiContext(null)).toBe(false);

    // La intención de señal lo admite como campo opcional.
    const senal = {
      ticker: 'AAPL',
      direction: 'largo',
      entry: 200,
      stop: 190,
      target: 220,
      confidence: 0.8,
      origin: 'estrategia',
    };
    expect(isSignalIntent({ ...senal, ai })).toBe(true);
    expect(isSignalIntent({ ...senal, ai: { probability: 2 } })).toBe(false);
  });

  it('valida las consultas de predicciones y de análisis de noticias', () => {
    expect(isPredictionsQuery(undefined)).toBe(true);
    expect(isPredictionsQuery({})).toBe(true);
    expect(isPredictionsQuery({ ticker: 'AAPL', limit: 20 })).toBe(true);
    expect(isPredictionsQuery({ ticker: '***' })).toBe(false);
    expect(isPredictionsQuery({ limit: 0 })).toBe(false);
    expect(isPredictionsQuery({ limit: 10_000 })).toBe(false);
    expect(isPredictionsQuery({ extra: 1 })).toBe(false);
    expect(isPredictionsQuery(null)).toBe(false);

    expect(isNewsAnalysisQuery(undefined)).toBe(true);
    expect(isNewsAnalysisQuery({ newsItemId: 3, ticker: 'AAPL' })).toBe(true);
    expect(isNewsAnalysisQuery({ newsItemId: 0 })).toBe(false);
    expect(isNewsAnalysisQuery({ newsItemId: 1.5 })).toBe(false);
    expect(isNewsAnalysisQuery({ ticker: 'DROP TABLE' })).toBe(false);
    expect(isNewsAnalysisQuery({ limit: 201 })).toBe(false);
    expect(isNewsAnalysisQuery(null)).toBe(false);
  });

  it('valida los ajustes del LLM: campos parciales dentro de márgenes', () => {
    expect(isNewsLlmSettingsInput({ enabled: true })).toBe(true);
    expect(isNewsLlmSettingsInput({ dailyCap: 50 })).toBe(true);
    expect(isNewsLlmSettingsInput({ monthlyBudgetEur: 10 })).toBe(true);
    expect(isNewsLlmSettingsInput({ monthlyBudgetEur: 0 })).toBe(true);
    expect(isNewsLlmSettingsInput({ enabled: 'sí' })).toBe(false);
    expect(isNewsLlmSettingsInput({ dailyCap: 0 })).toBe(false);
    expect(isNewsLlmSettingsInput({ dailyCap: 20_001 })).toBe(false);
    expect(isNewsLlmSettingsInput({ monthlyBudgetEur: -1 })).toBe(false);
    expect(isNewsLlmSettingsInput({ monthlyBudgetEur: 31 })).toBe(false);
    expect(isNewsLlmSettingsInput({ apiKey: 'sk-…' })).toBe(false);
    expect(isNewsLlmSettingsInput({})).toBe(false);
    expect(isNewsLlmSettingsInput(null)).toBe(false);
  });

  it('valida la resolución de propuestas de reentrenamiento', () => {
    expect(isRetrainResolveRequest({ id: 1, action: 'aprobar' })).toBe(true);
    expect(
      isRetrainResolveRequest({ id: 1, action: 'posponer', postponeUntil: '2026-12-31' }),
    ).toBe(true);
    expect(
      isRetrainResolveRequest({
        id: 1,
        action: 'posponer',
        postponeUntil: '2026-12-31',
        note: 'ok',
      }),
    ).toBe(true);
    // Posponer exige la fecha; aprobar no la necesita.
    expect(isRetrainResolveRequest({ id: 1, action: 'posponer' })).toBe(false);
    expect(isRetrainResolveRequest({ id: 1, action: 'ejecutar' })).toBe(false);
    expect(isRetrainResolveRequest({ id: 0, action: 'aprobar' })).toBe(false);
    expect(isRetrainResolveRequest({ id: 1, action: 'aprobar', extra: 1 })).toBe(false);
    expect(isRetrainResolveRequest(null)).toBe(false);
  });

  it('valida la comparación de régimen del backtest', () => {
    expect(isRegimeComparisonRequest({ strategyId: 1 })).toBe(true);
    expect(isRegimeComparisonRequest({ strategyId: 1, version: 2 })).toBe(true);
    expect(isRegimeComparisonRequest({ strategyId: 'x' })).toBe(false);
    expect(isRegimeComparisonRequest({ strategyId: 1, version: 0 })).toBe(false);
    expect(isRegimeComparisonRequest({ strategyId: 1, desde: '2020-01-01' })).toBe(false);
    expect(isRegimeComparisonRequest(null)).toBe(false);
  });

  it('valida las declaraciones manuales de la lista de dinero real', () => {
    expect(isLiveDeclareRequest({ requirement: 'revision-legal', confirmed: true })).toBe(true);
    expect(
      isLiveDeclareRequest({
        requirement: 'plan-contingencia',
        confirmed: true,
        detail: 'docs/contingencia.md',
      }),
    ).toBe(true);
    expect(isLiveDeclareRequest({ requirement: 'revision-legal', confirmed: false })).toBe(true);
    // Los requisitos automáticos no aceptan declaración manual.
    expect(isLiveDeclareRequest({ requirement: 'paper-continuo', confirmed: true })).toBe(false);
    expect(isLiveDeclareRequest({ requirement: 'inventado', confirmed: true })).toBe(false);
    expect(isLiveDeclareRequest({ requirement: 'revision-legal', confirmed: 'sí' })).toBe(false);
    expect(isLiveDeclareRequest({ requirement: 'revision-legal' })).toBe(false);
    expect(isLiveDeclareRequest({ requirement: 'revision-legal', confirmed: true, extra: 1 })).toBe(
      false,
    );
    expect(isLiveDeclareRequest(null)).toBe(false);
  });

  it('los límites escritos nunca superan los techos fijos', () => {
    const limits = {
      capitalUsd: 500,
      orderUsd: 100,
      dailyLossUsd: 10,
      openPositions: 1,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    };
    expect(isLiveLimitsInput(limits)).toBe(true);
    expect(
      isLiveLimitsInput({
        capitalUsd: 1_000,
        orderUsd: 200,
        dailyLossUsd: 20,
        openPositions: 2,
        shortOrderUsd: 100,
        shortExposureUsd: 200,
        shortPositions: 1,
      }),
    ).toBe(true);
    expect(isLiveLimitsInput({ ...limits, capitalUsd: 1_001 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, orderUsd: 201 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, dailyLossUsd: 21 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, openPositions: 3 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, openPositions: 0 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, capitalUsd: 0 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, orderUsd: -5 })).toBe(false);
    expect(isLiveLimitsInput({ capitalUsd: 500, orderUsd: 100 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, extra: 1 })).toBe(false);
    expect(isLiveLimitsInput(null)).toBe(false);
  });

  it('los límites del corto son opcionales, admiten 0 y respetan sus techos', () => {
    const limits = {
      capitalUsd: 500,
      orderUsd: 100,
      dailyLossUsd: 10,
      openPositions: 1,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    };
    // Los tres campos del corto son opcionales: un payload sin ellos
    // (p. ej. una interfaz que aún no los expone) vale con el corto a 0.
    const { shortOrderUsd: _o, shortExposureUsd: _e, shortPositions: _p, ...sinCorto } = limits;
    expect(isLiveLimitsInput(sinCorto)).toBe(true);
    // A 0 el corto queda desactivado; negativos o fraccionarios no valen.
    expect(isLiveLimitsInput({ ...limits, shortOrderUsd: 0 })).toBe(true);
    expect(isLiveLimitsInput({ ...limits, shortOrderUsd: -1 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, shortOrderUsd: 101 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, shortExposureUsd: 201 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, shortPositions: 2 })).toBe(false);
    expect(isLiveLimitsInput({ ...limits, shortPositions: 0.5 })).toBe(false);
    // En los techos sí pasan.
    expect(
      isLiveLimitsInput({
        ...limits,
        shortOrderUsd: 100,
        shortExposureUsd: 200,
        shortPositions: 1,
      }),
    ).toBe(true);
  });

  it('la activación exige una frase escrita; el humo, confirmación', () => {
    expect(isLiveActivateRequest({ phrase: 'ACTIVO DINERO REAL CON 500 USD…' })).toBe(true);
    expect(isLiveActivateRequest({ phrase: '  ' })).toBe(false);
    expect(isLiveActivateRequest({ phrase: 42 })).toBe(false);
    expect(isLiveActivateRequest({})).toBe(false);
    expect(isLiveActivateRequest({ phrase: 'x', confirm: true })).toBe(false);
    expect(isLiveActivateRequest(null)).toBe(false);

    expect(isLiveSmokeTestRequest({ confirm: true })).toBe(true);
    expect(isLiveSmokeTestRequest({ confirm: false })).toBe(false);
    expect(isLiveSmokeTestRequest({})).toBe(false);
    expect(isLiveSmokeTestRequest(null)).toBe(false);
  });

  it('las claves live usan el mismo formato que las del broker paper', () => {
    expect(isLiveConnectRequest({ apiKeyId: 'AKFAKE123', apiSecret: 'super-secret-1' })).toBe(true);
    expect(isLiveConnectRequest({ apiKeyId: 'PK12', apiSecret: 'x' })).toBe(false);
    expect(isLiveConnectRequest({ apiKeyId: 'AKFAKE123' })).toBe(false);
    expect(isLiveConnectRequest({ apiKeyId: 'AKFAKE123', apiSecret: 'x', extra: 1 })).toBe(false);
    expect(isLiveConnectRequest(null)).toBe(false);
  });

  it('los ganchos E2E de régimen, drift y siembra live validan su forma', () => {
    expect(isSimulateRegimeRequest({ scope: 'mercado', direction: 'lateral' })).toBe(true);
    expect(
      isSimulateRegimeRequest({
        ticker: 'AAPL',
        direction: 'lateral',
        volatility: 'volatilidad-baja',
      }),
    ).toBe(true);
    expect(
      isSimulateRegimeRequest({
        ticker: 'AAPL',
        volatility: 'volatilidad-baja',
        sessionDate: '2026-10-09',
      }),
    ).toBe(true);
    expect(isSimulateRegimeRequest({ ticker: 'AAPL' })).toBe(false);
    expect(isSimulateRegimeRequest({ scope: 'activo', direction: 'lateral' })).toBe(false);
    expect(isSimulateRegimeRequest({ scope: 'mercado', direction: 'alza' })).toBe(false);
    expect(isSimulateRegimeRequest({ scope: 'mercado', direction: 'lateral', extra: 1 })).toBe(
      false,
    );
    expect(isSimulateRegimeRequest(null)).toBe(false);

    expect(isSimulateDriftRequest({ kind: 'datos', streak: 20 })).toBe(true);
    expect(isSimulateDriftRequest({ kind: 'rendimiento', subjectId: 2 })).toBe(true);
    expect(isSimulateDriftRequest({ kind: 'inventado' })).toBe(false);
    expect(isSimulateDriftRequest({ kind: 'datos', streak: 0 })).toBe(false);
    expect(isSimulateDriftRequest({ kind: 'datos', streak: 1.5 })).toBe(false);
    expect(isSimulateDriftRequest(null)).toBe(false);

    expect(isLiveSeedProgressRequest(undefined)).toBe(true);
    expect(isLiveSeedProgressRequest({})).toBe(true);
    expect(
      isLiveSeedProgressRequest({
        paperMonths: 4,
        paperTrades: 36,
        deviationPct: -4,
        finalTestDone: true,
        killSwitchTested: true,
        alertsTested: true,
      }),
    ).toBe(true);
    expect(isLiveSeedProgressRequest({ paperMonths: -1 })).toBe(false);
    expect(isLiveSeedProgressRequest({ paperTrades: 2.5 })).toBe(false);
    expect(isLiveSeedProgressRequest({ finalTestDone: 'sí' })).toBe(false);
    expect(isLiveSeedProgressRequest({ extra: 1 })).toBe(false);
    expect(isLiveSeedProgressRequest(null)).toBe(false);

    expect(isLiveSimulatedBrokerRequest({ enabled: true })).toBe(true);
    expect(isLiveSimulatedBrokerRequest({ enabled: 'sí' })).toBe(false);
    expect(isLiveSimulatedBrokerRequest({})).toBe(false);
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

describe('contrato de la continuación (modo por orden, proveedores, tour, LLM)', () => {
  it('registra los canales de proveedores (prueba de conexión y gancho E2E)', () => {
    expect(IPC_CHANNELS.providers.testConnection).toBe('providers:test-connection');
    expect(IPC_CHANNELS.providers.simulateTest).toBe('providers:simulate-test');
    expect(allIpcChannels()).toContain('providers:test-connection');
    expect(allIpcChannels()).toContain('providers:simulate-test');
  });

  it('ProviderTestResult no tiene ningún campo de clave ni secreto', () => {
    const result: ProviderTestResult = {
      provider: 'tiingo',
      status: 'ok',
      message: 'Conectado · último dato 2026-10-09',
      latestDataDate: '2026-10-09',
      checkedAt: '2026-10-10T12:00:00.000Z',
      latencyMs: 120,
    };
    expect(Object.keys(result).sort()).toEqual([
      'checkedAt',
      'latencyMs',
      'latestDataDate',
      'message',
      'provider',
      'status',
    ]);
    // Ningún campo puede transportar la clave ni fragmentos de ella.
    for (const key of Object.keys(result)) {
      expect(key).not.toMatch(/key|secret|token|clave/i);
    }
  });

  it('solo Tiingo y FRED son proveedores de datos del contrato', () => {
    expect(DATA_PROVIDER_IDS).toEqual(['tiingo', 'fred']);
    expect(isProviderTestRequest({ provider: 'tiingo' })).toBe(true);
    expect(isProviderTestRequest({ provider: 'fred' })).toBe(true);
    expect(isProviderTestRequest({ provider: 'alpaca' })).toBe(false);
    expect(isProviderTestRequest({ provider: 'tiingo', apiKey: 'x' })).toBe(false);
    expect(isProviderTestRequest({})).toBe(false);
    expect(isProviderTestRequest(null)).toBe(false);
    expect(isProviderTestRequest('tiingo')).toBe(false);
  });

  it('los estados de la prueba son los del contrato y el gancho los valida', () => {
    expect(isProviderTestStatus('ok')).toBe(true);
    expect(isProviderTestStatus('sin-clave')).toBe(true);
    expect(isProviderTestStatus('clave-rechazada')).toBe(true);
    expect(isProviderTestStatus('cuota')).toBe(true);
    expect(isProviderTestStatus('sin-red')).toBe(true);
    expect(isProviderTestStatus('error')).toBe(true);
    expect(isProviderTestStatus('otro')).toBe(false);
    expect(isProviderSimulateTestRequest({ provider: 'fred', status: 'cuota' })).toBe(true);
    expect(isProviderSimulateTestRequest({ provider: 'fred', status: 'otro' })).toBe(false);
    expect(isProviderSimulateTestRequest({ status: 'ok' })).toBe(false);
    expect(isProviderSimulateTestRequest(null)).toBe(false);
  });

  it('BrokerOrder.mode distingue paper y live, y orders:list lo filtra', () => {
    expect(BROKER_ORDER_MODES).toEqual(['paper', 'live']);
    expect(isBrokerOrderMode('paper')).toBe(true);
    expect(isBrokerOrderMode('live')).toBe(true);
    expect(isBrokerOrderMode('demo')).toBe(false);
    expect(isBrokerOrdersQuery({ mode: 'live' })).toBe(true);
    expect(isBrokerOrdersQuery({ status: 'ejecutada', mode: 'paper', limit: 10 })).toBe(true);
    expect(isBrokerOrdersQuery({ mode: 'demo' })).toBe(false);
    expect(isBrokerOrdersQuery({ mode: 'live', extra: 1 })).toBe(false);
  });

  it('el tour vive en ajustes: versión escribible, fecha solo de main', () => {
    expect(typeof ONBOARDING_TOUR_VERSION).toBe('string');
    expect(ONBOARDING_TOUR_VERSION.length).toBeGreaterThan(0);
    expect(isSettingsPatch({ onboardingTourVersion: ONBOARDING_TOUR_VERSION })).toBe(true);
    expect(isSettingsPatch({ onboardingTourVersion: null })).toBe(true);
    expect(isSettingsPatch({ onboardingTourVersion: 3 })).toBe(false);
    // La fecha de finalización la fija el proceso principal, no el renderer.
    expect(isSettingsPatch({ onboardingTourCompletedAt: '2026-10-10T00:00:00Z' })).toBe(false);
  });

  it('NEWS_ANALYZERS amplía con suscripcion y los ajustes llevan proveedor y cliPath', () => {
    expect(NEWS_ANALYZERS).toEqual(['llm', 'local', 'suscripcion']);
    expect(isNewsAnalyzer('suscripcion')).toBe(true);
    expect(isNewsAnalyzer('api')).toBe(false);
    expect(isNewsLlmSettingsInput({ provider: 'suscripcion' })).toBe(true);
    expect(isNewsLlmSettingsInput({ provider: 'local' })).toBe(true);
    // La API de pago se retiró: 'llm' ya no es un proveedor elegible.
    expect(isNewsLlmSettingsInput({ provider: 'llm' })).toBe(false);
    expect(isNewsLlmSettingsInput({ provider: 'otro' })).toBe(false);
    expect(isNewsLlmSettingsInput({ cliPath: '/usr/local/bin/claude' })).toBe(true);
    expect(isNewsLlmSettingsInput({ cliPath: null })).toBe(true);
    expect(isNewsLlmSettingsInput({ cliPath: '' })).toBe(false);
    expect(isNewsLlmSettingsInput({ cliPath: '  ' })).toBe(false);
    expect(
      isNewsLlmSettingsInput({ provider: 'suscripcion', cliPath: '/x/claude', dailyCap: 50 }),
    ).toBe(true);
    // Los campos anteriores siguen validando igual (aditivo).
    expect(isNewsLlmSettingsInput({ enabled: true, monthlyBudgetEur: 5 })).toBe(true);
  });
});
