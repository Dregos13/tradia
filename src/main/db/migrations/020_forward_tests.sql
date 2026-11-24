-- migrate:up
-- Pruebas en vivo del laboratorio: una estrategia, en una versión
-- congelada, corriendo con capital ficticio desde una fecha fija. El
-- resultado no se guarda: se recalcula repitiendo el motor de backtest
-- desde `start_date` con las velas reales que vayan llegando, así nunca
-- puede verse el futuro ni cambiar las reglas a posteriori.
CREATE TABLE forward_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  start_date TEXT NOT NULL,
  initial_cash REAL NOT NULL CHECK (initial_cash > 0),
  benchmark TEXT NOT NULL DEFAULT 'SPY',
  status TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa', 'detenida')),
  stopped_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX forward_tests_strategy ON forward_tests(strategy_id);

-- migrate:down
DROP INDEX IF EXISTS forward_tests_strategy;
DROP TABLE IF EXISTS forward_tests;
