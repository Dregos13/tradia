/**
 * Conector oficial de la CNMV — Fase 1b.
 *
 * Canales RSS de cnmv.es (ver su «Canal RSS»: `/Portal/gpage?id=RSS`):
 * información privilegiada, otra información relevante y hechos
 * relevantes de IIC — los registros oficiales que deben comunicar los
 * emisores españoles.
 *
 * Ojo: el XML de la CNMV capitaliza etiquetas (`<Channel>`, `<Title>`);
 * el parser RSS compartido compara nombres sin distinguir mayúsculas.
 */
import {
  createOfficialFeedConnector,
  OFFICIAL_FEED_RATE_LIMITS,
  type OfficialConnectorDeps,
} from './feed';
import type { NewsConnector } from '../types';

export const CNMV_CONNECTOR_ID = 'cnmv';

export const CNMV_FEEDS = [
  'https://www.cnmv.es/portal/informacion-privilegiada/RSS.asmx/GetNoticiasCNMV',
  'https://www.cnmv.es/portal/Otra-Informacion-Relevante/RSS.asmx/GetNoticiasCNMV',
  'https://www.cnmv.es/portal/hr/hechosrelevantes.asmx/GetNoticiasCNMV',
] as const;

export function createCnmvConnector(deps: OfficialConnectorDeps = {}): NewsConnector {
  return createOfficialFeedConnector(
    { id: CNMV_CONNECTOR_ID, feeds: CNMV_FEEDS, rateLimits: OFFICIAL_FEED_RATE_LIMITS },
    deps,
  );
}
