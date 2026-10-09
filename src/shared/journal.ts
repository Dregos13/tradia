/**
 * Dominio del diario automático (fase 4) — contrato compartido.
 *
 * `journal_entries` (migración 008) registra todo lo que hace el sistema:
 * cada señal, veto, contradicción, operación simulada, resumen de la
 * rutina, límite alcanzado y error, con su motivo, los datos usados, el
 * resultado, los errores y el cumplimiento de reglas. Lo escribe el
 * servicio de `src/main/journal/` (`record()`); el resto de servicios lo
 * consume y la página «Diario» lo consulta y exporta a CSV.
 *
 * Este archivo también fija la configuración compartida de los canales de
 * entrega (escritorio, Telegram, correo), la rutina diaria y las copias de
 * seguridad, que las tareas de delivery/routine/backup implementan sin
 * volver a tocar los archivos comunes.
 */

// ---------------------------------------------------------------------------
// Entradas del diario
// ---------------------------------------------------------------------------

/** Tipos de entrada del diario; coincide con el CHECK de la tabla. */
export const JOURNAL_ENTRY_TYPES = [
  'senal',
  'veto',
  'contradiccion',
  'operacion',
  'resumen',
  'error',
  'limite',
] as const;
export type JournalEntryType = (typeof JOURNAL_ENTRY_TYPES)[number];

/**
 * Resultados normalizados que puede tomar una entrada (columna
 * `resultado` y filtro «Resultado» del diario). Se interpretan por tipo:
 * decisiones de riesgo en señales y vetos, de la posición en operaciones,
 * de la rutina en resúmenes y del propio evento en límites y errores.
 */
export const JOURNAL_RESULTS = [
  // Decisiones del motor de riesgo (senal/veto).
  'aprobada',
  'reducida',
  'vetada',
  // Contradicción: las estrategias se cancelaron y no hubo señal.
  'sin-senal',
  // Operaciones simuladas cerradas.
  'ganancia',
  'perdida',
  'empate',
  // Resúmenes de la rutina diaria.
  'completado',
  'con-retraso',
  // Límite de riesgo alcanzado.
  'alcanzado',
  // Fallo registrado.
  'error',
] as const;
export type JournalResult = (typeof JOURNAL_RESULTS)[number];

/** Referencia a una estrategia en una entrada (con la versión evaluada). */
export interface JournalStrategyRef {
  strategyId: number;
  name: string;
  version: number;
}

/**
 * Cumplimiento de una regla en la entrada: el detalle del diario la
 * muestra como «Cumplida»/«Incumplida» con el valor observado frente al
 * límite. En reglas de riesgo `code` es un `VetoReasonCode`.
 */
export interface JournalRuleCheck {
  /** Código estable de la regla (p. ej. 'RR_TOO_LOW', 'MAX_DRAWDOWN'). */
  code: string;
  /** Nombre legible en español. */
  label: string;
  /** true = cumplida; false = incumplida. */
  cumplida: boolean;
  /** Valor observado, ya formateado; null cuando no aplica. */
  observed: string | null;
  /** Límite aplicable, ya formateado; null cuando no aplica. */
  limit: string | null;
}

/** Entrada del diario tal como la lee el renderer (`journal:list`/`get`). */
export interface JournalEntry {
  id: number;
  type: JournalEntryType;
  /** ISO 8601. */
  createdAt: string;
  /** Activo relacionado; null en resúmenes y errores generales. */
  ticker: string | null;
  /** Estrategias relacionadas con su versión; [] si no aplica. */
  strategies: JournalStrategyRef[];
  /** Motivo legible: por qué ocurrió. */
  reason: string;
  /**
   * Datos usados, por tipo: `SignalDataUsed` en 'senal', las dos propuestas
   * en 'contradiccion', conteos y marcadores en 'resumen'… null si no hay.
   */
  dataUsed: Record<string, unknown> | null;
  /** Resultado normalizado (filtro del diario); null cuando no aplica. */
  result: JournalResult | null;
  /** Errores legibles registrados; [] si ninguno. */
  errors: string[];
  /** Reglas evaluadas con su cumplimiento; [] si no aplica. */
  ruleChecks: JournalRuleCheck[];
  /** Señal relacionada (`signals.id`), si la hay. */
  signalId: number | null;
}

/**
 * Lo que los servicios le pasan a `journal.record()`: la forma mínima de
 * una entrada. `signalId` enlaza la entrada con la señal persistida.
 */
export interface JournalRecordInput {
  type: JournalEntryType;
  ticker?: string | null;
  strategies?: JournalStrategyRef[];
  reason: string;
  dataUsed?: Record<string, unknown> | null;
  result?: JournalResult | null;
  errors?: string[];
  ruleChecks?: JournalRuleCheck[];
  signalId?: number | null;
}

