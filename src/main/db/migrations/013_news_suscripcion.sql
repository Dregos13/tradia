-- migrate:up
-- Continuación de la fase 6-7 · análisis de noticias por suscripción:
-- la CLI de Claude Code (proveedor 'suscripcion') produce análisis con
-- `analizador = 'suscripcion'` y el CHECK de la 011 solo admitía
-- ('llm', 'local'). SQLite no permite ALTER de un CHECK, así que la
-- tabla se recrea con el CHECK ampliado copiando todas las filas
-- (sin pérdida; los análisis ya guardados conservan su id y fecha).
-- Mismo esquema que la 011: columnas, UNIQUE (noticia_id, ticker), FK
-- con borrado en cascada e índice de lectura.

CREATE TABLE news_analysis_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  noticia_id INTEGER NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  resumen TEXT NOT NULL,
  sentimiento TEXT NOT NULL
    CHECK (sentimiento IN ('positivo', 'negativo', 'neutro', 'mixto')),
  -- Quién lo produjo: 'llm' (API de Anthropic), 'local' (léxico) o
  -- 'suscripcion' (CLI de Claude Code); el LLM y la suscripción anotan
  -- el modelo exacto, el local deja NULL.
  analizador TEXT NOT NULL CHECK (analizador IN ('llm', 'local', 'suscripcion')),
  modelo TEXT,
  analizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (noticia_id, ticker)
);
INSERT INTO news_analysis_new (id, noticia_id, ticker, resumen, sentimiento, analizador, modelo, analizado_en)
  SELECT id, noticia_id, ticker, resumen, sentimiento, analizador, modelo, analizado_en
  FROM news_analysis;
DROP TABLE news_analysis;
ALTER TABLE news_analysis_new RENAME TO news_analysis;
CREATE INDEX idx_news_analysis_ticker ON news_analysis (ticker, analizado_en);

-- migrate:down
-- Vuelve al CHECK de la 011. Las filas hechas por la suscripción se
-- rotulan 'llm' para que el CHECK antiguo las acepte: ningún análisis
-- se pierde al revertir (solo se difumina el método en esas filas).
UPDATE news_analysis SET analizador = 'llm' WHERE analizador = 'suscripcion';

CREATE TABLE news_analysis_old (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  noticia_id INTEGER NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  resumen TEXT NOT NULL,
  sentimiento TEXT NOT NULL
    CHECK (sentimiento IN ('positivo', 'negativo', 'neutro', 'mixto')),
  analizador TEXT NOT NULL CHECK (analizador IN ('llm', 'local')),
  modelo TEXT,
  analizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (noticia_id, ticker)
);
INSERT INTO news_analysis_old (id, noticia_id, ticker, resumen, sentimiento, analizador, modelo, analizado_en)
  SELECT id, noticia_id, ticker, resumen, sentimiento, analizador, modelo, analizado_en
  FROM news_analysis;
DROP TABLE news_analysis;
ALTER TABLE news_analysis_old RENAME TO news_analysis;
CREATE INDEX idx_news_analysis_ticker ON news_analysis (ticker, analizado_en);
