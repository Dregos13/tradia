-- migrate:up
-- Estrategias (fase 2): ficha versionada con registro de cambios.
-- El estado vive en `strategies` porque cambiarlo solo anota el registro;
-- todo lo demás (nombre, hipótesis, reglas, parámetros, mercados, periodos,
-- régimen y costes) es versionable: cada edición crea la versión siguiente
-- y las anteriores quedan intactas.

CREATE TABLE strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Ciclo de vida: 'investigacion' (alta), 'paper', 'activa', 'degradada',
  -- 'retirada'. Sin transiciones automáticas en esta fase.
  estado TEXT NOT NULL DEFAULT 'investigacion'
    CHECK (estado IN ('investigacion', 'paper', 'activa', 'degradada', 'retirada')),
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_strategies_estado ON strategies (estado);

-- Cada versión es una foto completa de la ficha y nunca se edita en el
-- sitio: cualquier cambio crea la fila de la versión siguiente con la nota
-- obligatoria que lo explica.
CREATE TABLE strategy_versions (
  strategy_id INTEGER NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  nombre TEXT NOT NULL,
  -- Hipótesis económica: por qué debería funcionar.
  hipotesis TEXT NOT NULL,
  -- Reglas exactas en texto legible (la ejecución usa `parametros`).
  regla_entrada TEXT NOT NULL,
  regla_salida TEXT NOT NULL,
  regla_stop TEXT NOT NULL,
  regla_objetivo TEXT NOT NULL,
  -- Parámetros ejecutables (JSON {nombre: número}) y sus rangos para el
  -- mapa de sensibilidad (JSON {nombre: {min, max, step}}).
  parametros TEXT NOT NULL DEFAULT '{}',
  rangos_parametros TEXT NOT NULL DEFAULT '{}',
  -- Mercados/activos en los que se probó (JSON lista de texto).
  mercados TEXT NOT NULL DEFAULT '[]',
  -- Periodos de datos usados ('YYYY-MM-DD', ambos inclusive); NULL hasta
  -- definirlos. Van juntos o no van.
  entrenamiento_desde TEXT,
  entrenamiento_hasta TEXT,
  fuera_muestra_desde TEXT,
  fuera_muestra_hasta TEXT,
  -- Métricas resumen del backtest representativo (JSON); la escribe el
  -- servicio de backtest y es NULL hasta que haya una ejecución guardada.
  metricas_resumen TEXT,
  -- Régimen de mercado en el que funciona ('tendencial', 'lateral'...).
  regimen TEXT NOT NULL,
  -- Costes asumidos (JSON {commissionPct, commissionMin, slippageBps,
  -- spreadBps}); los valores por defecto vienen del plan de la fase.
  costes TEXT NOT NULL,
  -- Nota obligatoria del cambio que creó esta versión.
  nota TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (strategy_id, version),
  CHECK ((entrenamiento_desde IS NULL) = (entrenamiento_hasta IS NULL)),
  CHECK (entrenamiento_desde IS NULL OR entrenamiento_desde <= entrenamiento_hasta),
  CHECK ((fuera_muestra_desde IS NULL) = (fuera_muestra_hasta IS NULL)),
  CHECK (fuera_muestra_desde IS NULL OR fuera_muestra_desde <= fuera_muestra_hasta)
);

-- Registro de cambios: una entrada por cada versión creada
-- (tipo 'version', con su número) y una por cada cambio de estado
-- (tipo 'estado', con ambos extremos y sin versión nueva).
CREATE TABLE strategy_changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('version', 'estado')),
  -- Versión creada; NULL en las entradas de cambio de estado.
  version INTEGER CHECK (version IS NULL OR version >= 1),
  estado_anterior TEXT
    CHECK (estado_anterior IS NULL OR estado_anterior IN
      ('investigacion', 'paper', 'activa', 'degradada', 'retirada')),
  estado_nuevo TEXT
    CHECK (estado_nuevo IS NULL OR estado_nuevo IN
      ('investigacion', 'paper', 'activa', 'degradada', 'retirada')),
  nota TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Las entradas de versión apuntan a una versión; las de estado, no.
  CHECK ((tipo = 'version') = (version IS NOT NULL)),
  -- En un cambio de estado hay que registrar ambos extremos.
  CHECK (tipo != 'estado' OR (estado_anterior IS NOT NULL AND estado_nuevo IS NOT NULL))
);
CREATE INDEX idx_strategy_changelog_strategy ON strategy_changelog (strategy_id, id);

-- migrate:down
DROP TABLE IF EXISTS strategy_changelog;
DROP TABLE IF EXISTS strategy_versions;
DROP TABLE IF EXISTS strategies;
