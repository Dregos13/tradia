-- migrate:up
-- Fase 4 · posiciones simuladas desde señales aprobadas: la cartera paper
-- (`risk_portfolio_positions`, migración 007) gana la trazabilidad de la
-- señal que abrió cada posición y el resultado del cierre simulado, que
-- hasta ahora solo existían en el diario. Las posiciones sembradas por el
-- gancho E2E `risk:seed-portfolio` quedan con `senal_id` y `vela_apertura`
-- a NULL («abiertas a mano»); las de señales las rellena el seguimiento
-- de `src/main/signals/paper.ts`. ALTER COLUMN añade columnas nuevas: no
-- se pierde ningún dato existente.

-- Señal que originó la posición (`signals.id`). SET NULL como en
-- journal_entries: el diario y la cartera sobreviven aunque la señal se
-- borre. NULL en posiciones sembradas a mano.
ALTER TABLE risk_portfolio_positions
  ADD COLUMN senal_id INTEGER REFERENCES signals (id) ON DELETE SET NULL;
-- Fecha de la vela cuyo cierre emitió la señal ('YYYY-MM-DD'): el
-- seguimiento solo evalúa velas estrictamente posteriores a la apertura.
ALTER TABLE risk_portfolio_positions
  ADD COLUMN vela_apertura TEXT;
-- Precio de salida del cierre simulado; NULL mientras siga abierta.
ALTER TABLE risk_portfolio_positions
  ADD COLUMN salida REAL;
-- Por qué cerró: 'stop' (protección) u 'objetivo' (beneficio).
ALTER TABLE risk_portfolio_positions
  ADD COLUMN motivo_salida TEXT CHECK (motivo_salida IN ('stop', 'objetivo'));
CREATE INDEX idx_risk_positions_senal
  ON risk_portfolio_positions (senal_id) WHERE senal_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS idx_risk_positions_senal;
ALTER TABLE risk_portfolio_positions DROP COLUMN motivo_salida;
ALTER TABLE risk_portfolio_positions DROP COLUMN salida;
ALTER TABLE risk_portfolio_positions DROP COLUMN vela_apertura;
ALTER TABLE risk_portfolio_positions DROP COLUMN senal_id;
