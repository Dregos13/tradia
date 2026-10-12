-- migrate:up
-- IA predictiva y capital mínimo real (fases 6-7): régimen de mercado,
-- ficha y predicciones del modelo, análisis de noticias por activo,
-- revisiones de drift con propuestas de reentrenamiento y el estado del
-- modo real (lista de comprobación, límites escritos y modo).
--
-- Convenciones: las etiquetas de régimen, sentimientos, estados y claves
-- de requisito son literales del contrato compartido (src/shared/ai.ts y
-- src/shared/live.ts); los JSON guardados llevan la forma de los DTO de
-- allí. Todo lo persistido lo puede leer una versión nueva sin migrar.

-- Régimen estructurado en la ficha de estrategia -----------------------
-- Dos listas de etiquetas JSON del catálogo de cuatro ('tendencia',
-- 'lateral', 'volatilidad-alta', 'volatilidad-baja'): en cuáles funciona
-- y en cuáles falla. El texto libre `regimen` se conserva como descripción.
ALTER TABLE strategy_versions
  ADD COLUMN regimen_funciona_en TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(regimen_funciona_en) = 'array');
ALTER TABLE strategy_versions
  ADD COLUMN regimen_falla_en TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(regimen_falla_en) = 'array');

-- Valores de las cuatro semillas (por nombre, ver src/main/backtest/
-- strategies/*_SEED.ts): cruce de medias, ruptura de rangos y momentum
-- entre activos declaran funcionar en tendencia; la reversión RSI funciona
-- en lateral y falla en tendencia.
UPDATE strategy_versions
  SET regimen_funciona_en = '["tendencia"]', regimen_falla_en = '[]'
  WHERE nombre IN ('Cruce de medias', 'Ruptura de rangos', 'Momentum entre activos');
UPDATE strategy_versions
  SET regimen_funciona_en = '["lateral"]', regimen_falla_en = '["tendencia"]'
  WHERE nombre = 'Reversión RSI/Bollinger';

-- Marca de filtro de régimen en las ejecuciones de backtest: cada run
-- sabe si se corrió filtrando por el régimen vigente (0 = sin filtro).
ALTER TABLE backtest_runs
  ADD COLUMN regimen_filtro INTEGER NOT NULL DEFAULT 0
    CHECK (regimen_filtro IN (0, 1));

-- Comparación emparejada con y sin filtro de una versión: enlaza las dos
-- ejecuciones (mismo periodo, universo y costes) para la ficha; a lo sumo
-- una comparación por versión.
CREATE TABLE regime_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Runs del par; SET NULL conserva la comparación aunque se borre un run.
  run_sin_filtro INTEGER REFERENCES backtest_runs (id) ON DELETE SET NULL,
  run_con_filtro INTEGER REFERENCES backtest_runs (id) ON DELETE SET NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (strategy_id, version),
  FOREIGN KEY (strategy_id, version)
    REFERENCES strategy_versions (strategy_id, version) ON DELETE CASCADE
);

-- Régimen por activo y sesión; el ámbito 'mercado' usa la referencia SPY.
CREATE TABLE regimes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ambito TEXT NOT NULL CHECK (ambito IN ('activo', 'mercado')),
  ticker TEXT NOT NULL,
  -- Sesión del cierre evaluado ('YYYY-MM-DD').
  sesion TEXT NOT NULL,
  eje_direccion TEXT NOT NULL CHECK (eje_direccion IN ('tendencia', 'lateral')),
  eje_volatilidad TEXT NOT NULL
    CHECK (eje_volatilidad IN ('volatilidad-alta', 'volatilidad-baja')),
  -- Medidas del cálculo (NULL si la serie era insuficiente): ADX(14),
  -- pendiente de la SMA50, volatilidad realizada de 20 sesiones y su
  -- mediana de 252.
  adx REAL,
  sma_pendiente REAL,
  vol_realizada REAL,
  vol_mediana REAL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (ambito, ticker, sesion)
);
CREATE INDEX idx_regimes_ticker ON regimes (ticker, sesion);

-- Ficha del modelo (model-card.json persistida): una por (versión, hash).
CREATE TABLE model_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  -- SHA-256 del archivo .onnx servido por el proceso principal.
  hash TEXT NOT NULL,
  horizonte_dias INTEGER NOT NULL CHECK (horizonte_dias >= 1),
  -- 'sintetico' nunca puede apoyar señales; 'real' también exige que el
  -- Brier fuera de muestra mejore el de referencia.
  origen_datos TEXT NOT NULL CHECK (origen_datos IN ('real', 'sintetico')),
  -- Corte temporal 60/20/20: entrenamiento, calibración y prueba intacta.
  entrenamiento_desde TEXT NOT NULL,
  entrenamiento_hasta TEXT NOT NULL,
  calibracion_desde TEXT NOT NULL,
  calibracion_hasta TEXT NOT NULL,
  prueba_desde TEXT NOT NULL,
  prueba_hasta TEXT NOT NULL,
  -- Métricas fuera de muestra sobre la prueba final.
  brier_oos REAL,
  log_loss_oos REAL,
  brier_referencia REAL,
  -- Bins del diagrama de calibración (JSON CalibrationBin[]).
  calibracion TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(calibracion) = 'array'),
  -- Distribución de referencia por variable (JSON FeatureReference[]).
  distribucion_referencia TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(distribucion_referencia) = 'array'),
  -- Aptitud para señales, decidida por el servicio al registrar la ficha.
  apto INTEGER NOT NULL DEFAULT 0 CHECK (apto IN (0, 1)),
  motivo_no_apto TEXT,
  entrenado_en TEXT,
  registrado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (version, hash)
);

-- Predicción guardada por activo y sesión, con la versión del modelo para
-- poder medirla al resolverla a t+N (campos resuelta_*/acierto/brier).
CREATE TABLE predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  -- Sesión del cierre evaluado ('YYYY-MM-DD').
  sesion TEXT NOT NULL,
  horizonte_dias INTEGER NOT NULL CHECK (horizonte_dias >= 1),
  -- Probabilidad calibrada de subida (0-1); la de bajada es su complemento.
  prob_subida REAL NOT NULL CHECK (prob_subida >= 0 AND prob_subida <= 1),
  -- Volatilidad esperada a N sesiones (tanto por uno); NULL si no aplica.
  vol_esperada REAL CHECK (vol_esperada IS NULL OR vol_esperada >= 0),
  modelo_version TEXT NOT NULL,
  modelo_hash TEXT NOT NULL,
  model_card_id INTEGER REFERENCES model_cards (id) ON DELETE SET NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Resolución a t+N: NULL hasta que llega la vela del horizonte.
  resuelta_sesion TEXT,
  acierto INTEGER CHECK (acierto IS NULL OR acierto IN (0, 1)),
  brier_realizado REAL,
  UNIQUE (ticker, sesion, horizonte_dias, modelo_version)
);
CREATE INDEX idx_predictions_ticker ON predictions (ticker, sesion);
CREATE INDEX idx_predictions_resolucion ON predictions (resuelta_sesion)
  WHERE resuelta_sesion IS NULL;