/** Tope del parámetro `limit` de `journal:list` y de la exportación. */
export const JOURNAL_LIST_MAX_LIMIT = 1_000;

/** Filtros de `journal:list`; todos opcionales y combinables. */
export interface JournalListQuery {
  /** Rango por fecha de creación, ambos inclusive ('YYYY-MM-DD'). */
  desde?: string;
  hasta?: string;
  type?: JournalEntryType;
  ticker?: string;
  /** Entradas relacionadas con una estrategia concreta. */
  strategyId?: number;
  result?: JournalResult;
  /** Máximo de resultados; tope `JOURNAL_LIST_MAX_LIMIT`. */
  limit?: number;
  /** Desplazamiento para paginar (≥ 0). */
  offset?: number;
}

/** Página de resultados de `journal:list` (con recuento total filtrado). */
export interface JournalPage {
  entries: JournalEntry[];
  /** Total de entradas que cumplen el filtro (sin paginar). */
  total: number;
  limit: number;
  offset: number;
}

/**
 * Petición de `journal:export-csv`. `path` solo se respeta en modo E2E:
 * en la app normal el proceso principal abre el diálogo de guardar.
 */
export interface JournalExportRequest {
  query?: JournalListQuery;
  /** Ruta de destino forzada (solo TRADIA_E2E sin empaquetar). */
  path?: string;
}

/** Resultado de la exportación a CSV. */
export interface JournalExportResult {
  /** true si el usuario canceló el diálogo (no se creó archivo). */
  canceled: boolean;
  /** Ruta del archivo escrito; null si se canceló o falló. */
  path: string | null;
  /** Filas exportadas (sin contar la cabecera). */
  entries: number;
}

/** Evento `journal:updated`: se añadió una entrada al diario. */
export interface JournalUpdatedEvent {
  entry: JournalEntry;
}

// ---------------------------------------------------------------------------
// Configuración de canales de entrega
// ---------------------------------------------------------------------------

