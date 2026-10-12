-- migrate:up
-- Reglas de corto de las estrategias propias (decisión del usuario: las
-- fichas propias operan en largo y en corto). Dos columnas opcionales en
-- strategy_versions —regla de entrada en corto y de salida del corto— que
-- van en pareja: NULL en ambas significa que la versión no opera en corto,
-- así que todas las filas ya guardadas siguen siendo válidas tal cual.
--
-- Van en la ficha versionada como las reglas del largo: cada edición crea
-- la versión N+1 con su pareja de corto. Una columna en blanco no se
-- admite (el repositorio guarda NULL, nunca texto vacío).

ALTER TABLE strategy_versions
  ADD COLUMN regla_entrada_corto TEXT
    CHECK (regla_entrada_corto IS NULL OR length(trim(regla_entrada_corto)) > 0);
ALTER TABLE strategy_versions
  ADD COLUMN regla_salida_corto TEXT
    CHECK (
      (regla_salida_corto IS NULL OR length(trim(regla_salida_corto)) > 0)
      AND ((regla_entrada_corto IS NULL) = (regla_salida_corto IS NULL))
    );

-- migrate:down
-- DROP COLUMN existe desde SQLite 3.35; el proyecto empaqueta >= 3.45.
ALTER TABLE strategy_versions DROP COLUMN regla_salida_corto;
ALTER TABLE strategy_versions DROP COLUMN regla_entrada_corto;
