import { describe, expect, it } from 'vitest';

import { labVerdict } from './lab';

const base = { asset: 'EUR/USD' };

describe('labVerdict', () => {
  it('sin operaciones no sirve', () => {
    expect(labVerdict({ ...base, total: 0, benchmark: 0.01, trades: 0 }).level).toBe(
      'sin-operaciones',
    );
  });
  it('si pierde dinero lo dice claro y desaconseja lanzarla', () => {
    const v = labVerdict({ ...base, total: -0.12, benchmark: -0.059, trades: 250 });
    expect(v).toMatchObject({ level: 'pierde', tone: 'bad', title: 'Esta idea pierde dinero' });
    expect(v.text).toContain('12,0 %');
    expect(v.text).toContain('−5,9 %');
  });
  it('si gana menos que comprar y esperar no compensa', () => {
    expect(labVerdict({ ...base, total: 0.03, benchmark: 0.08, trades: 80 }).level).toBe('peor');
  });
  it('con pocas operaciones puede ser suerte', () => {
    expect(labVerdict({ ...base, total: 0.1, benchmark: 0.02, trades: 12 })).toMatchObject({
      level: 'dudosa',
      tone: 'warn',
    });
  });
  it('si gana más que no hacer nada con muestra suficiente, merece la prueba en vivo', () => {
    expect(labVerdict({ ...base, total: 0.1, benchmark: 0.02, trades: 120 })).toMatchObject({
      level: 'prometedora',
      tone: 'good',
    });
  });
});
