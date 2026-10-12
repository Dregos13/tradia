-- migrate:up
-- Límites del corto con dinero real (decisión del usuario: las
-- estrategias propias operan en largo y en corto, y el corto real lleva
-- techos propios). Tres columnas nuevas en live_limits:
--
--   corto_orden_usd       nocional máximo de una entrada en corto
--   corto_exposicion_usd  exposición corta total al precio actual
--   corto_posiciones_max  posiciones cortas abiertas simultáneas
--
-- A 0 el corto queda desactivado (los tres deben ser > 0 para que una
-- entrada en corto pase la puerta del dinero real). Las filas ya
-- guardadas migran con los tres a 0: el largo queda como estaba y su
-- confirmación escrita sigue valiendo para el largo —las columnas nuevas
-- no tocan capital_usd, orden_usd, perdida_diaria_usd, posiciones_max ni
-- confirmados— pero la frase de confirmación ya incluye el corto, así que
-- cualquier cambio de estos límites exige escribirla de nuevo, igual que
-- con los del largo.

ALTER TABLE live_limits
  ADD COLUMN corto_orden_usd REAL NOT NULL DEFAULT 0
    CHECK (corto_orden_usd >= 0 AND corto_orden_usd <= 100);
ALTER TABLE live_limits
  ADD COLUMN corto_exposicion_usd REAL NOT NULL DEFAULT 0
    CHECK (corto_exposicion_usd >= 0 AND corto_exposicion_usd <= 200);
ALTER TABLE live_limits
  ADD COLUMN corto_posiciones_max INTEGER NOT NULL DEFAULT 0
    CHECK (corto_posiciones_max >= 0 AND corto_posiciones_max <= 1);

-- migrate:down
-- DROP COLUMN existe desde SQLite 3.35; el proyecto empaqueta >= 3.45.
ALTER TABLE live_limits DROP COLUMN corto_posiciones_max;
ALTER TABLE live_limits DROP COLUMN corto_exposicion_usd;
ALTER TABLE live_limits DROP COLUMN corto_orden_usd;
