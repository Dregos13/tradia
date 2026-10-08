import { describe, expect, it } from 'vitest';

import type { Reliability, SourceKind } from '../../shared/ipc';
import {
  classifyNews,
  findWatchedAssets,
  impactOf,
  isConfirmed,
  isCritical,
  type NewsPriorityInput,
  type PrioritySourceRef,
} from './priority';

const fuente = (reliability: Reliability, kind?: SourceKind): PrioritySourceRef => ({
  reliability,
  kind,
});

const AGENCIA = fuente('agencia', 'api');
const OFICIAL = fuente('oficial', 'oficial');
const PRENSA = fuente('prensa', 'rss');
const REDES = fuente('redes', 'redes');

const item = (title: string, extra: Partial<NewsPriorityInput> = {}): NewsPriorityInput => ({
  title,
  ...extra,
});

const WATCHLIST = ['AAPL', 'NVDA', 'XOM', 'BTC', 'JPM'];

describe('classifyNews — prioridad máxima', () => {
  it.each<[string, string]>([
    ['Fed', 'La Fed sube los tipos de interés 25 puntos básicos'],
    ['FOMC', 'FOMC minutes signal patience on rate cuts'],
    ['BCE', 'El BCE mantiene los tipos y Lagarde avisa de más subidas'],
    ['BoE', 'Bank of England cuts rates for first time this year'],
    ['BoJ', 'BoJ ends negative interest rate policy'],
    ['presidente banco central', 'Powell warns of persistent price pressures'],
    ['NFP español', 'Las nóminas no agrícolas de EE. UU. superan las previsiones'],
    ['NFP inglés', 'US nonfarm payrolls beat expectations in September'],
    ['IPC', 'El IPC de EE. UU. se enfría hasta el 3,1%'],
    ['CPI', 'US CPI inflation slows more than expected'],
    ['PCE', 'Core PCE price index rises less than forecast'],
    ['IPP', 'El IPP repunta por la energía'],
    ['PPI', 'Producer prices (PPI) accelerate in August'],
    ['PIB', 'El PIB de la eurozona se estanca en el trimestre'],
    ['GDP', 'US GDP grows 2.8% in third quarter'],
    ['PMI', 'El PMI manufacturero de EE. UU. entra en expansión'],
    ['ventas minoristas', 'Las ventas minoristas caen por sorpresa en España'],
    ['retail sales', 'US retail sales jump on holiday demand'],
    ['guerra', 'La guerra en Ucrania se recrudece y sacude a los mercados'],
    ['sanciones', 'La UE aprueba nuevas sanciones a Rusia'],
    ['aranceles', 'EE. UU. anuncia nuevos aranceles a China'],
    ['tariffs', 'Trump imposes sweeping tariffs on imports'],
    ['elecciones', 'Las elecciones en Francia agitan la renta fija'],
    ['quiebra', 'Un banco regional entra en quiebra por la fuga de depósitos'],
    ['bankruptcy', 'Regional lender files for bankruptcy protection'],
    ['crisis liquidez', 'El banco sufre una crisis de liquidez y pide rescate'],
    ['corrida bancaria', 'Bank run fears spread to mid-size lenders'],
    ['shock geopolítico', 'Geopolitical shock sends oil and gold soaring'],
  ])('%s: «%s» es maxima', (_caso, titular) => {
    expect(classifyNews(item(titular), [AGENCIA], [])).toBe('maxima');
  });

  it('manda sobre activo: macro + activo seguido sigue siendo maxima', () => {
    const noticia = item('La Fed sube tipos y arrastra a AAPL un 3%', { assets: ['AAPL'] });
    expect(classifyNews(noticia, [AGENCIA], WATCHLIST)).toBe('maxima');
  });
});

