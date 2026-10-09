-- migrate:up
-- Fase 4 · señales informativas, panel y diario: señales emitidas por el
-- motor con su trazabilidad completa, diario automático y registro de las
-- rutinas enviadas por día (deduplicación al reiniciar o despertar).
-- Las tablas `senales` y `diario` de la fase 0 (andamio inicial, igual que
-- `noticias` frente a `news_items`) quedan sustituidas por estas y se
-- conservan intactas: migraciones reversibles, sin pérdida de datos.

-- Señal emitida por el motor al cierre de una vela. Se guarda también la
-- vetada: la decisión completa de la pasarela va en `decision` (JSON
-- RiskDecision) y su estado duplicado en `estado` para filtrar e indexar.
-- «Sin señal» por contradicción no produce fila aquí: va al diario.
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  direccion TEXT NOT NULL CHECK (direccion IN ('largo', 'corto')),
  entrada REAL NOT NULL CHECK (entrada > 0),
  stop REAL,
  objetivo REAL,
  -- Confianza agregada (media de las estrategias que coinciden). Se exige
  -- no negativa; un valor > 1 es anómalo y llega con decision vetada por
  -- SIGNAL_INVALID, pero queda registrado para la auditoría.
  confianza REAL NOT NULL CHECK (confianza >= 0),
  -- Motivo legible agregado de la señal.
  motivo TEXT NOT NULL,
  -- Estrategias y versiones que la respaldan (JSON SignalStrategyVote[]).
  estrategias TEXT NOT NULL DEFAULT '[]',
  -- Datos usados: ventana de velas, lote y versión limpia (JSON
  -- SignalDataUsed), para reproducir la señal contra el lote exacto.
  datos_usados TEXT NOT NULL DEFAULT '{}',
  -- Decisión completa del motor de riesgo (JSON RiskDecision).
  decision TEXT NOT NULL,
  -- Estado de la decisión, para filtrar e indexar.
  estado TEXT NOT NULL CHECK (estado IN ('aprobada', 'reducida', 'vetada')),
  -- Fecha de la vela cuyo cierre disparó la evaluación ('YYYY-MM-DD').
  vela_fecha TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Idempotencia: la misma vela del mismo activo no genera dos señales.
  UNIQUE (ticker, vela_fecha)
);
CREATE INDEX idx_signals_vela ON signals (vela_fecha);
CREATE INDEX idx_signals_estado ON signals (estado, creado_en);
CREATE INDEX idx_signals_creado ON signals (creado_en);

-- Diario automático: una fila por cada cosa que hace el sistema, con
-- motivo, datos usados, resultado, errores y cumplimiento de reglas. Los
-- payloads por tipo van en JSON (`datos`, `estrategias`, `errores`,
-- `reglas`); las columnas sueltas sirven para filtrar e indexar.
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (
    tipo IN ('senal', 'veto', 'contradiccion', 'operacion', 'resumen', 'error', 'limite')
  ),
  -- Activo relacionado; NULL en resúmenes y errores generales.
  ticker TEXT,
  -- Estrategia principal para filtrar; NULL si no aplica. La lista
  -- completa con versiones va en `estrategias` (JSON JournalStrategyRef[]).
  -- Sin FK a strategies: el diario es histórico y sobrevive a la ficha.
  estrategia_id INTEGER,
  estrategias TEXT NOT NULL DEFAULT '[]',
  -- Motivo legible: por qué ocurrió.
  motivo TEXT NOT NULL,
  -- Datos usados, por tipo (JSON; NULL cuando no hay).
  datos TEXT,
  -- Resultado normalizado para el filtro (JOURNAL_RESULTS del contrato);
  -- NULL cuando el tipo no tiene resultado ('error', avisos sin decisión).
  resultado TEXT,
  -- Errores legibles (JSON lista de texto).
  errores TEXT NOT NULL DEFAULT '[]',
  -- Reglas evaluadas con su cumplimiento (JSON JournalRuleCheck[]).
  reglas TEXT NOT NULL DEFAULT '[]',
  -- Señal relacionada, si la hay; sobrevive aunque la señal se borre.
  senal_id INTEGER REFERENCES signals (id) ON DELETE SET NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_journal_creado ON journal_entries (creado_en);
CREATE INDEX idx_journal_tipo ON journal_entries (tipo, creado_en);
CREATE INDEX idx_journal_ticker ON journal_entries (ticker, creado_en);
CREATE INDEX idx_journal_estrategia ON journal_entries (estrategia_id, creado_en);
CREATE INDEX idx_journal_resultado ON journal_entries (resultado, creado_en);

-- Registro de rutinas enviadas por día: la deduplicación de la rutina
-- diaria (resumen previo, revisión al cierre, conciliación). El UNIQUE por
-- (rutina, dia) garantiza «como mucho una vez al día» aunque la app se
-- reinicie o el equipo despierte tarde (entonces va con_retraso = 1).
CREATE TABLE routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rutina TEXT NOT NULL CHECK (rutina IN ('preapertura', 'cierre', 'conciliacion')),
  -- Día de mercado al que corresponde ('YYYY-MM-DD', zona America/New_York).
  dia TEXT NOT NULL,
  -- Instante real del envío (ISO 8601).
  enviada_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- 1 si se envió al despertar tras perder la hora programada.
  con_retraso INTEGER NOT NULL DEFAULT 0 CHECK (con_retraso IN (0, 1)),
  -- Entrada del diario que recoge el resumen enviado.
  journal_id INTEGER REFERENCES journal_entries (id) ON DELETE SET NULL,
  UNIQUE (rutina, dia)
);
CREATE INDEX idx_routine_runs_dia ON routine_runs (dia);

-- migrate:down
DROP TABLE IF EXISTS routine_runs;
DROP TABLE IF EXISTS journal_entries;
DROP TABLE IF EXISTS signals;
