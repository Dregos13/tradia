-- migrate:up
-- Tipo de activo en la lista de seguimiento: 'equity' (acción o ETF de
-- EE. UU., calendario de NYSE) o 'fx' (par de divisas como 'EURUSD',
-- calendario 24/5). El tipo decide el calendario y la regla de frescura
-- del activo.
--
-- Solo añade una columna con valor por defecto: todas las filas que ya
-- existen quedan 'equity' (hasta ahora no había otro tipo) y ninguna otra
-- tabla cambia; las velas, los lotes y data_status siguen tal cual.
ALTER TABLE watchlist
  ADD COLUMN asset_class TEXT NOT NULL DEFAULT 'equity'
    CHECK (asset_class IN ('equity', 'fx'));

-- migrate:down
-- Al volver atrás se pierde solo el tipo: los pares de divisas que haya en
-- la lista se conservan como un ticker más (el código anterior los trata
-- como acciones) y sus velas no se tocan.
ALTER TABLE watchlist DROP COLUMN asset_class;