describe('classifyNews — prioridad media', () => {
  it.each<[string, string]>([
    ['resultados gran empresa', 'Los resultados de Samsung hunden al sector de semiconductores'],
    ['earnings gran empresa', 'Toyota earnings drag the whole auto sector'],
    ['EIA', 'La EIA informa de los inventarios semanales de crudo'],
    ['crude inventories', 'US crude inventories fall more than expected'],
    ['OPEP', 'La OPEP+ se reúne para decidir los recortes de producción'],
    ['OPEC', 'OPEC meeting extends output cuts into next year'],
    ['subasta', 'El Tesoro coloca una subasta de deuda a diez años'],
    ['bond auction', 'Weak demand at the latest bond auction'],
    ['rating', "Moody's rebaja la calificación crediticia de Francia"],
    ['downgrade', 'Fitch downgrades the US credit rating'],
    ['vivienda', 'Las ventas de viviendas usadas caen en EE. UU.'],
    ['confianza', 'La confianza del consumidor cae a mínimos del año'],
    ['industrial', 'La producción industrial alemana decepciona'],
  ])('%s: «%s» es media', (_caso, titular) => {
    expect(classifyNews(item(titular), [AGENCIA], WATCHLIST)).toBe('media');
  });

  it('activo seguido + categoría solo de media sigue siendo media', () => {
    const noticia = item('La EIA recorta inventarios y XOM sube', { assets: ['XOM'] });
    expect(classifyNews(noticia, [AGENCIA], WATCHLIST)).toBe('media');
  });
});

describe('classifyNews — prioridad por activo', () => {
  it.each<[string, string, string[]]>([
    ['resultados', 'AAPL beats earnings expectations and raises guidance', ['AAPL']],
    ['guías', 'NVDA eleva su guía de ingresos para el trimestre', ['NVDA']],
    ['M&A', 'JPM in talks for the acquisition of a regional bank', ['JPM']],
    ['directivos', 'El CEO de NVDA anuncia su dimisión al año próximo', ['NVDA']],
    ['analistas', 'Morgan Stanley eleva el price target de AAPL un 12%', ['AAPL']],
    ['ampliación', 'La compañía anuncia una ampliación de capital de 2.000M', ['AAPL']],
    ['dividendos', 'AAPL increases its quarterly dividend by 4%', ['AAPL']],
    ['litigio', 'JPM faces a new lawsuit over mortgage practices', ['JPM']],
    ['regulación', 'La UE abre una investigación antitrust a AAPL', ['AAPL']],
    ['recall', 'La marca anuncia un recall de 120.000 unidades', ['AAPL']],
    ['ciberataque', 'La empresa sufre un ciberataque que expone datos', ['NVDA']],
    ['índices', 'La acción entra en el S&P 500 tras el rebalanceo', ['AAPL']],
    ['cripto regulación', 'La SEC aprueba el ETF de BTC al contado', ['BTC']],
    ['cripto hackeo', 'Un hackeo al exchange drena fondos de BTC', ['BTC']],
    ['comunicado SEC', 'Form 4: insider selling reported at the company', ['JPM']],
  ])('%s: «%s» es activo', (_caso, titular, activos) => {
    expect(classifyNews(item(titular, { assets: activos }), [AGENCIA], WATCHLIST)).toBe('activo');
  });

  it('el ticker en el titular también liga el activo', () => {
    const noticia = item('AAPL anuncia la recompra de acciones más grande de su historia');
    expect(classifyNews(noticia, [AGENCIA], WATCHLIST)).toBe('activo');
  });

  it('un comunicado oficial sobre un activo seguido es activo sin palabra clave', () => {
    const noticia = item('Corriente: presentación periódica ante la SEC', { assets: ['AAPL'] });
    expect(classifyNews(noticia, [OFICIAL], WATCHLIST)).toBe('activo');
  });
});

describe('classifyNews — prioridad baja y negativos', () => {
  it.each<[string, string]>([
    ['editorial', 'Cinco lecciones que los grandes inversores aprendieron en 2026'],
    ['contexto', 'Cómo funciona un plan de pensiones de empleo'],
    ['mención sin categoría', 'AAPL abre una nueva tienda en el centro de Madrid'],
  ])('%s: «%s» es baja', (_caso, titular) => {
    expect(classifyNews(item(titular), [PRENSA], WATCHLIST)).toBe('baja');
  });

  it('categoría por activo sin activo seguido es baja', () => {
    const noticia = item('La empresa anuncia un recall de 120.000 unidades', {
      assets: ['XOM-MX'],
    });
    expect(classifyNews(noticia, [PRENSA], WATCHLIST)).toBe('baja');
  });

  it('lista de seguimiento vacía nunca da activo', () => {
    const noticia = item('AAPL beats earnings expectations', { assets: ['AAPL'] });
    expect(classifyNews(noticia, [AGENCIA], [])).toBe('media');
  });

  it('una fuente oficial sin activo seguido no sube la prioridad', () => {
    const noticia = item('Comunicado genérico sobre estadísticas regionales');
    expect(classifyNews(noticia, [OFICIAL], WATCHLIST)).toBe('baja');
  });
});

