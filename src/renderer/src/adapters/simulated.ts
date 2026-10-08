import {
  dataStatusKey,
  INITIAL_UNIVERSE_TICKERS,
  isGetBarsRequest,
  isIsoDate,
  isTicker,
  WATCHLIST_MAX_ITEMS,
} from '../../../shared/ipc';
import type {
  AgentsState,
  AppSettings,
  ConnectivityState,
  DataStatusEntry,
  GetBarsRequest,
  MacroObservation,
  MacroSeriesQuery,
  MacroSeriesSnapshot,
  MarketBar,
  MarketUpdatedEvent,
  NotificationPrefs,
  TradiaApi,
  WatchlistItem,
} from '../../../shared/ipc';

const SIMULATED_SOURCE = 'simulated';
/** Génesis de las series simuladas: da unos 7 años de velas diarias. */
const GENESIS = '2019-01-02';
const DAY_MS = 86_400_000;

/** Hash FNV-1a de texto a uint32 (misma técnica que el proveedor simulado). */
function hashSeed(text: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/** PRNG mulberry32: determinista por semilla, suficiente para datos de prueba. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isWeekday = (ms: number): boolean => {
  const day = new Date(ms).getUTCDay();
  return day >= 1 && day <= 5;
};

/** Velas diarias deterministas por ticker: paseo aleatorio con semilla, solo laborables. */
function generateBars(ticker: string): MarketBar[] {
  const rng = mulberry32(hashSeed(`sim:${ticker}`));
  let close = round(20 + rng() * 480, 2);
  const baseVolume = Math.round(1_000_000 + rng() * 50_000_000);
  const bars: MarketBar[] = [];
  const end = Date.now() - DAY_MS;
  for (let ms = Date.parse(`${GENESIS}T00:00:00.000Z`); ms <= end; ms += DAY_MS) {
    if (!isWeekday(ms)) continue;
    const noise = ((rng() + rng() + rng()) / 1.5 - 1) * 0.02;
    const prev = close;
    close = round(Math.max(1, prev * (1 + noise + 0.0002)), 2);
    const open = round(prev * (1 + (rng() + rng() - 1) * 0.005), 2);
    const high = round(Math.max(open, close) * (1 + rng() * 0.01), 2);
    const low = round(Math.min(open, close) * (1 - rng() * 0.01), 2);
    const volume = Math.round(baseVolume * (0.5 + rng() * 1.5));
    bars.push({
      date: toDate(ms),
      open,
      high,
      low,
      close,
      volume,
      // En la simulación no hay acciones corporativas: ajustado = crudo.
      adjOpen: open,
      adjHigh: high,
      adjLow: low,
      adjClose: close,
      adjVolume: volume,
      batchId: 1,
    });
  }
  return bars;
}

/**
 * Serie de valores determinista: paseo con semilla que termina en `endValue`
 * (los últimos puntos se interpolan hacia él para fijar el valor visible).
 */
function generateSeries(
  seedText: string,
  points: number,
  stepDays: number,
  min: number,
  max: number,
  endValue: number,
): MacroObservation[] {
  const rng = mulberry32(hashSeed(`macro:${seedText}`));
  const raw: number[] = [];
  let value = min + rng() * (max - min);
  for (let i = 0; i < points; i++) {
    value = Math.min(max, Math.max(min, value + (rng() - 0.5) * (max - min) * 0.08));
    raw.push(round(value, 2));
  }
  // Funde los últimos ~10 % de puntos hacia endValue para un cierre conocido.
  const blend = Math.max(2, Math.floor(points * 0.1));
  for (let i = 0; i < blend; i++) {
    const idx = points - 1 - i;
    const t = i / blend;
    raw[idx] = round(endValue + (raw[idx]! - endValue) * t, 2);
  }
  const endMs = Date.now() - DAY_MS;
  return raw.map((v, i) => ({
    date: toDate(endMs - (points - 1 - i) * stepDays * DAY_MS),
    value: v,
  }));
}

/** Las 6 series macro del panel, con VIX medio y curva 10-2 invertida al final. */
function buildMacroSeries(): MacroSeriesSnapshot[] {
  const meta: Array<{ id: string; name: string; unit: string; frequency: string }> = [
    { id: 'DFF', name: 'Tipo de fondos federales', unit: '%', frequency: 'daily' },
    { id: 'CPIAUCSL', name: 'IPC interanual (EE. UU.)', unit: '%', frequency: 'monthly' },
    { id: 'DGS2', name: 'Tesoro EE. UU. 2 años', unit: '%', frequency: 'daily' },
    { id: 'DGS10', name: 'Tesoro EE. UU. 10 años', unit: '%', frequency: 'daily' },
    { id: 'T10Y2Y', name: 'Diferencial 10 años − 2 años', unit: '%', frequency: 'daily' },
    { id: 'VIXCLS', name: 'VIX (volatilidad CBOE)', unit: 'índice', frequency: 'daily' },
  ];
  const observationsById = new Map<string, MacroObservation[]>();
  observationsById.set('DFF', generateSeries('DFF', 36, 30, 0.1, 5.5, 4.33));
  observationsById.set(
    'CPIAUCSL',
    Array.from({ length: 36 }, (_, index) => {
      const date = new Date();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - (35 - index));
      return {
        date: date.toISOString().slice(0, 10),
        value: round(290 * 1.026 ** (index / 12), 4),
      };
    }),
  );
  observationsById.set('DGS2', generateSeries('DGS2', 120, 7, 0.5, 5.5, 4.4));
  observationsById.set('DGS10', generateSeries('DGS10', 120, 7, 0.7, 5, 4.1));
  // La curva termina invertida (T10Y2Y < 0) para que el aviso se vea en pruebas.
  observationsById.set('T10Y2Y', generateSeries('T10Y2Y', 120, 7, -1.2, 2.2, -0.3));
  observationsById.set('VIXCLS', generateSeries('VIXCLS', 120, 7, 10, 45, 18.4));

  const status: DataStatusEntry = {
    key: '',
    state: 'fiable',
    lastOkAt: new Date().toISOString(),
    consecutiveFailures: 0,
    reason: null,
    updatedAt: new Date().toISOString(),
  };
  return meta.map((item) => ({
    ...item,
    observations: observationsById.get(item.id) ?? [],
    status: { ...status, key: dataStatusKey.macro(item.id) },
  }));
}

