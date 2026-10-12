import type { Migration } from '../migrator';
import { MigrationError } from '../migrator';

import raw001 from './001_init.sql?raw';
import raw002 from './002_app_state.sql?raw';
import raw003 from './003_market_data.sql?raw';
import raw004 from './004_news.sql?raw';
import raw005 from './005_strategies.sql?raw';
import raw006 from './006_backtests.sql?raw';
import raw007 from './007_risk.sql?raw';
import raw008 from './008_signals_journal.sql?raw';
import raw009 from './009_paper_positions.sql?raw';
import raw010 from './010_broker.sql?raw';
import raw011 from './011_ai_live.sql?raw';
import raw012 from './012_live_orders.sql?raw';
import raw013 from './013_news_suscripcion.sql?raw';
import raw014 from './014_journal_modo.sql?raw';
import raw015 from './015_reglas_corto.sql?raw';
import raw016 from './016_limites_corto.sql?raw';

/**
 * Registro de migraciones en orden de versión. Cada archivo `.sql` usa el
 * formato dbmate: un bloque `-- migrate:up` y otro `-- migrate:down`.
 * Los `?raw` hacen que Vite/electron-vite incluyan el SQL en el bundle del
 * proceso principal, sin archivos sueltos en la app empaquetada.
 */

const UP_MARKER = '-- migrate:up';
const DOWN_MARKER = '-- migrate:down';

function parseSqlMigration(version: number, name: string, raw: string): Migration {
  const upIndex = raw.indexOf(UP_MARKER);
  const downIndex = raw.indexOf(DOWN_MARKER);
  if (upIndex === -1 || downIndex === -1 || downIndex < upIndex) {
    throw new MigrationError(
      `la migración ${name} necesita los marcadores '${UP_MARKER}' y '${DOWN_MARKER}'`,
    );
  }
  const up = raw.slice(upIndex + UP_MARKER.length, downIndex).trim();
  const down = raw.slice(downIndex + DOWN_MARKER.length).trim();
  if (!up || !down) {
    throw new MigrationError(`la migración ${name} tiene un bloque up o down vacío`);
  }
  return { version, name, up, down };
}

export const MIGRATIONS: Migration[] = [
  parseSqlMigration(1, 'init', raw001),
  parseSqlMigration(2, 'app-state', raw002),
  parseSqlMigration(3, 'market-data', raw003),
  parseSqlMigration(4, 'news', raw004),
  parseSqlMigration(5, 'strategies', raw005),
  parseSqlMigration(6, 'backtests', raw006),
  parseSqlMigration(7, 'risk', raw007),
  parseSqlMigration(8, 'signals-journal', raw008),
  parseSqlMigration(9, 'paper-positions', raw009),
  parseSqlMigration(10, 'broker', raw010),
  parseSqlMigration(11, 'ai-live', raw011),
  parseSqlMigration(12, 'live-orders', raw012),
  parseSqlMigration(13, 'news-suscripcion', raw013),
  parseSqlMigration(14, 'journal-modo', raw014),
  parseSqlMigration(15, 'reglas-corto', raw015),
  parseSqlMigration(16, 'limites-corto', raw016),
];