describe('isConfirmed', () => {
  it.each<[string, PrioritySourceRef[], boolean]>([
    ['oficial', [OFICIAL], true],
    ['agencia', [AGENCIA], true],
    ['prensa sola', [PRENSA], false],
    ['solo redes', [REDES], false],
    ['redes + prensa', [REDES, PRENSA], false],
    ['redes + agencia', [REDES, AGENCIA], true],
    ['redes + oficial', [REDES, OFICIAL], true],
    ['sin fuentes', [], false],
  ])('%s → %s', (_caso, fuentes, esperado) => {
    expect(isConfirmed(fuentes)).toBe(esperado);
  });
});

describe('isCritical', () => {
  const maximaNoticia = item('La Fed sube los tipos de interés 50 puntos básicos');
  const activoNoticia = item('AAPL se desploma tras un ciberataque masivo', { assets: ['AAPL'] });

  it('maxima con fuente no de redes es crítica', () => {
    expect(isCritical(maximaNoticia, [AGENCIA], [])).toBe(true);
    expect(isCritical(maximaNoticia, [OFICIAL], [])).toBe(true);
    expect(isCritical(maximaNoticia, [PRENSA], [])).toBe(true);
    expect(isCritical(maximaNoticia, [REDES, AGENCIA], [])).toBe(true);
  });

  it('maxima solo de redes nunca es crítica', () => {
    expect(isCritical(maximaNoticia, [REDES], [])).toBe(false);
  });

  it('activo seguido con fuente no de redes es crítico', () => {
    expect(isCritical(activoNoticia, [AGENCIA], WATCHLIST)).toBe(true);
    expect(isCritical(activoNoticia, [PRENSA], WATCHLIST)).toBe(true);
  });

  it('activo seguido solo de redes nunca es crítico', () => {
    expect(isCritical(activoNoticia, [REDES], WATCHLIST)).toBe(false);
  });

  it('media o baja nunca son críticas aunque la fuente sea buena', () => {
    const media = item('La OPEP acuerda recortes de producción');
    const baja = item('Editorial sobre la historia de la banca');
    expect(isCritical(media, [OFICIAL], WATCHLIST)).toBe(false);
    expect(isCritical(baja, [AGENCIA], WATCHLIST)).toBe(false);
  });
});

describe('findWatchedAssets', () => {
  it('devuelve los tickers seguidos que trae el titular', () => {
    expect(findWatchedAssets(item('X', { assets: ['aapl', 'TSLA'] }), WATCHLIST)).toEqual(['AAPL']);
  });

  it('reconoce el ticker en mayúsculas y el cashtag en el texto', () => {
    expect(
      findWatchedAssets(item('NVDA lidera la subida y $aapl acompaña'), WATCHLIST).sort(),
    ).toEqual(['AAPL', 'NVDA']);
  });

  it('no liga tickers en minúsculas ni dentro de otras palabras', () => {
    expect(findWatchedAssets(item('aapl es una palabra, XOMEX cotiza'), WATCHLIST)).toEqual([]);
  });

  it('sin lista de seguimiento no hay activos', () => {
    expect(findWatchedAssets(item('AAPL sube', { assets: ['AAPL'] }), [])).toEqual([]);
  });
});

describe('impactOf', () => {
  it.each<[Parameters<typeof impactOf>[0], string]>([
    ['fomc', 'alto'],
    ['banco-central', 'alto'],
    ['nfp', 'alto'],
    ['ipc', 'alto'],
    ['pce', 'alto'],
    ['pib', 'alto'],
    ['vencimiento', 'alto'],
    ['pmi', 'medio'],
    ['eia', 'medio'],
    ['opep', 'medio'],
    ['resultados', 'medio'],
    ['otro', 'bajo'],
  ])('%s → %s', (tipo, esperado) => {
    expect(impactOf(tipo)).toBe(esperado);
  });
});