/** Explicit simulation only: never substitutes the production Electron bridge. */
export function createSimulatedAdapter() {
  let connectivity: ConnectivityState = {
    status: 'checking',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  };
  let agents: AgentsState = { paused: false, pauseReason: null, lastHeartbeatAt: null };
  let settings: AppSettings = {
    autostart: false,
    disclaimerAcceptedVersion: null,
    disclaimerAcceptedAt: null,
  };
  let prefs: NotificationPrefs = { info: true, alerta: true, critica: true };
  let watchlist: WatchlistItem[] = [];
  const macroSeries = buildMacroSeries();
  const statuses = new Map<string, DataStatusEntry>();
  for (const series of macroSeries) {
    if (series.status) statuses.set(series.status.key, series.status);
  }
  statuses.set(dataStatusKey.provider(SIMULATED_SOURCE), {
    key: dataStatusKey.provider(SIMULATED_SOURCE),
    state: 'fiable',
    lastOkAt: new Date().toISOString(),
    consecutiveFailures: 0,
    reason: null,
    updatedAt: new Date().toISOString(),
  });

  const connectionListeners = new Set<(value: ConnectivityState) => void>();
  const agentListeners = new Set<(value: AgentsState) => void>();
  const heartbeatListeners = new Set<(value: string) => void>();
  const dataStatusListeners = new Set<(value: DataStatusEntry) => void>();
  const marketUpdatedListeners = new Set<(value: MarketUpdatedEvent) => void>();
  const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const emitConnectivity = (value: ConnectivityState) => {
    connectivity = value;
    connectionListeners.forEach((listener) => listener(value));
  };
  const emitAgents = (value: AgentsState) => {
    agents = value;
    agentListeners.forEach((listener) => listener(value));
  };
  const setStatus = (entry: DataStatusEntry, notify: boolean) => {
    statuses.set(entry.key, entry);
    if (notify) dataStatusListeners.forEach((listener) => listener(entry));
  };
  const touchTickerStatus = (ticker: string) => {
    const key = dataStatusKey.ticker(ticker);
    if (!statuses.has(key)) {
      setStatus(
        {
          key,
          state: 'fiable',
          lastOkAt: new Date().toISOString(),
          consecutiveFailures: 0,
          reason: null,
          updatedAt: new Date().toISOString(),
        },
        false,
      );
    }
  };
  const unsupported = async () => {
    throw new Error('Operación nativa no disponible en la simulación.');
  };
  const api: TradiaApi = {
    connectivity: {
      getState: async () => connectivity,
      checkNow: async () => connectivity,
      onChanged: (listener) => subscribe(connectionListeners, listener),
    },
    agents: {
      getState: async () => agents,
      pause: async () => {
        emitAgents({ ...agents, paused: true, pauseReason: 'usuario' });
        return agents;
      },
      resume: async () => {
        emitAgents({ ...agents, paused: false, pauseReason: null });
        return agents;
      },
      onChanged: (listener) => subscribe(agentListeners, listener),
      onHeartbeat: (listener) => subscribe(heartbeatListeners, listener),
    },
    settings: {
      get: async () => settings,
      set: async (patch) => {
        settings = {
          ...settings,
          ...patch,
          ...(patch.disclaimerAcceptedVersion !== undefined
            ? {
                disclaimerAcceptedAt: patch.disclaimerAcceptedVersion
                  ? new Date().toISOString()
                  : null,
              }
            : {}),
        };
        return settings;
      },
    },
    notifications: {
      send: unsupported,
      test: unsupported,
      getPrefs: async () => prefs,
      setPrefs: async (value) => {
        prefs = value;
        return prefs;
      },
    },
    secrets: { setKey: unsupported, hasKey: async () => false, deleteKey: unsupported },
    watchlist: {
      list: async () => [...watchlist],
      add: async (ticker) => {
        const key = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
        if (!isTicker(key)) {
          throw new Error('Introduce un símbolo bursátil válido (ej. AAPL, SPY, NVDA).');
        }
        if (watchlist.some((item) => item.ticker === key)) {
          throw new Error(`El activo ${key} ya está presente en tu lista de seguimiento.`);
        }
        if (watchlist.length >= WATCHLIST_MAX_ITEMS) {
          throw new Error(
            `Límite alcanzado: Tradia admite un máximo de ${WATCHLIST_MAX_ITEMS} activos simultáneos.`,
          );
        }
        watchlist = [
          ...watchlist,
          { ticker: key, addedAt: new Date().toISOString(), position: watchlist.length },
        ];
        touchTickerStatus(key);
        return [...watchlist];
      },
      remove: async (ticker) => {
        const key = ticker.trim().toUpperCase();
        watchlist = watchlist
          .filter((item) => item.ticker !== key)
          .map((item, index) => ({ ...item, position: index }));
        return [...watchlist];
      },
      addUniverse: async () => {
        for (const ticker of INITIAL_UNIVERSE_TICKERS) {
          if (watchlist.length >= WATCHLIST_MAX_ITEMS) break;
          if (watchlist.some((item) => item.ticker === ticker)) continue;
          watchlist = [
            ...watchlist,
            { ticker, addedAt: new Date().toISOString(), position: watchlist.length },
          ];
          touchTickerStatus(ticker);
        }
        return [...watchlist];
      },
    },
    market: {
      getBars: async (request: GetBarsRequest) => {
        if (!isGetBarsRequest(request)) {
          throw new Error('Petición de velas inválida (ticker o rango de fechas).');
        }
        const key = request.ticker.trim().toUpperCase();
        let bars = generateBars(key);
        if (request.desde) bars = bars.filter((bar) => bar.date >= request.desde!);
        if (request.hasta) bars = bars.filter((bar) => bar.date <= request.hasta!);
        return { ticker: key, source: SIMULATED_SOURCE, bars };
      },
      refreshNow: async () => ({ accepted: true, reason: null }),
      onUpdated: (listener) => subscribe(marketUpdatedListeners, listener),
    },
    macro: {
      getSeries: async (query?: MacroSeriesQuery) => {
        const desde = query && isIsoDate(query.desde) ? query.desde : null;
        return macroSeries.map((series) => ({
          ...series,
          observations: desde
            ? series.observations.filter((obs) => obs.date >= desde)
            : series.observations,
          status: statuses.get(dataStatusKey.macro(series.id)) ?? series.status,
        }));
      },
    },
    dataStatus: {
      get: async () => [...statuses.values()].sort((a, b) => a.key.localeCompare(b.key)),
      onChanged: (listener) => subscribe(dataStatusListeners, listener),
    },
  };
  return {
    api,
    emitConnectivity,
    emitAgents,
    emitHeartbeat(at: string) {
      agents = { ...agents, lastHeartbeatAt: at };
      heartbeatListeners.forEach((listener) => listener(at));
    },
    /** Fusiona el estado del dato y notifica por dataStatus:changed. */
    emitDataStatus(entry: DataStatusEntry) {
      setStatus({ ...statuses.get(entry.key), ...entry }, true);
    },
    /** Notifica un market:updated, p. ej. tras el refresco diario. */
    emitMarketUpdated(event: MarketUpdatedEvent) {
      marketUpdatedListeners.forEach((listener) => listener(event));
    },
    listenerCount: () =>
      connectionListeners.size +
      agentListeners.size +
      heartbeatListeners.size +
      dataStatusListeners.size +
      marketUpdatedListeners.size,
  };
}
