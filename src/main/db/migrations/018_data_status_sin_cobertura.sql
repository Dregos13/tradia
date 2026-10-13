-- migrate:up
-- Estado nuevo 'sin-cobertura' en data_status (un activo que el proveedor
-- no cubre: respuesta vacía sin historial previo o 404 'not-found').
-- Antes, ese caso se contaba como fallo del proveedor entero y el ticker
-- quedaba 'no-fiable', lo que pausaba régimen, predicciones y señales de
-- TODA la app. Con el estado propio el fallo queda aislado al activo.
--
-- El CHECK de `estado` solo admitía los cuatro estados antiguos, así que
-- se reconstruye la tabla copiando cada fila. Después se recalculan a
-- 'sin-cobertura' las filas de ticker que el código anterior marcó
-- 'no-fiable' por el motivo «no devolvió datos» (respuesta vacía) o por
-- un 'not-found' («recurso no encontrado» / «no existe»): los fallos
-- seguidos que arrastraban no eran fallos reales y se ponen a 0. Ninguna
-- otra fila cambia: ni proveedores, ni series, ni 'no-fiable' por
-- anomalías o por fallos de red.

CREATE TABLE data_status_nueva (
  clave TEXT PRIMARY KEY,
  estado TEXT NOT NULL
    CHECK (estado IN (
      'fiable', 'actualizando', 'desactualizado', 'no-fiable', 'sin-cobertura')),
  -- Último dato correcto conocido (ISO 8601).
  ultimo_ok TEXT,
  fallos_seguidos INTEGER NOT NULL DEFAULT 0 CHECK (fallos_seguidos >= 0),
  motivo TEXT,
  actualizado_en TEXT NOT NULL
);
INSERT INTO data_status_nueva
  SELECT clave, estado, ultimo_ok, fallos_seguidos, motivo, actualizado_en
  FROM data_status;
DROP TABLE data_status;
ALTER TABLE data_status_nueva RENAME TO data_status;

UPDATE data_status
   SET estado = 'sin-cobertura', fallos_seguidos = 0
 WHERE clave LIKE 'ticker:%'
   AND estado = 'no-fiable'
   AND (motivo LIKE '%no devolvió datos%'
        OR motivo LIKE '%recurso no encontrado%'
        OR motivo LIKE '%no existe%');

-- migrate:down
-- Se reconstruye la tabla con el CHECK antiguo. Las filas 'sin-cobertura'
-- vuelven a 'no-fiable' —su estado antes de la migración— con
-- fallos_seguidos al menos en 1 para que la parada de emergencia de la
-- versión anterior no las lea como anomalía de contenido (fallos en 0).

UPDATE data_status
   SET estado = 'no-fiable', fallos_seguidos = MAX(fallos_seguidos, 1)
 WHERE estado = 'sin-cobertura';
CREATE TABLE data_status_nueva (
  clave TEXT PRIMARY KEY,
  estado TEXT NOT NULL
    CHECK (estado IN ('fiable', 'actualizando', 'desactualizado', 'no-fiable')),
  -- Último dato correcto conocido (ISO 8601).
  ultimo_ok TEXT,
  fallos_seguidos INTEGER NOT NULL DEFAULT 0 CHECK (fallos_seguidos >= 0),
  motivo TEXT,
  actualizado_en TEXT NOT NULL
);
INSERT INTO data_status_nueva
  SELECT clave, estado, ultimo_ok, fallos_seguidos, motivo, actualizado_en
  FROM data_status;
DROP TABLE data_status;
ALTER TABLE data_status_nueva RENAME TO data_status;
