-- migrate:up
-- Esquema de dominio de Tradia (fase 0-1): series OHLCV, noticias, señales y diario.

CREATE TABLE series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  -- Fecha de la vela en ISO 8601 (YYYY-MM-DD para datos diarios).
  fecha TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  -- Procedencia del dato (p. ej. 'yahoo', 'alphavantage').
  fuente TEXT NOT NULL,
  UNIQUE (ticker, fecha, fuente)
);
CREATE INDEX idx_series_ticker_fecha ON series (ticker, fecha);

CREATE TABLE noticias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuente TEXT NOT NULL,
  url TEXT NOT NULL,
  titulo TEXT NOT NULL,
  -- Fecha de publicación en ISO 8601.
  publicado TEXT NOT NULL,
  -- Hash del contenido para deduplicar la misma noticia entre ingestas.
  hash TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_noticias_publicado ON noticias (publicado);

CREATE TABLE senales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  -- Fecha de la señal en ISO 8601.
  fecha TEXT NOT NULL,
  direccion TEXT NOT NULL CHECK (direccion IN ('compra', 'venta', 'mantener')),
  probabilidad REAL NOT NULL CHECK (probabilidad BETWEEN 0 AND 1),
  estrategia TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'activa', 'ejecutada', 'descartada', 'expirada')),
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_senales_ticker_fecha ON senales (ticker, fecha);
CREATE INDEX idx_senales_estado ON senales (estado);

CREATE TABLE diario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Fecha de la entrada en ISO 8601.
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('operacion', 'paper')),
  ticker TEXT NOT NULL,
  motivo TEXT NOT NULL,
  -- Carga extra en JSON (precio, cantidad, señal de origen...).
  datos TEXT,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_diario_fecha ON diario (fecha);

-- migrate:down
DROP TABLE IF EXISTS diario;
DROP TABLE IF EXISTS senales;
DROP TABLE IF EXISTS noticias;
DROP TABLE IF EXISTS series;
