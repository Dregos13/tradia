/**
 * Contrato IPC de Tradia — Fase 0-1.
 *
 * Única fuente de verdad para los canales entre el renderer y el proceso
 * principal. El preload (`src/preload/index.ts`) expone solo `window.tradia`
 * con la forma de `TradiaApi`; los handlers viven en `src/main/services/*`.
 *
 * Reglas del contrato:
 * - Todo `invoke` va validado en el proceso principal con los guardas de aquí.
 * - Los eventos (`changed`, `heartbeat`) solo fluyen main → renderer.
 * - `secrets` no tiene lectura: el renderer puede escribir, comprobar y borrar
 *   claves, pero nunca recuperarlas.
 */

export const IPC_CHANNELS = {
  connectivity: {
    getState: 'connectivity:get-state',
    checkNow: 'connectivity:check-now',
    /** Evento main → renderer: el estado de conexión cambió. */
    changed: 'connectivity:changed',
  },
  notifications: {
    send: 'notifications:send',
    test: 'notifications:test',
    getPrefs: 'notifications:get-prefs',
    setPrefs: 'notifications:set-prefs',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
  },
  secrets: {
    setKey: 'secrets:set-key',
    hasKey: 'secrets:has-key',
    deleteKey: 'secrets:delete-key',
    // Sin canal de lectura a propósito.
  },
  agents: {
    pause: 'agents:pause',
    resume: 'agents:resume',
    getState: 'agents:get-state',
    /** Evento main → renderer: cambió el estado de los agentes. */
    changed: 'agents:changed',
    /** Evento main → renderer: latido del planificador (ISO 8601). */
    heartbeat: 'agents:heartbeat',
  },
} as const;

// ---------------------------------------------------------------------------
// Dominio: conectividad
// ---------------------------------------------------------------------------

export type ConnectivityStatus = 'online' | 'offline' | 'checking';

export interface ConnectivityState {
  status: ConnectivityStatus;
  /** Última comprobación (ISO 8601) o null si todavía no se ha comprobado. */
  lastCheckedAt: string | null;
  /** Próximo reintento (ISO 8601) cuando hay espera exponencial, si aplica. */
  nextRetryAt: string | null;
  /** Número de reintento actual (0 en línea). */
  attempt: number;
}

// ---------------------------------------------------------------------------
// Dominio: notificaciones
// ---------------------------------------------------------------------------

export const NOTIFICATION_LEVELS = ['info', 'alerta', 'critica'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export interface NotificationPayload {
  level: NotificationLevel;
  title: string;
  body: string;
}

/** Preferencias por nivel; `critica` se muestra siempre salvo desactivación explícita. */
export interface NotificationPrefs {
  info: boolean;
  alerta: boolean;
  critica: boolean;
}

// ---------------------------------------------------------------------------
// Dominio: ajustes
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Iniciar Tradia con el sistema operativo. */
  autostart: boolean;
  /** Versión del aviso de riesgo aceptada, o null si aún no se ha aceptado. */
  disclaimerAcceptedVersion: string | null;
  /** Fecha ISO 8601 generada por main; el renderer no puede escribirla. */
  disclaimerAcceptedAt: string | null;
}

/** Solo estas claves son escribibles desde el renderer. */
export interface SettingsPatch {
  autostart?: boolean;
  disclaimerAcceptedVersion?: string | null;
}

// ---------------------------------------------------------------------------
// Dominio: agentes / planificador
// ---------------------------------------------------------------------------

export interface AgentsState {
  paused: boolean;
  /** 'usuario' si se pausó a mano, 'sin-conexion' si la pausó el vigilante. */
  pauseReason: 'usuario' | 'sin-conexion' | null;
  /** Último latido del planificador (ISO 8601). */
  lastHeartbeatAt: string | null;
}

// ---------------------------------------------------------------------------
// API expuesta al renderer como window.tradia
// ---------------------------------------------------------------------------

export interface TradiaApi {
  connectivity: {
    getState(): Promise<ConnectivityState>;
    checkNow(): Promise<ConnectivityState>;
    onChanged(listener: (state: ConnectivityState) => void): () => void;
  };
  notifications: {
    send(payload: NotificationPayload): Promise<void>;
    test(level: NotificationLevel): Promise<void>;
    getPrefs(): Promise<NotificationPrefs>;
    setPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: SettingsPatch): Promise<AppSettings>;
  };
  secrets: {
    setKey(provider: string, apiKey: string): Promise<void>;
    hasKey(provider: string): Promise<boolean>;
    deleteKey(provider: string): Promise<void>;
  };
  agents: {
    pause(): Promise<AgentsState>;
    resume(): Promise<AgentsState>;
    getState(): Promise<AgentsState>;
    onChanged(listener: (state: AgentsState) => void): () => void;
    onHeartbeat(listener: (at: string) => void): () => void;
  };
}

// ---------------------------------------------------------------------------
// Validación de entrada externa (lado main)
// ---------------------------------------------------------------------------

export class IpcValidationError extends Error {
  constructor(channel: string, detail: string) {
    super(`${channel}: entrada inválida (${detail})`);
    this.name = 'IpcValidationError';
  }
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return typeof value === 'string' && (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

export function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isNotificationLevel(v.level) && isNonEmptyString(v.title) && typeof v.body === 'string';
}

export function isNotificationPrefs(value: unknown): value is NotificationPrefs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.info === 'boolean' && typeof v.alerta === 'boolean' && typeof v.critica === 'boolean'
  );
}

export function isSettingsPatch(value: unknown): value is SettingsPatch {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  if (keys.some((k) => k !== 'autostart' && k !== 'disclaimerAcceptedVersion')) return false;
  if ('autostart' in v && typeof v.autostart !== 'boolean') return false;
  if (
    'disclaimerAcceptedVersion' in v &&
    v.disclaimerAcceptedVersion !== null &&
    typeof v.disclaimerAcceptedVersion !== 'string'
  ) {
    return false;
  }
  return true;
}

/** Lista plana de todos los canales, para pruebas y comprobaciones. */
export function allIpcChannels(): string[] {
  const channels: string[] = [];
  for (const group of Object.values(IPC_CHANNELS)) {
    for (const channel of Object.values(group)) {
      channels.push(channel);
    }
  }
  return channels;
}
