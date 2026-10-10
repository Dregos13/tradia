import { useEffect, useRef, useState } from 'react';
import {
  DEVIATION_MARGIN_PP_BOUNDS,
  DEVIATION_SLIPPAGE_BPS_BOUNDS,
} from '../../../../shared/broker';

export function DeviationMargins({ onSaved }: { onSaved: () => Promise<void> }) {
  const [values, setValues] = useState({ pp: '', pb: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<'pp' | 'pb' | null>(null);
  const [saved, setSaved] = useState(false);
  const pp = useRef<HTMLInputElement>(null);
  const pb = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const lock = useRef(false);
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const settings = await window.tradia.settings.get();
      if (mounted.current)
        setValues({
          pp: String(settings.deviationMarginPp),
          pb: String(settings.deviationSlippageBps),
        });
    } catch {
      if (mounted.current) setError('No se pudieron cargar los márgenes. Reintenta la carga.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async () => {
    if (loading || lock.current) return;
    setSaved(false);
    setInvalid(null);
    setError('');
    for (const [key, bounds] of [
      ['pp', DEVIATION_MARGIN_PP_BOUNDS],
      ['pb', DEVIATION_SLIPPAGE_BPS_BOUNDS],
    ] as const) {
      const value = Number(values[key]);
      if (
        !values[key].trim() ||
        !Number.isFinite(value) ||
        value < bounds.min ||
        value > bounds.max
      ) {
        setInvalid(key);
        setError(
          `Usa un valor entre ${bounds.min.toLocaleString('es-ES')} y ${bounds.max} ${key === 'pp' ? 'pp' : 'pb'}.`,
        );
        (key === 'pp' ? pp : pb).current?.focus();
        return;
      }
    }
    lock.current = true;
    setBusy(true);
    try {
      const settings = await window.tradia.settings.set({
        deviationMarginPp: Number(values.pp),
        deviationSlippageBps: Number(values.pb),
      });
      if (!mounted.current) return;
      setValues({
        pp: String(settings.deviationMarginPp),
        pb: String(settings.deviationSlippageBps),
      });
      setSaved(true);
      await onSaved();
    } catch {
      if (mounted.current) setError('No se pudieron guardar los márgenes. Inténtalo de nuevo.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="deviation-margins" aria-labelledby="deviation-margin-title">
      <div>
        <h2 id="deviation-margin-title">Umbrales de desviación</h2>
        <p>Se aplican a futuros cálculos y al periodo actual al recalcular.</p>
      </div>
      <form
        noValidate
        aria-busy={loading || busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="deviation-fields">
          {(['pp', 'pb'] as const).map((key) => (
            <label key={key}>
              {key === 'pp' ? 'Rentabilidad · ± pp' : 'Slippage medio máximo · pb'}
              <input
                ref={key === 'pp' ? pp : pb}
                type="number"
                step="any"
                min={key === 'pp' ? 0.1 : 1}
                max={key === 'pp' ? 50 : 500}
                value={values[key]}
                disabled={loading || busy}
                aria-invalid={invalid === key}
                aria-describedby={invalid === key ? 'deviation-margin-error' : undefined}
                onChange={(event) => {
                  setValues({ ...values, [key]: event.target.value });
                  setSaved(false);
                }}
              />
            </label>
          ))}
          <button className="button primary" disabled={loading || busy || !values.pp || !values.pb}>
            {busy ? 'Guardando márgenes…' : 'Guardar márgenes'}
          </button>
        </div>
        {loading && <p role="status">Cargando márgenes…</p>}
        {error && (
          <p id="deviation-margin-error" role="alert">
            {error}
            {!values.pp && (
              <button type="button" className="button" onClick={() => void load()}>
                Reintentar márgenes
              </button>
            )}
          </p>
        )}
        <p role="status" className={saved ? 'deviation-saved' : undefined}>
          {saved ? 'Márgenes guardados' : ''}
        </p>
      </form>
    </section>
  );
}
