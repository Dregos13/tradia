-- migrate:up
-- Estado interno de la app: ajustes (sin secretos) y claves de API cifradas.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  -- Valor serializado (texto o JSON); nunca contiene secretos.
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE secrets (
  provider TEXT PRIMARY KEY,
  -- safeStorage.encryptString(...) codificado en base64; jamás texto plano.
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- migrate:down
DROP TABLE IF EXISTS secrets;
DROP TABLE IF EXISTS settings;
