-- migrate:up
-- Temporalidad de la versión de una estrategia: '1d' (velas diarias, todo
-- lo anterior) o '1h' (velas de 1 hora, con reglas por sesión). Forma
-- parte de la versión: cambiarla crea una versión nueva.
ALTER TABLE strategy_versions
  ADD COLUMN temporalidad TEXT NOT NULL DEFAULT '1d'
    CHECK (temporalidad IN ('1d', '1h'));

-- migrate:down
ALTER TABLE strategy_versions DROP COLUMN temporalidad;
