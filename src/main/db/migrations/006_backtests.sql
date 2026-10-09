-- migrate:up
-- Backtests y pruebas de estrés (fase 2): ejecuciones persistidas ligadas
-- a la versión de la estrategia, bloqueo de la prueba final y resultados
-- de las crisis 2008/2020/2022 que muestra la ficha.

-- Qué implementación ejecutable corre cada estrategia. La ficha
-- (migración 005) es agnóstica del código; este enlace lo escribe la
-- semilla de las clásicas (o un futuro registro de implementaciones).
-- Una estrategia sin fila aquí tiene biblioteca pero no puede lanzar
-- backtests.
CREATE TABLE strategy_implementations (
  strategy_id INTEGER PRIMARY KEY REFERENCES strategies (id) ON DELETE CASCADE,
  -- Clave estable del registro de estrategias ejecutables ('sma-cross'…).
  impl_key TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Una fila por ejecución guardada: configuración resuelta, costes,
-- división de datos, métricas, curva, operaciones y los bloques de
-- robustez (walk-forward, sensibilidad, Monte Carlo) como JSON.
CREATE TABLE backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- 'completo': pipeline completo sobre entrenamiento + validación.
  -- 'prueba-final': ejecución única sobre el tramo de prueba bloqueado.
  kind TEXT NOT NULL DEFAULT 'completo' CHECK (kind IN ('completo', 'prueba-final')),
  -- Configuración efectiva del run (JSON BacktestRunConfig).
  config TEXT NOT NULL,
  -- Costes aplicados, en el formato de la ficha (JSON StrategyCosts,
  -- comisión en %; el motor recibe la conversión a fracción).
  costes TEXT NOT NULL,
  -- División entrenamiento/validación/prueba usada (JSON DataSplitDto);
  -- NULL en los runs 'prueba-final' (su rango ya es el tramo bloqueado).
  division TEXT,
  -- Métricas del informe (JSON BacktestMetricsDto).
  metricas TEXT NOT NULL,
  -- Curva de capital diaria (JSON EquityPointDto[]).
  curva TEXT NOT NULL DEFAULT '[]',
  -- Operaciones cerradas (JSON TradeDto[]).
  operaciones TEXT NOT NULL DEFAULT '[]',
  -- Bloques de robustez (JSON); NULL cuando el run no los incluyó.
  walk_forward TEXT,
  sensibilidad TEXT,
  monte_carlo TEXT,
  -- Benchmark comprar-y-mantener del periodo (JSON BenchmarkDto); NULL si falta.
  benchmark TEXT,
  -- Avisos del informe (JSON BacktestNotice[]: sobreajuste y metodológicos).
  avisos TEXT NOT NULL DEFAULT '[]',
  -- Fuente de datos: 'simulated' o 'real', más el id del proveedor.
  fuente TEXT NOT NULL CHECK (fuente IN ('simulated', 'real')),
  proveedor TEXT NOT NULL,
  duracion_ms INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (strategy_id, version)
    REFERENCES strategy_versions (strategy_id, version) ON DELETE CASCADE
);
CREATE INDEX idx_backtest_runs_strategy ON backtest_runs (strategy_id, version, id);

-- Bloqueo de la prueba final: como mucho un run 'prueba-final' por versión.
-- El servicio lo comprueba antes de ejecutar; este índice único parcial es
-- la red de seguridad en la escritura.
CREATE UNIQUE INDEX uq_backtest_prueba_final
  ON backtest_runs (strategy_id, version)
  WHERE kind = 'prueba-final';

-- Resultados de las pruebas de estrés por crisis; una fila por versión y
-- crisis (repetir la prueba la sobrescribe: UPSERT del servicio).
CREATE TABLE stress_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Identificador estable de la ventana ('2008', '2020', '2022').
  crisis TEXT NOT NULL,
  crisis_nombre TEXT NOT NULL,
  -- Periodo oficial de la crisis ejecutado ('YYYY-MM-DD', ambos inclusive).
  desde TEXT NOT NULL,
  hasta TEXT NOT NULL,
  -- Sesiones simuladas en la ventana; 0 si la fuente no tenía datos.
  sesiones INTEGER NOT NULL DEFAULT 0,
  rentabilidad REAL,
  drawdown REAL,
  operaciones INTEGER NOT NULL DEFAULT 0,
  -- Ticker y rentabilidad del benchmark comprar-y-mantener.
  benchmark TEXT NOT NULL,
  benchmark_rentabilidad REAL,
  fuente TEXT NOT NULL CHECK (fuente IN ('simulated', 'real')),
  proveedor TEXT NOT NULL,
  -- Minicurva de capital de la ventana para la ficha (JSON EquityPointDto[]).
  curva TEXT NOT NULL DEFAULT '[]',
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (strategy_id, version, crisis),
  FOREIGN KEY (strategy_id, version)
    REFERENCES strategy_versions (strategy_id, version) ON DELETE CASCADE
);

-- migrate:down
DROP TABLE IF EXISTS stress_results;
DROP TABLE IF EXISTS backtest_runs;
DROP TABLE IF EXISTS strategy_implementations;
