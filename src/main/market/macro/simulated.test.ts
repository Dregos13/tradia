import { describe, expect, it } from 'vitest';

import { isMarketDataError } from '../providers/types';
import { createSimulatedMacroProvider, SIMULATED_MACRO_PROVIDER_ID } from './simulated';
import { MACRO_SERIES_CATALOG } from './types';

const NOW = Date.parse('2026-10-08T12:00:00.000Z'); // jueves

const make = (extra: Partial<Parameters<typeof createSimulatedMacroProvider>[0]> = {}) =>
  createSimulatedMacroProvider({ seed: 'test', now: () => NOW, genesis: '2026-01-05', ...extra });

describe('proveedor macro simulado', () => {
  it('sirve el catálogo de la fase', () => {
    const provider = make();
    expect(provider.id).toBe(SIMULATED_MACRO_PROVIDER_ID);
    expect(provider.listSeries().map((s) => s.id)).toEqual(MACRO_SERIES_CATALOG.map((s) => s.id));
  });

  it('es determinista: mismo rango, mismo resultado, en cualquier orden', async () => {
    const provider = make();
    const a = await provider.getObservations('DGS10', '2026-03-02', '2026-03-31');
    const b = await provider.getObservations('DGS10', '2026-03-02', '2026-03-31');
    expect(a).toEqual(b);
    // Un rango más amplio no cambia los valores de las fechas compartidas.
    const c = await provider.getObservations('DGS10', '2026-02-02', '2026-03-31');
    const shared = c.filter((o) => o.date >= '2026-03-02');
    expect(shared).toEqual(a);
    // Otra semilla cambia la serie.
    const other = make({ seed: 'otra' });
    const d = await other.getObservations('DGS10', '2026-03-02', '2026-03-31');
    expect(d).not.toEqual(a);
  });

  it('las series diarias emiten solo en laborables y las mensuales el día 1', async () => {
    const provider = make();
    const daily = await provider.getObservations('DFF');
    expect(daily.length).toBeGreaterThan(0);
    for (const obs of daily) {
      const day = new Date(`${obs.date}T00:00:00.000Z`).getUTCDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
    }
    const monthly = await provider.getObservations('CPIAUCSL');
    for (const obs of monthly) {
      expect(obs.date.endsWith('-01')).toBe(true);
    }
  });

  it('no emite observaciones futuras según el reloj inyectado', async () => {
    let nowMs = NOW;
    const provider = createSimulatedMacroProvider({
      seed: 'test',
      now: () => nowMs,
      genesis: '2026-10-05',
    });
    const first = await provider.getObservations('VIXCLS');
    expect(first.at(-1)!.date).toBe('2026-10-08'); // último laborable conocido

    // Avanza el reloj un día: aparece la observación nueva (viernes 09).
    nowMs = Date.parse('2026-10-09T12:00:00.000Z');
    const second = await provider.getObservations('VIXCLS');
    expect(second.at(-1)!.date).toBe('2026-10-09');
    expect(second.length).toBe(first.length + 1);
  });

  it('respeta los rangos desde/hasta y valida fechas', async () => {
    const provider = make();
    const range = await provider.getObservations('DGS2', '2026-10-05', '2026-10-07');
    expect(range.map((o) => o.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);

    await expect(provider.getObservations('DGS2', 'no-fecha')).rejects.toSatisfy((e: unknown) =>
      isMarketDataError(e, 'bad-data'),
    );
    await expect(provider.getObservations('DGS2', '2026-10-08', '2026-10-01')).rejects.toSatisfy(
      (e: unknown) => isMarketDataError(e, 'bad-data'),
    );
  });

  it('lanza not-found en series desconocidas o marcadas', async () => {
    const provider = make();
    await expect(provider.getObservations('ZZZ')).rejects.toSatisfy((e: unknown) =>
      isMarketDataError(e, 'not-found'),
    );
    provider.markUnknown('VIXCLS');
    await expect(provider.getObservations('VIXCLS')).rejects.toSatisfy((e: unknown) =>
      isMarketDataError(e, 'not-found'),
    );
  });

  it('admite inyectar huecos y valores por fecha', async () => {
    const provider = make();
    provider.injectGap('DFF', '2026-10-06');
    provider.injectValue('DFF', '2026-10-07', 9.99);
    const obs = await provider.getObservations('DFF', '2026-10-05', '2026-10-08');
    expect(obs.map((o) => o.date)).toEqual(['2026-10-05', '2026-10-07', '2026-10-08']);
    expect(obs.find((o) => o.date === '2026-10-07')!.value).toBe(9.99);
  });

  it('los fallos programados consumen la cola y el fallo permanente persiste', async () => {
    const provider = make();
    provider.queueFailures(2, 'rate-limit');
    await expect(provider.getObservations('DFF')).rejects.toSatisfy((e: unknown) =>
      isMarketDataError(e, 'rate-limit'),
    );
    await expect(provider.getObservations('DFF')).rejects.toSatisfy((e: unknown) =>
      isMarketDataError(e, 'rate-limit'),
    );
    await expect(provider.getObservations('DFF')).resolves.toBeInstanceOf(Array);

    provider.setFailing('network');
    await expect(provider.getObservations('DFF')).rejects.toSatisfy((e: unknown) =>
      isMarketDataError(e, 'network'),
    );
    provider.setFailing(null);
    await expect(provider.getObservations('DFF')).resolves.toBeInstanceOf(Array);
  });
});
