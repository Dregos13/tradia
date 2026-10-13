-- migrate:up
-- Requisitos propios del corto con dinero real (corrección de bugs):
-- antes de operar en corto con dinero real hace falta una revisión
-- legal y fiscal específica de las ventas en corto (CNMV/MiFID II e
-- IRPF) y varias semanas de cortos en paper con resultados cuadrados.
--
-- `live_checklist`: el CHECK de `requisito` solo admitía los siete del
-- largo; se reconstruye la tabla con los nueve (los siete más
-- 'revision-legal-corto' y 'paper-cortos') copiando cada fila, y se
-- insertan las dos nuevas en 'pendiente'. Ninguna declaración ni
-- evidencia existente se toca.
--
-- `reconcile_runs` gana `cuenta` ('paper' | 'live'): las ejecuciones y
-- sus descuadres compartían tabla sin distinguir la cuenta conciliada,
-- y el requisito 'paper-cortos' solo debe medir los descuadres abiertos
-- de la conciliación de paper. Las filas anteriores quedan como
-- 'paper' (conservador: cualquier descuadre histórico sin resolver
-- cuenta para el bloqueo); las nuevas pasadas escriben la cuenta del
-- repositorio que las lanza.

CREATE TABLE live_checklist_nueva (
  requisito TEXT PRIMARY KEY CHECK (requisito IN (
    'validacion-fuera-muestra', 'paper-continuo', 'parada-probada',
    'alertas-activas', 'claves-sin-retirada', 'plan-contingencia',
    'revision-legal', 'revision-legal-corto', 'paper-cortos')),
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
INSERT INTO live_checklist_nueva
  SELECT requisito, estado, evidencia, declaracion, detalle_declaracion,
         marcado_en, actualizado_en
  FROM live_checklist;
DROP TABLE live_checklist;
ALTER TABLE live_checklist_nueva RENAME TO live_checklist;
INSERT INTO live_checklist (requisito) VALUES
  ('revision-legal-corto'),
  ('paper-cortos');

ALTER TABLE reconcile_runs
  ADD COLUMN cuenta TEXT NOT NULL DEFAULT 'paper'
    CHECK (cuenta IN ('paper', 'live'));

-- migrate:down
ALTER TABLE reconcile_runs DROP COLUMN cuenta;
-- Las filas de los requisitos del corto se retiran (su CHECK no las
-- admite al volver atrás); las de los siete del largo se conservan.
DELETE FROM live_checklist
  WHERE requisito IN ('revision-legal-corto', 'paper-cortos');
CREATE TABLE live_checklist_nueva (
  requisito TEXT PRIMARY KEY CHECK (requisito IN (
    'validacion-fuera-muestra', 'paper-continuo', 'parada-probada',
    'alertas-activas', 'claves-sin-retirada', 'plan-contingencia',
    'revision-legal')),
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'cumplido', 'revisar')),
  evidencia TEXT,
  declaracion TEXT,
  detalle_declaracion TEXT,
  marcado_en TEXT,
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO live_checklist_nueva
  SELECT requisito, estado, evidencia, declaracion, detalle_declaracion,
         marcado_en, actualizado_en
  FROM live_checklist;
DROP TABLE live_checklist;
ALTER TABLE live_checklist_nueva RENAME TO live_checklist;
