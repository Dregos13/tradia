-- migrate:up
-- Noticias, fuentes y calendario (fase 1b): fuentes configurables (RSS, APIs
-- y conectores oficiales), titulares deduplicados con sus fuentes y activos,
-- eventos del calendario económico y registro de avisos enviados.
-- La tabla `noticias` de la fase 0-1 queda intacta: el feed nuevo usa
-- `news_items` y no se pierde ningún dato previo.

-- Fuente de noticias configurable desde la pantalla Fuentes. Las claves de
-- API nunca se guardan aquí: viven cifradas en `secrets`.
CREATE TABLE news_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nombre visible elegido por el usuario o por el catálogo de oficiales.
  nombre TEXT NOT NULL,
  -- Tipo lógico: 'rss' (feed RSS/Atom), 'api' (Finnhub, Alpha Vantage,
  -- NewsAPI, GDELT), 'oficial' (Fed, BCE, BLS, BEA, SEC EDGAR, CNMV),
  -- 'redes' (sociales vía RSS; nunca confirman una noticia por sí solas).
  tipo TEXT NOT NULL CHECK (tipo IN ('rss', 'api', 'oficial', 'redes')),
  -- Conector que la lee ('rss', 'finnhub', 'sec-edgar'...); el registro de
  -- conectores vive en el proceso principal.
  conector TEXT NOT NULL,
  -- URL del feed o endpoint; NULL en conectores de endpoint propio (oficiales).
  url TEXT,
  -- Parámetros del conector en JSON (formulario EDGAR, consulta, tickers...).
  params TEXT NOT NULL DEFAULT '{}',
  -- Fiabilidad editorial según la regla de calidad de la sección 5.4 del plan.
  fiabilidad TEXT NOT NULL CHECK (fiabilidad IN ('oficial', 'agencia', 'prensa', 'redes')),
  -- Segundos entre lecturas; el programador además respeta el límite del conector.
  intervalo_segundos INTEGER NOT NULL DEFAULT 300 CHECK (intervalo_segundos >= 60),
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1)),
  -- Resultado de la última lectura o prueba de conexión.
  ultimo_estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (ultimo_estado IN ('pendiente', 'ok', 'error')),
  ultimo_error TEXT,
  -- Última lectura correcta (ISO 8601); NULL si aún no hubo ninguna.
  ultima_lectura TEXT,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_news_sources_activa ON news_sources (activa);

-- Titular deduplicado: la misma noticia desde varias fuentes es una sola
-- fila (el `hash` la agrupa) y sus fuentes quedan en `news_item_sources`.
CREATE TABLE news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  -- URL canónica normalizada por el conector; NULL si la fuente no la da.
  url TEXT,
  -- Fecha de publicación en ISO 8601 UTC.
  publicado TEXT NOT NULL,
  resumen TEXT,
  -- Prioridad asignada por las reglas de la sección 6 del plan.
  prioridad TEXT NOT NULL DEFAULT 'baja'
    CHECK (prioridad IN ('maxima', 'media', 'activo', 'baja')),
  -- 1 solo si la respalda una fuente 'oficial' o 'agencia': una noticia que
  -- solo viene de 'redes' nunca queda confirmada.
  confirmada INTEGER NOT NULL DEFAULT 0 CHECK (confirmada IN (0, 1)),
  -- Hash del contenido normalizado (título + URL canónica): deduplica entre
  -- fuentes y entre pasadas del programador.
  hash TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_news_items_publicado ON news_items (publicado);
CREATE INDEX idx_news_items_prioridad ON news_items (prioridad, publicado);

-- Fuentes que trajeron cada titular: al quitar una fuente se borran sus
-- enlaces pero la noticia permanece en el feed.
CREATE TABLE news_item_sources (
  item_id INTEGER NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES news_sources (id) ON DELETE CASCADE,
  -- Instante en que esta fuente aportó el titular (ISO 8601).
  visto_en TEXT NOT NULL,
  PRIMARY KEY (item_id, source_id)
);
CREATE INDEX idx_news_item_sources_source ON news_item_sources (source_id);

-- Activos relacionados con el titular (tickers de la lista de seguimiento o
-- mencionados en el texto por las reglas de la sección 6).
CREATE TABLE news_item_assets (
  item_id INTEGER NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  PRIMARY KEY (item_id, ticker)
);
CREATE INDEX idx_news_item_assets_ticker ON news_item_assets (ticker);

-- Eventos del calendario económico y de resultados: los de fecha por regla
-- se calculan; FOMC, IPC, PCE, PIB y OPEP salen de las fechas publicadas por
-- cada organismo y los resultados del calendario de Finnhub si hay clave.
CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Tipo de evento del catálogo del contrato IPC ('fomc', 'nfp', 'ipc',
  -- 'pce', 'pib', 'pmi', 'eia', 'opep', 'vencimiento', 'resultados'...).
  tipo TEXT NOT NULL CHECK (tipo IN (
    'fomc', 'banco-central', 'nfp', 'ipc', 'pce', 'pib', 'pmi',
    'eia', 'opep', 'vencimiento', 'resultados', 'otro'
  )),
  titulo TEXT NOT NULL,
  -- Instante UTC del evento (ISO 8601).
  fecha_utc TEXT NOT NULL,
  impacto TEXT NOT NULL CHECK (impacto IN ('alto', 'medio', 'bajo')),
  -- País o área ('US', 'EA', 'ES'...); NULL en eventos globales (OPEP,
  -- vencimientos).
  pais TEXT,
  -- Activo relacionado en resultados; NULL en eventos macro.
  activo TEXT,
  -- Procedencia: 'regla' (fecha calculada), 'oficial' (fecha publicada por
  -- el organismo), 'finnhub' (resultados) o 'simulado' (modo de pruebas).
  origen TEXT NOT NULL,
  -- Clave de deduplicación: el mismo evento calculado por regla y publicado
  -- por la fuente oficial se guarda una sola vez.
  clave TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_calendar_events_fecha ON calendar_events (fecha_utc);

-- Registro de avisos enviados: la clave única impide repetir una
-- notificación (aviso previo de un evento, aviso de noticia crítica) aunque
-- el programador corra en segundo plano o la app se reinicie.
CREATE TABLE notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Clave única del aviso: 'evento-previo:<evento_id>',
  -- 'noticia-critica:<item_id>'.
  clave TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL CHECK (tipo IN ('evento-previo', 'noticia-critica')),
  -- calendar_events.id o news_items.id según el tipo; NULL en avisos sueltos.
  ref_id INTEGER,
  nivel TEXT NOT NULL CHECK (nivel IN ('info', 'alerta', 'critica')),
  -- Texto enviado a la notificación nativa; la prueba E2E lo lee de aquí.
  titulo TEXT,
  cuerpo TEXT,
  enviado_en TEXT NOT NULL
);
CREATE INDEX idx_notification_log_enviado ON notification_log (enviado_en);

-- migrate:down
DROP TABLE IF EXISTS notification_log;
DROP TABLE IF EXISTS calendar_events;
DROP TABLE IF EXISTS news_item_assets;
DROP TABLE IF EXISTS news_item_sources;
DROP TABLE IF EXISTS news_items;
DROP TABLE IF EXISTS news_sources;
