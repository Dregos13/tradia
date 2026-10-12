-- migrate:up
-- Fase 7 · broker real con capital mínimo: las órdenes de la cuenta live
-- NO comparten tabla con las paper (`broker_orders`), para que ni la
-- conciliación paper ni las métricas de «paper continuo» de la lista las
-- mezclen con dinero real. `broker_orders_live` es el mismo esquema que
-- `broker_orders` (mismas columnas, CHECKs e idempotencia por
-- client_order_id) con índices propios; el repositorio se parametriza
-- por tabla (`createBrokerRepository(db, {ordersTable})`). La migración
-- no toca ninguna tabla existente y el down solo retira lo que aquí se
-- crea, sin pérdida de datos.
--
-- Las ejecuciones de conciliación y los descuadres sí comparten las
-- tablas de la fase 5 (`reconcile_runs`, `reconcile_discrepancies`): una
-- pasada sobre la cuenta real se registra igual que una sobre paper.

-- Orden enviada al broker live (Alpaca real o el servidor falso de las
-- pruebas). Misma semántica que `broker_orders`: una fila por orden —
-- la entrada de mercado fraccionaria, una limitada o stop sueltas, o el
-- padre de un OCO— y `client_order_id` como clave de idempotencia
-- ('tradia-<señal>-<pata>'); el broker lo devuelve igual, así un
-- reintento tras un timeout nunca duplica la orden.
CREATE TABLE broker_orders_live (
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
CREATE INDEX idx_broker_orders_live_estado ON broker_orders_live (estado, creado_en);
CREATE INDEX idx_broker_orders_live_senal ON broker_orders_live (senal_id)
  WHERE senal_id IS NOT NULL;
CREATE INDEX idx_broker_orders_live_estrategia
  ON broker_orders_live (estrategia_id, ejecutada_en);
CREATE INDEX idx_broker_orders_live_ticker ON broker_orders_live (ticker, creado_en);
CREATE INDEX idx_broker_orders_live_oco ON broker_orders_live (oco_group_id)
  WHERE oco_group_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS broker_orders_live;
