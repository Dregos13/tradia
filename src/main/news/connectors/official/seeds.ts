/**
 * Fuentes oficiales predefinidas — Fase 1b.
 *
 * `OFFICIAL_SOURCE_SEEDS` cataloga las fuentes de organismos (Fed, BCE,
 * BLS, BEA, SEC EDGAR y CNMV) que `seedOfficialSources` inserta en
 * `news_sources` con `tipo`/`fiabilidad` 'oficial'. El usuario puede
 * desactivarlas y ajustar `url`/`params` (p. ej. los CIKs de EDGAR),
 * pero no reclasificarlas: `SourcesService.update` rechaza cambiar la
 * fiabilidad de una fuente 'oficial'.
 *
 * La siembra es una sola vez por conector: la marca
 * `news.seed.oficial.<conector>` en `settings` actúa de lápida — si el
 * usuario borra una fuente oficial, no resucita en el siguiente arranque.
 */
import type Database from 'better-sqlite3';

import { INITIAL_UNIVERSE_TICKERS } from '../../../../shared/ipc';
import { cikForTicker } from './cik-map';
import { BEA_CONNECTOR_ID } from './bea';
import { BLS_CONNECTOR_ID } from './bls';
import { CNMV_CONNECTOR_ID } from './cnmv';
import { ECB_CONNECTOR_ID } from './ecb';
import { FED_CONNECTOR_ID } from './fed';
import { SEC_EDGAR_CONNECTOR_ID } from './sec-edgar';

export interface OfficialSourceSeed {
  /** Id del conector registrado (`news_sources.conector`). */
  connector: string;
  name: string;
  /** null: usa los endpoints propios del conector; una URL los sustituye. */
  url: string | null;
  params: Record<string, unknown>;
  intervalSeconds: number;
}

/** CIKs del universo inicial para la siembra de SEC EDGAR (sin duplicados). */
export const INITIAL_UNIVERSE_CIKS: readonly string[] = [
  ...new Set(
    INITIAL_UNIVERSE_TICKERS.map((ticker) => cikForTicker(ticker)).filter(
      (cik): cik is string => cik !== null,
    ),
  ),
];

const OFFICIAL_INTERVAL_SECONDS = 600;

export const OFFICIAL_SOURCE_SEEDS: readonly OfficialSourceSeed[] = [
  {
    connector: FED_CONNECTOR_ID,
    name: 'Reserva Federal — comunicados y FOMC',
    url: null,
    params: {},
    intervalSeconds: OFFICIAL_INTERVAL_SECONDS,
  },
  {
    connector: ECB_CONNECTOR_ID,
    name: 'BCE — notas de prensa',
    url: null,
    params: {},
    intervalSeconds: OFFICIAL_INTERVAL_SECONDS,
  },
  {
    connector: BLS_CONNECTOR_ID,
    name: 'BLS — nóminas no agrícolas e IPC',
    url: null,
    params: {},
    intervalSeconds: 900,
  },
  {
    connector: BEA_CONNECTOR_ID,
    name: 'BEA — comunicados (PIB, PCE…)',
    url: null,
    params: {},
    intervalSeconds: 900,
  },
  {
    connector: SEC_EDGAR_CONNECTOR_ID,
    name: 'SEC EDGAR — 8-K y Form 4 de los activos seguidos',
    url: null,
    params: { ciks: [...INITIAL_UNIVERSE_CIKS] },
    intervalSeconds: OFFICIAL_INTERVAL_SECONDS,
  },
  {
    connector: CNMV_CONNECTOR_ID,
    name: 'CNMV — información privilegiada y relevante',
    url: null,
    params: {},
    intervalSeconds: OFFICIAL_INTERVAL_SECONDS,
  },
];

const seedMarkerKey = (connectorId: string): string => `news.seed.oficial.${connectorId}`;

/**
 * Inserta en `news_sources` las fuentes oficiales que aún no se sembraron
 * (marca en `settings` por conector; ver cabecera). Idempotente y en una
 * sola transacción; devuelve los ids de las filas nuevas.
 */
export function seedOfficialSources(db: Database.Database | null): number[] {
  if (db === null) return [];
  const seededMarker = db.prepare('SELECT 1 FROM settings WHERE key = ?');
  const markSeeded = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, '1', ?)",
  );
  const existsByConnector = db.prepare('SELECT id FROM news_sources WHERE conector = ?');
  const insert = db.prepare(`
    INSERT INTO news_sources (nombre, tipo, conector, url, params, fiabilidad, intervalo_segundos)
    VALUES (?, 'oficial', ?, ?, ?, 'oficial', ?)
  `);
  const now = new Date().toISOString();

  const insertedIds: number[] = [];
  db.transaction(() => {
    for (const seed of OFFICIAL_SOURCE_SEEDS) {
      if (seededMarker.get(seedMarkerKey(seed.connector)) !== undefined) continue;
      if (existsByConnector.get(seed.connector) === undefined) {
        const result = insert.run(
          seed.name,
          seed.connector,
          seed.url,
          JSON.stringify(seed.params),
          seed.intervalSeconds,
        );
        insertedIds.push(Number(result.lastInsertRowid));
      }
      markSeeded.run(seedMarkerKey(seed.connector), now);
    }
  })();
  return insertedIds;
}
