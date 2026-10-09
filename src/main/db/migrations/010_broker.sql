-- migrate:up
-- Fase 5 · paper trading con broker: órdenes ejecutadas en la cuenta paper
-- con su trazabilidad completa (hora y precio pedidos, hora y precio
-- ejecutados, slippage en puntos básicos, intentos y motivo de rechazo),
-- ejecuciones de la conciliación app ↔ broker con sus discrepancias, y
-- alertas del informe de desviación real frente a backtest. Todo es nuevo:
-- la migración no toca ninguna tabla existente y el down solo retira lo
-- que aquí se crea, sin pérdida de datos de fases anteriores.

-- Orden enviada al broker paper (Alpaca o el simulado de las pruebas).
-- Una fila por orden enviada: la entrada de mercado, una limitada o stop
-- sueltas, o el padre de un OCO (sus dos precios van en precio_limite y
-- precio_stop y el grupo en oco_group_id, que en Alpaca es el id del
-- padre). client_order_id es la clave de idempotencia: determinista
-- ('tradia-<señal>-<pata>') y el broker lo conoce igual, así un reintento
-- tras un timeout nunca duplica la orden.
CREATE TABLE broker_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Idempotencia: 'tradia-<señal>-<pata>'; UNIQUE impide el duplicado.
  client_order_id TEXT NOT NULL UNIQUE,
  -- Id que asignó el broker al aceptarla; NULL hasta entonces.
  broker_order_id TEXT,
  -- Señal que la originó (`signals.id`); SET NULL como en journal_entries:
  -- el historial de órdenes sobrevive aunque la señal se borre.
  senal_id INTEGER REFERENCES signals (id) ON DELETE SET NULL,
  -- Estrategia principal de la señal (sin FK: es histórica, como en
  -- journal_entries.estrategia_id); NULL si no consta.
  estrategia_id INTEGER,
  -- Pata del plan de la señal: 'entrada' (mercado) o 'salida' (OCO de
  -- stop + objetivo); NULL en órdenes sueltas.
  pata TEXT CHECK (pata IN ('entrada', 'salida')),
  ticker TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('market', 'limit', 'stop', 'oco')),
  lado TEXT NOT NULL CHECK (lado IN ('buy', 'sell')),
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  cantidad_ejecutada REAL NOT NULL DEFAULT 0
    CHECK (cantidad_ejecutada >= 0 AND cantidad_ejecutada <= cantidad),
  -- Precios del envío: límite (limit y pata objetivo del OCO) y stop.
  precio_limite REAL,
  precio_stop REAL,
  -- Precio de referencia del pedido para el slippage: el limit/stop en
  -- esos tipos, el precio previsto (señal o última cotización) en una de
  -- mercado; NULL en un OCO hasta saber qué pata ejecuta.
  precio_pedido REAL,
  -- Precio medio de ejecución; NULL hasta que se complete.
  precio_ejecutado REAL,
  -- Horas pedida y ejecutada (ISO 8601).
  pedida_en TEXT NOT NULL,
  ejecutada_en TEXT,
  -- Slippage en puntos básicos con signo según el lado (positivo =
  -- desfavorable); NULL sin ejecución o sin referencia.
  slippage_pb REAL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN
    ('pendiente', 'enviada', 'parcial', 'ejecutada', 'cancelada', 'rechazada', 'huerfana')),
  -- Envíos intentados (1 en el primero; crece en cada reintento).
  intentos INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  -- Motivo legible del rechazo; NULL en el resto de estados.
  motivo_rechazo TEXT,
  -- Grupo OCO que enlaza la orden con su padre o sus patas en el broker;
  -- NULL fuera de un OCO.
  oco_group_id TEXT,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_broker_orders_estado ON broker_orders (estado, creado_en);
CREATE INDEX idx_broker_orders_senal ON broker_orders (senal_id) WHERE senal_id IS NOT NULL;
CREATE INDEX idx_broker_orders_estrategia ON broker_orders (estrategia_id, ejecutada_en);
CREATE INDEX idx_broker_orders_ticker ON broker_orders (ticker, creado_en);
CREATE INDEX idx_broker_orders_oco ON broker_orders (oco_group_id) WHERE oco_group_id IS NOT NULL;