/** Canales por los que sale un aviso. 'escritorio' usa notifications. */
export const DELIVERY_CHANNELS = ['escritorio', 'telegram', 'correo'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/** Canales con botón «Enviar prueba» (el escritorio ya tiene el suyo). */
export const DELIVERY_TESTABLE_CHANNELS = ['telegram', 'correo'] as const;
export type DeliveryTestableChannel = (typeof DELIVERY_TESTABLE_CHANNELS)[number];

/** Eventos que cada canal puede enviar (casilla por evento en ajustes). */
export const DELIVERY_EVENT_KINDS = [
  'senal-aprobada',
  'senal-vetada',
  'limite-alcanzado',
  'resumen-diario',
] as const;
export type DeliveryEventKind = (typeof DELIVERY_EVENT_KINDS)[number];

/** Todos los eventos activos por defecto cuando se enciende un canal. */
export const DELIVERY_EVENT_DEFAULTS: readonly DeliveryEventKind[] = DELIVERY_EVENT_KINDS;

/**
 * Proveedores del almacén de secretos para los canales: el token del bot
 * y la contraseña SMTP jamás viajan por `delivery:*`; se escriben y
 * comprueban por `secrets:set-key`/`has-key`/`delete-key` con estos nombres.
 */
export const DELIVERY_SECRET_KEYS = {
  telegramBotToken: 'telegram-bot-token',
  emailPassword: 'correo-smtp-password',
} as const;

export const DELIVERY_CHAT_ID_MAX_LENGTH = 128;
export const DELIVERY_HOST_MAX_LENGTH = 255;
export const DELIVERY_ADDRESS_MAX_LENGTH = 320;

/** Seguridad de la conexión SMTP. */
export const SMTP_SECURITY_MODES = ['tls', 'starttls', 'ninguna'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

/** Configuración de Telegram tal como la devuelve `delivery:get-config`. */
export interface TelegramChannelConfig {
  enabled: boolean;
  /** Chat destino (id numérico o @canal). */
  chatId: string;
  /** Eventos que salen por este canal. */
  events: DeliveryEventKind[];
  /** true si hay token del bot guardado en secretos (nunca el valor). */
  hasToken: boolean;
}

/** Configuración del correo tal como la devuelve `delivery:get-config`. */
export interface EmailChannelConfig {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Usuario/remitente de la cuenta SMTP. */
  user: string;
  /** Destinatario de los avisos. */
  to: string;
  events: DeliveryEventKind[];
  /** true si hay contraseña guardada en secretos (nunca el valor). */
  hasPassword: boolean;
}

/** Lectura de `delivery:get-config`: sin secretos, solo «guardado». */
export interface DeliveryConfig {
  telegram: TelegramChannelConfig;
  email: EmailChannelConfig;
}

/** Escritura de `delivery:set-config`: nunca incluye secretos. */
export interface TelegramChannelInput {
  enabled: boolean;
  chatId: string;
  events: DeliveryEventKind[];
}

export interface EmailChannelInput {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  to: string;
  events: DeliveryEventKind[];
}

export interface DeliveryConfigInput {
  telegram: TelegramChannelInput;
  email: EmailChannelInput;
}

/** Configuración por defecto: canales externos desactivados y vacíos. */
export const DELIVERY_CONFIG_DEFAULTS: DeliveryConfigInput = {
  telegram: { enabled: false, chatId: '', events: [...DELIVERY_EVENT_DEFAULTS] },
  email: {
    enabled: false,
    host: '',
    port: 587,
    security: 'starttls',
    user: '',
    to: '',
    events: [...DELIVERY_EVENT_DEFAULTS],
  },
};

/** Petición de `delivery:test` («Enviar prueba» por canal). */
export interface DeliveryTestRequest {
  channel: DeliveryTestableChannel;
}

/** Resultado de la prueba de envío; `error` nunca incluye credenciales. */
export interface DeliveryTestResult {
  ok: boolean;
  /** Motivo legible del fallo, accionable y sin secretos; null si ok. */
  error: string | null;
  /** Latencia del envío en ms; null si no se pudo medir. */
  latencyMs: number | null;
}

// ---------------------------------------------------------------------------
// Configuración de la rutina diaria
// ---------------------------------------------------------------------------

/** Las tres tareas de la rutina diaria de los agentes. */
export const ROUTINE_KINDS = ['preapertura', 'cierre', 'conciliacion'] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

/** Zona fija de la rutina en esta fase: la bolsa de Nueva York. */
export const ROUTINE_TIMEZONE = 'America/New_York';

/** Horas 'HH:MM' (24 h) en ROUTINE_TIMEZONE. */
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Horarios de la rutina ('HH:MM' en America/New_York). */
export interface RoutineConfig {
  /** Resumen previo a la apertura (por defecto 08:30). */
  preapertura: string;
  /** Revisión al cierre (por defecto 16:15). */
  cierre: string;
  /** Conciliación posterior (por defecto 17:30). */
  conciliacion: string;
}

export const ROUTINE_DEFAULTS: RoutineConfig = {
  preapertura: '08:30',
  cierre: '16:15',
  conciliacion: '17:30',
};

/** Resultado del gancho de desarrollo `routine:advance-clock`. */
export interface RoutineClockAdvanceResult {
  /** Instante del reloj interno tras el avance (ISO 8601). */
  now: string;
}

// ---------------------------------------------------------------------------
// Copias de seguridad y registros
// ---------------------------------------------------------------------------

/** Carpeta de copias dentro de userData y retención (plan de la fase). */
export const BACKUP_DIR_NAME = 'backups';
export const BACKUP_RETENTION_COUNT = 7;
/** Copia programada diaria ('HH:MM' local del equipo). */
export const BACKUP_SCHEDULE_HHMM = '02:00';

/** Carpeta y límites del registro rotado dentro de userData. */
export const LOG_DIR_NAME = 'logs';
export const LOG_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const LOG_MAX_FILES = 5;

/**
 * Nombre seguro de archivo de copia: basename '.db' sin separadores ni
 * '..', así `backup:restore` no puede salir de la carpeta de copias.
 */
export const BACKUP_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.db$/;

/** Una copia de seguridad de la base local (`backup:list`). */
export interface BackupInfo {
  /** Nombre del archivo dentro de userData/backups. */
  fileName: string;
  sizeBytes: number;
  /** Creación de la copia (ISO 8601). */
  createdAt: string;
  /** Versión de esquema de la copia (última migración aplicada). */
  schemaVersion: number;
  /** true si PRAGMA integrity_check la da por íntegra. */
  integrityOk: boolean;
}

/**
 * Restauración (`backup:restore`): exige confirmación explícita. El
 * proceso principal guarda antes una copia del estado actual, sustituye
 * la base y reinicia la app.
 */
export interface BackupRestoreRequest {
  fileName: string;
  /** Confirmación explícita del usuario; tiene que ser true. */
  confirm: true;
}

/** Respuesta de `backup:restore`: la app se reinicia justo después. */
export interface BackupRestoreResult {
  /** true si la copia pasó la validación y la restauración arrancó. */
  accepted: boolean;
}

/** Respuesta de `logs:open-folder` (también sirve para la carpeta de copias). */
export interface OpenFolderResult {
  ok: boolean;
  /** Ruta absoluta de la carpeta (seleccionable para copiar si falla). */
  path: string;
}
