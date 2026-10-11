import { describe, expect, it } from 'vitest';

import {
  dataDriftSince,
  DRIFT_BRIER_DELTA,
  driftPsiKey,
  featurePsiOverThresholdSince,
  isModelEligible,
  resultsDriftSince,
} from './ai';
import type { DriftCheck, DriftCheckKind } from './ai';

const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T22:00:00.000Z`;

const check = (
  id: number,
  kind: DriftCheckKind,
  detail: DriftCheck['detail'],
  evaluatedAt: string,
): DriftCheck => ({
  id,
  subject: 'modelo',
  subjectId: 1,
  subjectName: 'Modelo v0.1.0',
  kind,
  streak: 0,
  detail,
  drifted: false,
  evaluatedAt,
});

/** 25 revisiones 'datos': 5 sin drift y 20 con ret_5 sobre el umbral. */
const history25 = (): DriftCheck[] =>
  Array.from({ length: 25 }, (_, index) =>
    check(index + 1, 'datos', { [driftPsiKey('ret_5')]: index < 5 ? 0.1 : 0.31 }, at(index + 1)),
  );

describe('aptitud del modelo', () => {
  it('solo es apto con datos reales y Brier fuera de muestra mejor que la referencia', () => {
    const metrics = { brierOos: 0.18, logLossOos: 0.5, brierBaseline: 0.21 };
    expect(isModelEligible({ dataOrigin: 'real', metrics })).toBe(true);
    expect(isModelEligible({ dataOrigin: 'sintetico', metrics })).toBe(false);
    expect(isModelEligible({ dataOrigin: 'real', metrics: { ...metrics, brierOos: 0.22 } })).toBe(
      false,
    );
  });
});

describe('fecha de inicio del drift por variable', () => {
  it('con 5 revisiones sin drift y 20 con drift en ret_5 empieza en la sexta', () => {
    expect(featurePsiOverThresholdSince(history25(), 'ret_5')).toBe(at(6));
  });

  it('una revisión sin drift al final devuelve la fecha a null', () => {
    const checks = [...history25(), check(26, 'datos', { [driftPsiKey('ret_5')]: 0.1 }, at(26))];
    expect(featurePsiOverThresholdSince(checks, 'ret_5')).toBeNull();
  });

  it('una racha antigua interrumpida no cuenta: solo vale la actual', () => {
    const checks = history25();
    checks[0]!.detail[driftPsiKey('ret_5')] = 0.4; // drift suelto al principio
    checks[2]!.detail[driftPsiKey('ret_5')] = 0.4;
    expect(featurePsiOverThresholdSince(checks, 'ret_5')).toBe(at(6));
  });

  it('una revisión sin el PSI de la variable no sostiene la racha', () => {
    const checks = history25();
    delete checks[20]!.detail[driftPsiKey('ret_5')];
    expect(featurePsiOverThresholdSince(checks, 'ret_5')).toBe(at(22));
  });

  it('ignora revisiones de otro tipo y respeta el orden cronológico', () => {
    const mixed = [
      ...history25().reverse(),
      check(26, 'resultados', { delta: 0.1 }, at(26)),
      check(27, 'rendimiento', { deviationPct: -40 }, at(27)),
    ];
    expect(featurePsiOverThresholdSince(mixed, 'ret_5')).toBe(at(6));
    expect(featurePsiOverThresholdSince(mixed, 'vol_20')).toBeNull();
  });
});

describe('fecha de inicio del drift de datos', () => {
  it('exige al menos DRIFT_PSI_MIN_FEATURES variables sobre el umbral', () => {
    // Solo ret_5 deriva: una variable no basta para el resumen conjunto.
    expect(dataDriftSince(history25())).toBeNull();
    const two = history25().map((c, index) =>
      index < 15 ? c : { ...c, detail: { ...c.detail, [driftPsiKey('vol_20')]: 0.29 } },
    );
    expect(dataDriftSince(two)).toBe(at(16));
  });
});

describe('fecha de inicio del drift de resultados', () => {
  it('empieza en la primera revisión de la racha con delta sobre el umbral', () => {
    const checks = Array.from({ length: 8 }, (_, index) =>
      check(
        index + 1,
        'resultados',
        { delta: index < 4 ? DRIFT_BRIER_DELTA - 0.005 : DRIFT_BRIER_DELTA + 0.02 },
        at(index + 1),
      ),
    );
    expect(resultsDriftSince(checks)).toBe(at(5));
    // En el umbral justo no es alerta: la regla es delta > DRIFT_BRIER_DELTA.
    const onThreshold = checks.map((c) => ({ ...c, detail: { delta: DRIFT_BRIER_DELTA } }));
    expect(resultsDriftSince(onThreshold)).toBeNull();
  });

  it('una revisión bajo el umbral reinicia la racha', () => {
    const checks = [
      check(1, 'resultados', { delta: DRIFT_BRIER_DELTA + 0.03 }, at(1)),
      check(2, 'resultados', { delta: 0 }, at(2)),
      check(3, 'resultados', { delta: DRIFT_BRIER_DELTA + 0.03 }, at(3)),
    ];
    expect(resultsDriftSince(checks)).toBe(at(3));
  });

  it('un delta no numérico no sostiene la racha', () => {
    const checks = [
      check(1, 'resultados', { delta: DRIFT_BRIER_DELTA + 0.03 }, at(1)),
      check(2, 'resultados', { delta: 'sin ventana' }, at(2)),
    ];
    expect(resultsDriftSince(checks)).toBeNull();
  });
});
