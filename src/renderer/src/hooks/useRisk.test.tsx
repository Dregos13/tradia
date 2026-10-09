// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { useRisk } from './useRisk';
import type { KillSwitchState, RiskOverview, RiskVeto } from '../../../shared/risk';
import { RISK_DEFAULTS } from '../../../shared/risk';

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('carga estado, límites, vetos y cautela y conserva la instantánea ante errores', async () => {
  const { result } = renderHook(useRisk);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.limits).toEqual(RISK_DEFAULTS);
  expect(result.current.killSwitch?.active).toBe(false);
  expect(result.current.caution?.active).toBe(false);
  expect(result.current.vetoes).toEqual([]);
  vi.spyOn(window.tradia.risk, 'getLimits').mockRejectedValue(new Error('IPC'));
  await act(async () => {
    await result.current.reload();
  });
  expect(result.current.limits).toEqual(RISK_DEFAULTS);
  expect(result.current.error).toContain('No se pudo actualizar');
});

it('una carga antigua no sobrescribe una parada recibida por risk:changed', async () => {
  let finish!: (value: KillSwitchState) => void;
  vi.spyOn(window.tradia.risk, 'getKillSwitch').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(useRisk);
  await act(async () => {
    await window.tradia.risk.activateKillSwitch();
  });
  expect(result.current.killSwitch?.active).toBe(true);
  await act(async () => {
    finish({ active: false, cause: null, actor: null, activatedAt: null, detail: null });
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.killSwitch?.active).toBe(true);
});

it('suscribe ambas notificaciones, incorpora nuevos vetos y libera los listeners', async () => {
  let changed!: (value: RiskOverview) => void;
  let vetoed!: (value: RiskVeto) => void;
  const offChanged = vi.fn();
  const offVetoed = vi.fn();
  vi.spyOn(window.tradia.risk, 'onChanged').mockImplementation((listener) => {
    changed = listener;
    return offChanged;
  });
  vi.spyOn(window.tradia.risk, 'onVetoed').mockImplementation((listener) => {
    vetoed = listener;
    return offVetoed;
  });
  const { result, unmount } = renderHook(useRisk);
  await waitFor(() => expect(result.current.loading).toBe(false));
  const overview: RiskOverview = {
    limits: { ...RISK_DEFAULTS, riskPerTradePct: 1 },
    killSwitch: { active: false, cause: null, actor: null, activatedAt: null, detail: null },
    caution: {
      active: true,
      effect: 'bloquear',
      sizeFactor: 0,
      cause: 'alto-impacto',
      eventTitle: 'Evento de prueba',
      until: '2026-10-09T15:00:00Z',
    },
  };
  const veto: RiskVeto = {
    id: 7,
    ticker: 'AAPL',
    decision: 'vetada',
    code: 'STOP_MISSING',
    message: 'La señal no tiene stop de protección',
    details: {},
    size: 0,
    createdAt: '2026-10-09T14:00:00Z',
    signal: {
      ticker: 'AAPL',
      direction: 'largo',
      entry: 100,
      stop: null,
      target: 120,
      confidence: 0.8,
      origin: 'probador',
    },
  };
  act(() => {
    changed(overview);
    vetoed(veto);
    vetoed(veto);
  });
  expect(result.current.caution).toEqual(overview.caution);
  expect(result.current.limits?.riskPerTradePct).toBe(1);
  expect(result.current.vetoes).toEqual([veto]);
  unmount();
  expect(offChanged).toHaveBeenCalledOnce();
  expect(offVetoed).toHaveBeenCalledOnce();
});
