-- migrate:up
-- Fase 7 · continuación: modo por entrada del Diario.
--
-- `journal_entries.modo` ('paper' | 'live') marca qué entradas del
-- Diario pertenecen a dinero real —la prueba de humo y las órdenes del
-- broker real— para que el renderer las rotule «Dinero real» y la
-- conciliación diaria de la rutina no las confunda con operaciones
-- simuladas. NULL en las entradas sin cuenta (señales, vetos, resúmenes
-- de la rutina…) y en todo lo ya guardado: las 'operacion' anteriores
-- eran todas simuladas y siguen leyéndose igual.
--
-- El modo se persiste con la entrada (como `BrokerOrder.mode` con la
-- orden): nunca se deduce del modo vigente de la app. La columna se
-- añade con ALTER TABLE (SQLite >= 3.25); la 013 reservó la recreación
-- de news_analysis para el CHECK de 'suscripcion'.

ALTER TABLE journal_entries
  ADD COLUMN modo TEXT CHECK (modo IN ('paper', 'live'));

-- migrate:down
-- DROP COLUMN existe desde SQLite 3.35; el proyecto empaqueta >= 3.45.
ALTER TABLE journal_entries DROP COLUMN modo;