-- Análisis de un titular confirmado por activo: una fila por noticia ×
-- activo con su resumen, sentimiento y método (LLM o local).
CREATE TABLE news_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  noticia_id INTEGER NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  resumen TEXT NOT NULL,
  sentimiento TEXT NOT NULL
    CHECK (sentimiento IN ('positivo', 'negativo', 'neutro', 'mixto')),
  -- Quién lo produjo; el LLM anota el modelo exacto (p. ej.
  -- 'claude-haiku-4-5-20251001'), el local deja NULL.
  analizador TEXT NOT NULL CHECK (analizador IN ('llm', 'local')),
  modelo TEXT,
  analizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (noticia_id, ticker)
);
CREATE INDEX idx_news_analysis_ticker ON news_analysis (ticker, analizado_en);

-- Revisiones de drift persistidas: 'datos' y 'resultados' evalúan el
-- modelo; 'rendimiento' evalúa una estrategia (operaciones y desviación
-- frente al backtest). `persistencia` cuenta las sesiones o revisiones
-- consecutivas en alerta: la degradación exige persistencia, nunca una
-- racha aislada.
CREATE TABLE drift_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ambito TEXT NOT NULL CHECK (ambito IN ('modelo', 'estrategia')),
  -- model_cards.id o strategies.id; nombre desnormalizado para que la
  -- revisión siga siendo legible si el sujeto desaparece.
  sujeto_id INTEGER,
  sujeto_nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('datos', 'resultados', 'rendimiento')),
  -- Sesiones o revisiones consecutivas en alerta hasta esta evaluación.
  persistencia INTEGER NOT NULL DEFAULT 0 CHECK (persistencia >= 0),
  -- Métricas de la revisión (JSON: PSI por variable, Brier móvil,
  -- desviación, racha…).
  detalle TEXT NOT NULL DEFAULT '{}'
    CHECK (json_type(detalle) = 'object'),
  resultado TEXT NOT NULL DEFAULT 'ok' CHECK (resultado IN ('ok', 'alerta')),
  evaluado_en TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_drift_checks_sujeto ON drift_checks (ambito, sujeto_id, evaluado_en);

