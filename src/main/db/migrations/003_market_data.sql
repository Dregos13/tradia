-- migrate:up
-- Datos de mercado (fase 1): lista de seguimiento, velas OHLCV crudas y
-- ajustadas con su lote, acciones corporativas, lotes versionados, marcas de
-- calidad, series macro y estado de salud del dato.

CREATE TABLE watchlist (
  ticker TEXT PRIMARY KEY,
  -- Alta del activo en la lista (ISO 8601).
  alta TEXT NOT NULL,
  -- Orden de visualización, 0..n-1 compacto; se renumera al quitar.
  orden INTEGER NOT NULL UNIQUE
);

-- Lote de datos recibido de un proveedor. La versión sube cuando cambia el
-- contenido del mismo ámbito/proveedor; el hash permite detectarlo.
CREATE TABLE data_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- SHA-256 del contenido normalizado que originó el lote.
  hash TEXT NOT NULL,
  proveedor TEXT NOT NULL,
  -- Ámbito del lote: 'bars' (con ticker) o 'macro' (con serie).
  ambito TEXT NOT NULL CHECK (ambito IN ('bars', 'macro')),
  ticker TEXT,
  serie TEXT,
  -- Rango de fechas cubierto, ambos inclusive ('YYYY-MM-DD').
  desde TEXT NOT NULL,
  hasta TEXT NOT NULL,
  -- Instante en que se recibieron los datos del proveedor (ISO 8601).
  recibido_en TEXT NOT NULL,
  -- Resumen de calidad en JSON (esperadas, recibidas, huecos, duplicados, anomalías).
  resumen_calidad TEXT NOT NULL DEFAULT '{}',
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (ambito = 'bars' AND ticker IS NOT NULL AND serie IS NULL) OR
    (ambito = 'macro' AND serie IS NOT NULL AND ticker IS NULL)
  )
);
CREATE INDEX idx_data_batches_ambito_ref ON data_batches (ambito, ticker, serie);
CREATE INDEX idx_data_batches_recibido ON data_batches (recibido_en);

-- Velas diarias OHLCV. Los precios crudos llegan del proveedor; los ajustados
-- (hacia atrás por splits y dividendos) los calcula la limpieza y son NULL
-- hasta entonces. Único por ticker, fecha y fuente: un proveedor no puede
-- duplicar una sesión, el último lote recibido gana.
CREATE TABLE bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  -- Fecha de la sesión ('YYYY-MM-DD').
  fecha TEXT NOT NULL,
  fuente TEXT NOT NULL,
  lote_id INTEGER NOT NULL REFERENCES data_batches (id) ON DELETE CASCADE,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  adj_open REAL,
  adj_high REAL,
  adj_low REAL,
  adj_close REAL,
  adj_volume REAL,
  UNIQUE (ticker, fecha, fuente)
);
CREATE INDEX idx_bars_ticker_fecha ON bars (ticker, fecha);
CREATE INDEX idx_bars_lote ON bars (lote_id);

CREATE TABLE corporate_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  -- Fecha ex de la acción ('YYYY-MM-DD').
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('split', 'dividend')),
  -- split: acciones nuevas por cada antigua; dividend: efectivo por acción.
  valor REAL NOT NULL,
  fuente TEXT NOT NULL,
  UNIQUE (ticker, fecha, tipo, fuente)
);
CREATE INDEX idx_corporate_actions_ticker_fecha ON corporate_actions (ticker, fecha);

-- Marcas de calidad de un lote: los valores anómalos se marcan, no se borran.
CREATE TABLE quality_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lote_id INTEGER NOT NULL REFERENCES data_batches (id) ON DELETE CASCADE,
  ticker TEXT,
  serie TEXT,
  -- Fecha afectada ('YYYY-MM-DD'), si la marca apunta a una sesión concreta.
  fecha TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('hueco', 'duplicado', 'anomalo')),
  detalle TEXT,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_quality_flags_lote ON quality_flags (lote_id);

-- Series macroeconómicas de FRED: DFF, CPIAUCSL, DGS2, DGS10, T10Y2Y, VIXCLS.
CREATE TABLE macro_series (
  id TEXT PRIMARY KEY,
  fuente TEXT NOT NULL,
  nombre TEXT NOT NULL,
  unidad TEXT,
  frecuencia TEXT,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Los valores ausentes del proveedor ('.' en FRED) no se guardan.
CREATE TABLE macro_observations (
  serie_id TEXT NOT NULL REFERENCES macro_series (id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  valor REAL NOT NULL,
  lote_id INTEGER REFERENCES data_batches (id) ON DELETE SET NULL,
  PRIMARY KEY (serie_id, fecha)
);
CREATE INDEX idx_macro_observations_fecha ON macro_observations (fecha);

-- Salud del dato por clave: 'ticker:AAPL', 'macro:DFF', 'provider:tiingo'.
CREATE TABLE data_status (
  clave TEXT PRIMARY KEY,
  estado TEXT NOT NULL
    CHECK (estado IN ('fiable', 'actualizando', 'desactualizado', 'no-fiable')),
  -- Último dato correcto conocido (ISO 8601).
  ultimo_ok TEXT,
  fallos_seguidos INTEGER NOT NULL DEFAULT 0 CHECK (fallos_seguidos >= 0),
  motivo TEXT,
  actualizado_en TEXT NOT NULL
);

-- migrate:down
DROP TABLE IF EXISTS data_status;
DROP TABLE IF EXISTS macro_observations;
DROP TABLE IF EXISTS macro_series;
DROP TABLE IF EXISTS quality_flags;
DROP TABLE IF EXISTS corporate_actions;
DROP TABLE IF EXISTS bars;
DROP TABLE IF EXISTS data_batches;
DROP TABLE IF EXISTS watchlist;
