/**
 * Pruebas del núcleo de habilitación por régimen.
 *
 * El motivo de régimen desactualizado se lee en la ficha de la estrategia
 * junto a la franja global de frescura: usa el mismo formato local
 * («18 sept 2026», vía `sessionDateLabel` de src/shared/dates) y nunca
 * una fecha ISO 'AAAA-MM-DD'.
 */
import { describe, expect, it } from 'vitest';

import { resolveStrategyRegime, staleRegimeResolution } from './enablement';

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

describe('staleRegimeResolution', () => {
  it('dice con qué cierre se calculó y qué sesión se esperaba, en formato local', () => {
    const { regimeState, reason } = staleRegimeResolution('2026-09-18', '2026-10-09');

    expect(regimeState).toBe('desactualizada');
    expect(reason).toBe(
      'Régimen calculado con el cierre del 18 sept 2026; se esperaba la sesión del ' +
        '9 oct 2026: no habilita ni desactiva hasta ponerse al día.',
    );
    expect(reason).not.toContain('desactualizado desde');
  });

  it('nunca escribe una fecha AAAA-MM-DD en el motivo', () => {
    for (const [session, expected] of [
      ['2026-09-18', '2026-10-09'],
      ['2025-12-31', '2026-01-02'],
      ['2026-02-10', '2026-02-11'],
    ] as const) {
      expect(staleRegimeResolution(session, expected).reason).not.toMatch(ISO_DATE);
    }
  });
});

describe('resolveStrategyRegime', () => {
  it('con régimen desconocido y failsIn declarado cierra en desactivada', () => {
    const { regimeState, reason } = resolveStrategyRegime(
      { worksIn: [], failsIn: ['volatilidad-alta'] },
      'activa',
      null,
    );

    expect(regimeState).toBe('desactivada');
    expect(reason).toContain('Régimen desconocido');
  });

  it('una estrategia degradada manda sobre cualquier etiqueta', () => {
    const { regimeState } = resolveStrategyRegime(
      { worksIn: ['tendencia'], failsIn: [] },
      'degradada',
      { direction: 'lateral', volatility: 'volatilidad-baja' },
    );

    expect(regimeState).toBe('degradada');
  });
});