-- Propuesta de reentrenamiento controlado: como mucho una por trimestre
-- natural y nunca automática — el usuario la aprueba (el trabajo corre
-- fuera, en ml/) o la pospone con fecha y motivo.
CREATE TABLE retrain_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Ficha del modelo a reentrenar; SET NULL si la ficha desaparece.
  model_card_id INTEGER REFERENCES model_cards (id) ON DELETE SET NULL,
  -- Estrategia cuya degradación lo motivó; NULL si lo motiva el modelo.
  estrategia_id INTEGER REFERENCES strategies (id) ON DELETE SET NULL,
  -- Trimestre natural 'YYYY-Qn'; UNIQUE aplica la regla de una por trimestre.
  trimestre TEXT NOT NULL UNIQUE,
  motivo TEXT NOT NULL,
  -- Datos que usaría el pipeline (descripción legible).
  ambito_datos TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'aprobada', 'pospuesta')),
  -- Nota del usuario al resolver y, si pospone, hasta qué fecha.
  nota TEXT,
  pospuesta_hasta TEXT,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resuelta_en TEXT
);
CREATE INDEX idx_retrain_proposals_estado ON retrain_proposals (estado, creado_en);

-- Lista de comprobación del modo real: una fila por requisito, con la
-- evidencia calculada por main (automáticos) o la declaración y la fecha
-- del usuario (manuales).
CREATE TABLE live_checklist (
  requisito TEXT PRIMARY KEY CHECK (requisito IN (
    'validacion-fuera-muestra', 'paper-continuo', 'parada-probada',
    'alertas-activas', 'claves-sin-retirada', 'plan-contingencia',
    'revision-legal')),
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'cumplido', 'revisar')),
  -- Evidencia legible calculada por el proceso principal.
  evidencia TEXT,
  -- Texto declarado (LIVE_DECLARATION_TEXTS) y nota/enlace local.
  declaracion TEXT,
  detalle_declaracion TEXT,
  -- Última evaluación automática o fecha de la declaración (ISO 8601).
  marcado_en TEXT,
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO live_checklist (requisito) VALUES
  ('validacion-fuera-muestra'),
  ('paper-continuo'),
  ('parada-probada'),
  ('alertas-activas'),
  ('claves-sin-retirada'),
  ('plan-contingencia'),
  ('revision-legal');

-- Límites escritos del modo real (fila única): nunca superan los techos
-- fijos de la fase; `confirmados` solo vale para los valores actuales —
-- cambiar cualquier límite exige escribir la frase nueva al activar.
CREATE TABLE live_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  capital_usd REAL NOT NULL CHECK (capital_usd > 0 AND capital_usd <= 1000),
  orden_usd REAL NOT NULL CHECK (orden_usd > 0 AND orden_usd <= 200),
  perdida_diaria_usd REAL NOT NULL
    CHECK (perdida_diaria_usd > 0 AND perdida_diaria_usd <= 20),
  posiciones_max INTEGER NOT NULL CHECK (posiciones_max >= 1 AND posiciones_max <= 2),
  confirmados INTEGER NOT NULL DEFAULT 0 CHECK (confirmados IN (0, 1)),
  guardados_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmados_en TEXT
);

-- Estado del modo real (fila única): 'bloqueado' hasta completar la
-- lista y confirmar los límites; 'listo' con todo vigente; 'activo'
-- operando; 'suspendido' si saltó la parada, se perdió la conexión o
-- venció un requisito (no se envían órdenes nuevas).
CREATE TABLE live_mode (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  estado TEXT NOT NULL DEFAULT 'bloqueado'
    CHECK (estado IN ('bloqueado', 'listo', 'activo', 'suspendido')),
  motivo_suspension TEXT
    CHECK (motivo_suspension IS NULL OR motivo_suspension IN
      ('sin-conexion', 'parada-emergencia', 'requisito-vencido')),
  detalle_suspension TEXT,
  -- Broker y cuenta live enmascarada para la franja global.
  broker TEXT,
  cuenta TEXT,
  -- Última prueba de humo (JSON LiveSmokeTestResult); NULL si no se hizo.
  prueba_humo TEXT,
  activado_en TEXT,
  suspendido_en TEXT,
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO live_mode (id) VALUES (1);

-- migrate:down
DROP TABLE IF EXISTS live_mode;
DROP TABLE IF EXISTS live_limits;
DROP TABLE IF EXISTS live_checklist;
DROP TABLE IF EXISTS retrain_proposals;
DROP TABLE IF EXISTS drift_checks;
DROP TABLE IF EXISTS news_analysis;
DROP TABLE IF EXISTS predictions;
DROP TABLE IF EXISTS model_cards;
DROP TABLE IF EXISTS regimes;
DROP TABLE IF EXISTS regime_comparisons;
-- Quitar la columna del backtest y las de régimen de la ficha (SQLite
-- soporta DROP COLUMN; los datos anteriores a la fase no se tocan).
ALTER TABLE backtest_runs DROP COLUMN regimen_filtro;
ALTER TABLE strategy_versions DROP COLUMN regimen_falla_en;
ALTER TABLE strategy_versions DROP COLUMN regimen_funciona_en;
