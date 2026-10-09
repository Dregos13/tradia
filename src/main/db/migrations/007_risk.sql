-- migrate:up
-- Motor de riesgo (fase 3): límites configurados por el usuario, registro
-- de vetos, historial de la parada de emergencia, cartera simulada y curva
-- de capital para los límites de pérdida y el drawdown.

-- Una sola fila (singleton id = 1): los límites efectivos. El repositorio
-- escribe los RISK_DEFAULTS la primera vez; la IA y las estrategias no
-- tocan esta tabla (los límites solo entran por risk:set-limits). Los
-- CHECK fijan en la base los márgenes duros del contrato (RISK_BOUNDS).
CREATE TABLE risk_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- % del capital arriesgado por operación (margen duro 0,5–2).
  risk_per_trade_pct REAL NOT NULL CHECK (risk_per_trade_pct BETWEEN 0.5 AND 2),
  -- Ratio beneficio/riesgo mínimo; no se puede bajar de 2.
  min_reward_risk_ratio REAL NOT NULL CHECK (min_reward_risk_ratio BETWEEN 2 AND 10),
  -- Pérdidas máximas toleradas por periodo (% del capital).
  max_daily_loss_pct REAL NOT NULL CHECK (max_daily_loss_pct BETWEEN 0.5 AND 5),
  max_weekly_loss_pct REAL NOT NULL CHECK (max_weekly_loss_pct BETWEEN 1 AND 10),
  max_monthly_loss_pct REAL NOT NULL CHECK (max_monthly_loss_pct BETWEEN 2 AND 15),
  -- Drawdown máximo (%); alcanzarlo activa la parada de emergencia.
  max_drawdown_pct REAL NOT NULL CHECK (max_drawdown_pct BETWEEN 2 AND 25),
  -- Posiciones abiertas simultáneas.
  max_open_positions INTEGER NOT NULL CHECK (max_open_positions BETWEEN 1 AND 10),
  -- Exposición máxima (% del capital) por activo, por sector y en
  -- divisas distintas de USD.
  max_asset_exposure_pct REAL NOT NULL CHECK (max_asset_exposure_pct BETWEEN 5 AND 40),
  max_sector_exposure_pct REAL NOT NULL CHECK (max_sector_exposure_pct BETWEEN 10 AND 60),
  max_currency_exposure_pct REAL NOT NULL CHECK (max_currency_exposure_pct BETWEEN 5 AND 50),
  -- Correlación máxima admitida entre posiciones (Pearson a 60 días).
  max_correlation REAL NOT NULL CHECK (max_correlation BETWEEN 0.1 AND 0.9),
  -- Apalancamiento fijo 1x: el CHECK lo hace imposible de cambiar.
  max_leverage REAL NOT NULL CHECK (max_leverage = 1),
  -- Tamaño máximo como % del volumen medio de 20 días.
  max_liquidity_pct REAL NOT NULL CHECK (max_liquidity_pct BETWEEN 0.1 AND 5),
  updated_at TEXT NOT NULL
);

-- Registro de vetos: una fila por regla incumplida de cada señal, con el
-- código estable (VetoReasonCode), el motivo legible y los valores.
CREATE TABLE risk_vetoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Instantánea de la señal evaluada (JSON SignalIntent).
  senal TEXT NOT NULL,
  ticker TEXT NOT NULL,
  -- 'vetada' bloquea la señal; 'reducida' la deja pasar con tamaño menor.
  decision TEXT NOT NULL CHECK (decision IN ('vetada', 'reducida')),
  -- Código de la regla incumplida (VetoReasonCode del contrato).
  codigo TEXT NOT NULL,
  -- Motivo legible en español (VETO_REASON_MESSAGES[codigo]).
  motivo TEXT NOT NULL,
  -- Valores que explican el veto (JSON: límite y valor real).
  detalles TEXT NOT NULL DEFAULT '{}',
  -- Tamaño calculado antes del veto (0 cuando no procede).
  tamano REAL NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_risk_vetoes_creado ON risk_vetoes (creado_en);
CREATE INDEX idx_risk_vetoes_codigo ON risk_vetoes (codigo, creado_en);
CREATE INDEX idx_risk_vetoes_ticker ON risk_vetoes (ticker, creado_en);

-- Historial de la parada de emergencia: el estado actual es el de la
-- última acción ('activada' o 'reanudada'), así sobrevive al reinicio.
-- La reanudación siempre la firma el usuario con confirmación explícita.
CREATE TABLE kill_switch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accion TEXT NOT NULL CHECK (accion IN ('activada', 'reanudada')),
  -- Causa: 'manual' o una de las automáticas (KillSwitchCause).
  causa TEXT NOT NULL CHECK (
    causa IN ('manual', 'perdida-anomala', 'dato-anomalo', 'sin-conexion', 'modelo-erratico')
  ),
  -- Quién la ejecutó: el usuario o un disparador automático.
  actor TEXT NOT NULL CHECK (actor IN ('usuario', 'automatico')),
  -- Detalle legible (qué umbral o dato la disparó, o la nota de la reanudación).
  detalle TEXT,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_kill_switch_events_creado ON kill_switch_events (creado_en);

-- Cartera simulada sobre la que evalúan los límites de pérdida y de
-- exposición. cerrada_en NULL = posición abierta.
CREATE TABLE risk_portfolio_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  direccion TEXT NOT NULL CHECK (direccion IN ('largo', 'corto')),
  entrada REAL NOT NULL CHECK (entrada > 0),
  stop REAL,
  objetivo REAL,
  tamano REAL NOT NULL CHECK (tamano > 0),
  -- Metadatos para los límites de exposición; sector NULL = desconocido.
  sector TEXT,
  divisa TEXT NOT NULL DEFAULT 'USD',
  abierta_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cerrada_en TEXT
);
CREATE INDEX idx_risk_positions_abiertas
  ON risk_portfolio_positions (ticker) WHERE cerrada_en IS NULL;

-- Puntos de la curva de capital de la cartera simulada: base del cálculo
-- de pérdida diaria/semanal/mensual y del drawdown máximo.
CREATE TABLE risk_equity_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Instante del punto de capital (ISO 8601).
  fecha TEXT NOT NULL UNIQUE,
  capital REAL NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_risk_equity_fecha ON risk_equity_history (fecha);

-- migrate:down
DROP TABLE IF EXISTS risk_equity_history;
DROP TABLE IF EXISTS risk_portfolio_positions;
DROP TABLE IF EXISTS kill_switch_events;
DROP TABLE IF EXISTS risk_vetoes;
DROP TABLE IF EXISTS risk_limits;
