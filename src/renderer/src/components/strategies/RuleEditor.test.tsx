// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseStrategyRules } from '../../../../shared/strategyRules';
import type { Strategy } from '../../../../shared/strategy';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { StrategyForm } from './StrategyForm';
import { StrategyDetail } from './StrategyDetail';
import { BacktestLauncher } from '../backtest/BacktestLauncher';
import { StressResults } from './StressResults';
import { RegimeBacktestComparison } from './RegimeBacktestComparison';

let strategy: Strategy;
beforeEach(async () => {
  window.tradia = createSimulatedAdapter().api;
  window.location.hash = '';
  strategy = await window.tradia.strategies.create({
    name: 'Mi cruce',
    hypothesis: 'Persistencia de tendencias',
    rules: {
      entry: 'cruza_arriba(sma(rapida), sma(lenta))',
      exit: 'cruza_abajo(sma(rapida), sma(lenta))',
      stop: '2%',
      target: 'ninguno',
    },
    parameters: { rapida: 20, lenta: 50 },
    markets: ['SPY'],
    regime: 'Tendencial',
    trainingPeriod: { desde: '2015-01-01', hasta: '2020-12-31' },
    outOfSamplePeriod: { desde: '2021-01-01', hasta: '2024-12-31' },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('valida al escribir, describe el error y selecciona exactamente el rango sin desplazar el foco', async () => {
  const save = vi.fn();
  render(<StrategyForm strategy={strategy} save={save} />);
  const entry = screen.getByLabelText('Entrada') as HTMLTextAreaElement;
  entry.focus();
  fireEvent.change(entry, { target: { value: 'cierre > desconocido' } });
  const parsed = parseStrategyRules({ ...strategy.rules, entry: entry.value }, strategy.parameters);
  if (parsed.ok) throw new Error('La regla de prueba debe ser inválida');
  const error = parsed.errors[0]!;
  await waitFor(() => expect(entry).toHaveAttribute('aria-invalid', 'true'));
  await waitFor(() => expect(entry).toHaveFocus());
  expect(document.getElementById('strategy-rule-entry-result')).toHaveAttribute(
    'aria-live',
    'polite',
  );
  expect(entry).toHaveAccessibleDescription(
    new RegExp(`caracteres ${error.start + 1}–${error.end}`),
  );
  const position = screen.getByRole('button', { name: /desconocido.*caracteres/ });
  position.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(entry).toHaveFocus());
  expect(entry.selectionStart).toBe(error.start);
  expect(entry.selectionEnd).toBe(error.end);
  fireEvent.submit(entry.closest('form')!);
  expect(screen.getByRole('alert')).toHaveTextContent('Hay 1 error. Corrige Entrada');
  expect(save).not.toHaveBeenCalled();
});

it('inserta ejemplos por teclado, devuelve foco y cursor, y revalida al cambiar un parámetro', async () => {
  render(<StrategyForm strategy={strategy} save={vi.fn()} />);
  const entry = screen.getByLabelText('Entrada') as HTMLTextAreaElement;
  fireEvent.change(entry, { target: { value: 'texto antiguo' } });
  await waitFor(() => expect(entry).toHaveAttribute('aria-invalid', 'true'));
  entry.focus();
  await userEvent.tab();
  // La posición del error es el primer control después del editor.
  await userEvent.tab();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Insertar cruce de medias' })).toHaveFocus(),
  );
  await userEvent.keyboard(' ');
  await waitFor(() => expect(entry).toHaveFocus());
  expect(entry).toHaveValue(strategy.rules.entry);
  await waitFor(() => expect(entry.selectionStart).toBe(strategy.rules.entry.length));
  await waitFor(() => expect(entry).toHaveAttribute('aria-invalid', 'false'));
  fireEvent.change(screen.getByLabelText('Parámetros (objeto JSON de números)'), {
    target: { value: '{"rapida":0,"lenta":50}' },
  });
  await waitFor(() => expect(entry).toHaveAttribute('aria-invalid', 'true'));
  expect(entry).toHaveAccessibleDescription(/periodo.*caracteres/i);
});

it('el vacío no alerta al cargar y el guardado bloquea editores y ejemplos sin borrar cambios', async () => {
  const view = render(<StrategyForm save={vi.fn()} />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Crear estrategia' })).toBeDisabled();
  view.unmount();
  let finish!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<StrategyForm strategy={strategy} save={save} />);
  fireEvent.change(screen.getByLabelText('Nota del cambio'), {
    target: { value: 'Reglas verificadas de nuevo' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
  expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
  expect(screen.getByLabelText('Entrada')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Insertar cruce de medias' })).toBeDisabled();
  expect(screen.getByLabelText('Entrada')).toHaveValue(strategy.rules.entry);
  finish();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Guardar nueva versión' })).toBeEnabled(),
  );
});

it('la ficha explica reglas antiguas antes de pulsar y bloquea las tres acciones enfocables', async () => {
  const invalid = {
    ...strategy,
    executable: false,
    rules: { ...strategy.rules, entry: 'Comprar al cruce' },
  };
  const run = vi.spyOn(window.tradia.backtest, 'run');
  const stress = vi.spyOn(window.tradia.stress, 'run');
  const comparison = vi.spyOn(window.tradia.backtest, 'runRegimeComparison');
  render(
    <StrategyDetail strategy={invalid} latest={invalid} history={[]} changeStatus={vi.fn()} />,
  );
  const notice = screen.getByRole('status', { name: 'Reglas no ejecutables' });
  expect(notice).toHaveTextContent(/Estas reglas no se pueden ejecutar:.*Entrada, caracteres/);
  expect(within(notice).getByRole('link', { name: 'Editar reglas' })).toHaveAttribute(
    'href',
    `#estrategias/${strategy.id}/editar`,
  );
  for (const name of ['Lanzar backtest', 'Ejecutar pruebas de estrés', 'Ejecutar comparación']) {
    const button = await screen.findByRole('button', { name });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(/Desactivado hasta/);
    button.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(button).toHaveFocus());
  }
  expect(run).not.toHaveBeenCalled();
  expect(stress).not.toHaveBeenCalled();
  expect(comparison).not.toHaveBeenCalled();
});

it('ejecuta reglas válidas del adaptador, persiste informe y estrés y conserva la validez de cada versión', async () => {
  // El contrato distingue la implementación registrada de las reglas compilables.
  expect(strategy.executable).toBe(false);
  expect(parseStrategyRules(strategy.rules, strategy.parameters).ok).toBe(true);
  const report = await window.tradia.backtest.run({
    strategyId: strategy.id,
    desde: '2015-01-01',
    hasta: '2024-12-31',
  });
  expect(report.trades.length).toBeGreaterThan(0);
  expect(report.dataSource).toBe('simulated');
  expect(await window.tradia.backtest.get(report.id)).toEqual(report);
  expect(await window.tradia.backtest.list({ strategyId: strategy.id, version: 1 })).toEqual([
    report,
  ]);
  const stress = await window.tradia.stress.run({ strategyId: strategy.id, version: 1 });
  expect(stress).toHaveLength(3);
  expect(await window.tradia.stress.get({ strategyId: strategy.id, version: 1 })).toEqual(stress);
  await expect(
    window.tradia.backtest.run({ strategyId: strategy.id, params: { rapida: 0 } }),
  ).rejects.toThrow(/reglas-invalidas/);
  const invalid = await window.tradia.strategies.update({
    id: strategy.id,
    note: 'Regla heredada no válida',
    rules: { ...strategy.rules, entry: 'Comprar' },
  });
  expect(invalid.executable).toBe(false);
  const firstVersion = await window.tradia.strategies.get({ id: strategy.id, version: 1 });
  expect(parseStrategyRules(firstVersion!.rules, firstVersion!.parameters).ok).toBe(true);
  await expect(
    window.tradia.backtest.runRegimeComparison({ strategyId: strategy.id, version: 2 }),
  ).rejects.toThrow(/reglas-invalidas/);
});

it.each(['backtest', 'stress', 'comparison'] as const)(
  'trata reglas-invalidas del IPC de %s y ofrece editar sin reenviar',
  async (kind) => {
    const error = Object.assign(
      new Error('Error invoking remote method: [reglas-invalidas] Regla rechazada'),
      { code: 'reglas-invalidas' },
    );
    const api =
      kind === 'backtest'
        ? vi.spyOn(window.tradia.backtest, 'run').mockRejectedValue(error)
        : kind === 'stress'
          ? vi.spyOn(window.tradia.stress, 'run').mockRejectedValue(error)
          : vi.spyOn(window.tradia.backtest, 'runRegimeComparison').mockRejectedValue(error);
    if (kind === 'comparison') {
      const connectivity = await window.tradia.connectivity.getState();
      vi.spyOn(window.tradia.connectivity, 'getState').mockResolvedValue({
        ...connectivity,
        status: 'online',
      });
    }
    render(
      kind === 'backtest' ? (
        <BacktestLauncher strategy={strategy} />
      ) : kind === 'stress' ? (
        <StressResults strategyId={strategy.id} version={1} executable />
      ) : (
        <RegimeBacktestComparison strategy={strategy} readOnly={false} />
      ),
    );
    const name =
      kind === 'backtest'
        ? 'Lanzar backtest'
        : kind === 'stress'
          ? 'Ejecutar pruebas de estrés'
          : 'Ejecutar comparación';
    const button = await screen.findByRole('button', { name });
    await waitFor(() => expect(button).not.toBeDisabled());
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Estas reglas no se pueden ejecutar',
    );
    expect(screen.getByRole('link', { name: 'Editar reglas' })).toBeVisible();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    expect(api).toHaveBeenCalledTimes(1);
  },
);

it('conserva la edición de las reglas descriptivas de una implementación clásica registrada', async () => {
  const classic = {
    ...strategy,
    executable: true,
    rules: {
      entry: 'Cruce alcista',
      exit: 'Cruce bajista',
      stop: 'Stop del 5 %',
      target: 'Salida por señal',
    },
  };
  const save = vi.fn().mockResolvedValue(undefined);
  render(<StrategyForm strategy={classic} save={save} />);
  expect(screen.getByText(/implementación clásica registrada/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Nota del cambio'), {
    target: { value: 'Aclaro el alcance de esta estrategia' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ rules: classic.rules }),
    'Aclaro el alcance de esta estrategia',
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each(['entryShort', 'exitShort'] as const)(
  'asocia y anuncia el error de %s, y selecciona su posición por teclado',
  async (field) => {
    const rules = {
      ...strategy.rules,
      entryShort: 'cruza_abajo(sma(rapida), sma(lenta))',
      exitShort: 'cruza_arriba(sma(rapida), sma(lenta))',
    };
    render(<StrategyForm strategy={{ ...strategy, rules }} save={vi.fn()} />);
    const label = field === 'entryShort' ? 'Entrada en corto' : 'Salida del corto';
    const editor = screen.getByLabelText(label) as HTMLTextAreaElement;
    expect(editor).not.toBeRequired();
    editor.focus();
    fireEvent.change(editor, { target: { value: 'cierre > desconocido' } });
    const parsed = parseStrategyRules({ ...rules, [field]: editor.value }, strategy.parameters);
    if (parsed.ok) throw new Error('Se esperaba el error de la regla de corto');
    const error = parsed.errors.find((item) => item.field === field)!;
    await waitFor(() => expect(editor).toHaveAttribute('aria-invalid', 'true'));
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveAccessibleDescription(
      new RegExp(`caracteres ${error.start + 1}–${error.end}`),
    );
    expect(document.getElementById(`strategy-rule-${field}-result`)).toHaveAttribute(
      'aria-live',
      'polite',
    );
    screen.getByRole('button', { name: /desconocido.*caracteres/ }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor.selectionStart).toBe(error.start);
    expect(editor.selectionEnd).toBe(error.end);
    fireEvent.submit(editor.closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent(`Corrige ${label}`);
  },
);

it('inserta la pareja de corto, señala el campo que falta y guarda ambas reglas opcionales', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<StrategyForm strategy={strategy} save={save} />);
  const entry = screen.getByLabelText('Entrada en corto');
  const exit = screen.getByLabelText('Salida del corto');
  expect(entry).toHaveValue('');
  expect(exit).toHaveValue('');
  expect(entry).not.toBeRequired();
  expect(exit).not.toBeRequired();
  screen.getByRole('button', { name: 'Insertar cruce de medias en corto' }).focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(entry).toHaveFocus());
  expect(entry).toHaveValue('cruza_abajo(sma(rapida), sma(lenta))');
  await waitFor(() => expect(exit).toHaveAttribute('aria-invalid', 'true'));
  expect(exit).toHaveAccessibleDescription(/van en pareja.*caracteres 1–1/);
  screen.getByRole('button', { name: 'Insertar salida del corto por cruce' }).focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(exit).toHaveFocus());
  await waitFor(() => expect(exit).toHaveAttribute('aria-invalid', 'false'));
  fireEvent.change(screen.getByLabelText('Nota del cambio'), {
    target: { value: 'Añado las reglas de entrada y salida en corto' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      rules: {
        ...strategy.rules,
        entryShort: 'cruza_abajo(sma(rapida), sma(lenta))',
        exitShort: 'cruza_arriba(sma(rapida), sma(lenta))',
      },
    }),
    expect.any(String),
  );
});

it.each([
  ['largo', {}],
  ['largo y corto', { entryShort: 'cierre < sma(20)', exitShort: 'cierre > sma(20)' }],
  ['corto', { entry: '', entryShort: 'cierre < sma(20)', exitShort: 'cierre > sma(20)' }],
] as const)(
  'la ficha describe %s y muestra las reglas del lado seleccionado',
  async (side, rules) => {
    const own = { ...strategy, rules: { ...strategy.rules, ...rules } };
    render(<StrategyDetail strategy={own} latest={own} history={[]} changeStatus={vi.fn()} />);
    expect(screen.getByText(`Opera en: ${side}.`)).toBeVisible();
    if (side !== 'largo') {
      expect(await screen.findByText(/Corto con dinero real desactivado/)).toBeVisible();
      expect(screen.getByText('cierre < sma(20)')).toBeVisible();
      expect(screen.getByText('cierre > sma(20)')).toBeVisible();
    }
    await waitFor(() => expect(screen.queryByText('Cargando evidencia…')).not.toBeInTheDocument());
  },
);

it('el adaptador simulado ejecuta cortos de una propia y persiste el lado en el historial', async () => {
  const own = await window.tradia.strategies.update({
    id: strategy.id,
    note: 'Añado cruce de medias bajista',
    rules: {
      ...strategy.rules,
      entryShort: 'cruza_abajo(sma(rapida), sma(lenta))',
      exitShort: 'cruza_arriba(sma(rapida), sma(lenta))',
    },
  });
  expect(own.executable).toBe(false);
  const report = await window.tradia.backtest.run({ strategyId: own.id, version: own.version });
  expect(report.trades.some((trade) => trade.side === 'corto')).toBe(true);
  expect(await window.tradia.backtest.get(report.id)).toEqual(report);
  expect(await window.tradia.backtest.list({ strategyId: own.id, version: 2 })).toEqual([report]);
});

it('avisa en la ayuda del objetivo de que sin objetivo el motor de riesgo vetará la compra', () => {
  render(<StrategyForm strategy={strategy} save={vi.fn()} />);
  const target = screen.getByLabelText('Objetivo');
  expect(target).toHaveAccessibleDescription(
    /Con «ninguno» \(Sin objetivo\) el motor de riesgo vetará la compra por la relación beneficio\/riesgo\./,
  );
});

it.each([
  ['Objetivo', 'Sin objetivo', 'ninguno', 'target'],
  ['Stop', 'Insertar stop del 2 %', '2%', 'stop'],
])(
  'valida %s al insertar sobre un campo vacío sin esperar al reloj',
  (label, button, value, field) => {
    vi.useFakeTimers();
    render(<StrategyForm save={vi.fn()} />);
    const editor = screen.getByLabelText(label);
    const result = document.getElementById(`strategy-rule-${field}-result`)!;
    expect(editor).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(editor).toHaveValue(value);
    expect(result).toHaveTextContent(/^Válida$/);
    expect(editor).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText(/está vacío/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    expect(result).toHaveTextContent(/^Válida$/);
    expect(editor).toHaveAttribute('aria-invalid', 'false');
    act(() => vi.advanceTimersByTime(100));
    expect(result).toHaveTextContent(/^Válida$/);
    expect(screen.queryByText(/está vacío/)).not.toBeInTheDocument();
  },
);

it('mantiene los 200 ms al escribir y retira los errores del valor anterior mientras comprueba', () => {
  vi.useFakeTimers();
  render(<StrategyForm strategy={strategy} save={vi.fn()} />);
  const target = screen.getByLabelText('Objetivo');
  const result = document.getElementById('strategy-rule-target-result')!;
  fireEvent.change(target, { target: { value: 'desconocido' } });
  expect(result).toHaveTextContent(/^Comprobando…$/);
  expect(target).toHaveAttribute('aria-invalid', 'false');
  act(() => vi.advanceTimersByTime(199));
  expect(result).toHaveTextContent(/^Comprobando…$/);
  act(() => vi.advanceTimersByTime(1));
  expect(target).toHaveAttribute('aria-invalid', 'true');
  expect(result).toHaveTextContent(/desconocido/);

  fireEvent.change(target, { target: { value: '6%' } });
  expect(result).toHaveTextContent(/^Comprobando…$/);
  expect(result).not.toHaveTextContent(/desconocido/);
  expect(target).toHaveAttribute('aria-invalid', 'false');
  act(() => vi.advanceTimersByTime(199));
  expect(result).toHaveTextContent(/^Comprobando…$/);
  act(() => vi.advanceTimersByTime(1));
  expect(result).toHaveTextContent(/^Válida$/);

  // Una inserción sustituye también una validación manual aún pendiente.
  fireEvent.change(target, { target: { value: 'desconocido' } });
  act(() => vi.advanceTimersByTime(100));
  fireEvent.click(screen.getByRole('button', { name: 'Sin objetivo' }));
  expect(result).toHaveTextContent(/^Válida$/);
  act(() => vi.advanceTimersByTime(200));
  expect(result).toHaveTextContent(/^Válida$/);
  expect(target).toHaveAttribute('aria-invalid', 'false');
});
