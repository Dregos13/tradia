-- migrate:up
-- Velas de 1 hora para estudiar el mercado (Mercado › 1 h). Son una vista
-- de estudio: se descargan bajo demanda y se guardan para no volver a
-- pedir lo que ya se tiene. Las velas diarias siguen en `bars`.
CREATE TABLE intraday_bars (
  ticker TEXT NOT NULL,
  provider TEXT NOT NULL,
  ts TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (ticker, provider, ts)
) WITHOUT ROWID;

-- migrate:down
DROP TABLE IF EXISTS intraday_bars;