-- Ejecuciones de la conciliación app ↔ broker: cada pasada programada,
-- manual («Conciliar ahora») o de la rutina postmercado, con los conteos
-- leídos de cada lado y el número de discrepancias nuevas.
CREATE TABLE reconcile_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origen TEXT NOT NULL CHECK (origen IN ('programada', 'manual', 'rutina')),
  iniciada_en TEXT NOT NULL,
  -- NULL mientras la ejecución sigue en curso.
  terminada_en TEXT,
  resultado TEXT CHECK (resultado IN ('ok', 'descuadre', 'error')),
  posiciones_app INTEGER NOT NULL DEFAULT 0,
  posiciones_broker INTEGER NOT NULL DEFAULT 0,
  ordenes_app INTEGER NOT NULL DEFAULT 0,
  ordenes_broker INTEGER NOT NULL DEFAULT 0,
  -- Discrepancias nuevas detectadas en la ejecución.
  discrepancias INTEGER NOT NULL DEFAULT 0,
  -- Motivo legible del fallo cuando resultado es 'error'; NULL si no.
  error TEXT
);
CREATE INDEX idx_reconcile_runs_iniciada ON reconcile_runs (iniciada_en);

-- Descuadre concreto detectado en una ejecución de conciliación. Queda
-- 'abierta' hasta que una ejecución limpia la marca 'resuelta' (el aviso
-- de la app se cierra solo cuando el broker vuelve a cuadrar).
CREATE TABLE reconcile_discrepancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES reconcile_runs (id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'posicion-faltante-broker', 'posicion-faltante-app', 'posicion-cantidad',
    'posicion-precio', 'orden-faltante-broker', 'orden-faltante-app', 'orden-estado')),
  -- Activo afectado; NULL en descuadres sin activo.
  ticker TEXT,
  -- Texto legible en español: es lo que muestra el banner de descuadre.
  detalle TEXT NOT NULL,
  -- Valores según la app y según el broker, ya formateados.
  valor_app TEXT,
  valor_broker TEXT,
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'resuelta')),
  creada_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resuelta_en TEXT
);
CREATE INDEX idx_reconcile_discrepancies_run ON reconcile_discrepancies (run_id);
CREATE INDEX idx_reconcile_discrepancies_estado ON reconcile_discrepancies (estado, creada_en);

-- Alerta «fuera de margen» del informe real vs backtest: una por
-- estrategia y periodo cerrado que sale del margen configurado (UNIQUE
-- para que recalcular el informe nunca duplique el aviso).
CREATE TABLE deviation_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estrategia_id INTEGER NOT NULL,
  estrategia_nombre TEXT NOT NULL,
  periodo TEXT NOT NULL CHECK (periodo IN ('semanal', 'mensual')),
  -- Periodo cerrado ('YYYY-MM-DD', America/New_York; fin inclusive).
  inicio TEXT NOT NULL,
  fin TEXT NOT NULL,
  esperado_pct REAL NOT NULL,
  real_pct REAL NOT NULL,
  desviacion_pp REAL NOT NULL,
  slippage_pb REAL,
  -- Márgenes vigentes cuando saltó la alerta.
  margen_pp REAL NOT NULL,
  margen_slippage_pb REAL NOT NULL,
  -- Entrada del diario que recoge la alerta; sobrevive si se borra.
  journal_id INTEGER REFERENCES journal_entries (id) ON DELETE SET NULL,
  creada_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (estrategia_id, periodo, inicio)
);
CREATE INDEX idx_deviation_alerts_periodo ON deviation_alerts (periodo, inicio);

-- migrate:down
DROP TABLE IF EXISTS deviation_alerts;
DROP TABLE IF EXISTS reconcile_discrepancies;
DROP TABLE IF EXISTS reconcile_runs;
DROP TABLE IF EXISTS broker_orders;
