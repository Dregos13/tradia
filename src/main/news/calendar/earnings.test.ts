import { describe, expect, it } from 'vitest';

import { NewsConnectorError, type ConnectorFetch } from '../connectors';
import { createFinnhubEarnings, createSimulatedEarnings, FINNHUB_TIMEOUT_MS } from './earnings';

const fetchReturning = (body: string, status = 200): ConnectorFetch =>
  (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(body),
    })) as ConnectorFetch;

const FINNHUB_BODY = JSON.stringify({
  earningsCalendar: [
    { date: '2026-10-22', symbol: 'AAPL', hour: 'amc', epsEstimate: 1.6 },
    { date: '2026-10-21', symbol: 'MSFT', hour: 'bmo', epsEstimate: null },
    { date: '2026-10-20', symbol: 'IBM', hour: 'dmh', epsEstimate: 2.4 },
    { date: '2026-10-23', symbol: 'TSLA', hour: 'amc', epsEstimate: 0.4 },
    { date: 'mal-fecha', symbol: 'AAPL', hour: 'amc' },
    { date: '2026-10-24', hour: 'amc' },
  ],
});

describe('createFinnhubEarnings', () => {
  const provider = (fetch: ConnectorFetch, apiKey: string | null = 'clave') =>
    createFinnhubEarnings({ fetch, getApiKey: () => Promise.resolve(apiKey) });

  it('devuelve solo los tickers seguidos, con sesión y BPA normalizados', async () => {
    const entries = await provider(fetchReturning(FINNHUB_BODY)).fetch(
      ['AAPL', 'ibm'],
      '2026-10-01',
      '2026-10-31',
    );
    expect(entries).toEqual([
      { symbol: 'AAPL', date: '2026-10-22', session: 'amc', epsEstimate: 1.6 },
      { symbol: 'IBM', date: '2026-10-20', session: 'other', epsEstimate: 2.4 },
    ]);
  });

  it('pide la fecha del rango en la URL y no llama sin tickers', async () => {
    const seen: string[] = [];
    const fetch: ConnectorFetch = async (url) => {
      seen.push(url);
      return fetchReturning(FINNHUB_BODY)(url);
    };
    const api = provider(fetch);
    await api.fetch([], '2026-10-01', '2026-10-31');
    expect(seen).toHaveLength(0);
    await api.fetch(['AAPL'], '2026-10-01', '2026-11-30');
    expect(seen[0]).toContain('from=2026-10-01');
    expect(seen[0]).toContain('to=2026-11-30');
    expect(seen[0]).toContain('token=clave');
  });

  it('sin clave guardada → error auth; 401/403 → auth; 429 → rate-limit', async () => {
    await expect(
      provider(fetchReturning(FINNHUB_BODY), null).fetch(['A'], '2026-01-01', '2026-12-31'),
    ).rejects.toMatchObject({ kind: 'auth' });
    await expect(
      provider(fetchReturning('{}', 403)).fetch(['A'], '2026-01-01', '2026-12-31'),
    ).rejects.toMatchObject({ kind: 'auth', status: 403 });
    await expect(
      provider(fetchReturning('{}', 429)).fetch(['A'], '2026-01-01', '2026-12-31'),
    ).rejects.toMatchObject({ kind: 'rate-limit', status: 429 });
  });

  it('respuesta no-ok → network; cuerpo no-JSON → bad-data', async () => {
    await expect(
      provider(fetchReturning('oops', 500)).fetch(['A'], '2026-01-01', '2026-12-31'),
    ).rejects.toMatchObject({ kind: 'network', status: 500 });
    await expect(
      provider(fetchReturning('<html>')).fetch(['A'], '2026-01-01', '2026-12-31'),
    ).rejects.toBeInstanceOf(NewsConnectorError);
  });

  it('el timeout declarado es razonable', () => {
    expect(FINNHUB_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe('createSimulatedEarnings (solo TRADIA_E2E)', () => {
  const provider = createSimulatedEarnings();

  it('una presentación por ticker y trimestre, determinista', async () => {
    const first = await provider.fetch(['AAPL'], '2026-01-01', '2026-12-31');
    const second = await provider.fetch(['AAPL'], '2026-01-01', '2026-12-31');
    expect(first).toEqual(second);
    expect(first).toHaveLength(4); // enero, abril, julio, octubre
    for (const entry of first) {
      expect(entry.symbol).toBe('AAPL');
      expect(['bmo', 'amc']).toContain(entry.session);
      expect([1, 4, 7, 10]).toContain(Number(entry.date.slice(5, 7)));
      const dow = new Date(`${entry.date}T00:00:00.000Z`).getUTCDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
      expect(entry.epsEstimate).not.toBeNull();
    }
  });

  it('respeta el rango y solo cubre los tickers pedidos', async () => {
    const entries = await provider.fetch(['MSFT'], '2026-10-01', '2026-10-31');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.symbol).toBe('MSFT');
    expect(entries[0]!.date >= '2026-10-01' && entries[0]!.date <= '2026-10-31').toBe(true);
    const none = await provider.fetch([], '2026-01-01', '2026-12-31');
    expect(none).toHaveLength(0);
  });
});
