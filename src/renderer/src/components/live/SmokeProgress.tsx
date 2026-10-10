import type { LiveSmokeTestResult } from '../../../../shared/live';
import { LiveIcon } from './presentation';
import { time } from '../orders/orderPresentation';

/** Execution is a separate visible fact, derived only from the received fill price. */
export function SmokeProgress({
  result,
  running,
}: {
  result: LiveSmokeTestResult | null;
  running: boolean;
}) {
  const purchase = result?.steps.find((row) => row.step === 'compra-enviada')?.at ?? null;
  const closed = result?.steps.find((row) => row.step === 'posicion-cerrada')?.at ?? null;
  const reconciled = result?.steps.find((row) => row.step === 'conciliacion-ok')?.at ?? null;
  const filled = result?.buyExecutedPrice != null;
  const steps = [
    {
      label: 'Compra enviada',
      complete: !!purchase,
      at: purchase,
      failed: result?.failedStep === 'compra-enviada' && !purchase,
    },
    {
      label: 'Ejecución de compra',
      complete: filled,
      at: null,
      failed: result?.failedStep === 'compra-enviada' && !!purchase,
    },
    {
      label: 'Posición cerrada',
      complete: !!closed,
      at: closed,
      failed: result?.failedStep === 'posicion-cerrada',
    },
    {
      label: 'Conciliación sin descuadres',
      complete: !!reconciled && result?.discrepancies === 0,
      at: reconciled,
      failed: result?.failedStep === 'conciliacion-ok',
    },
  ];
  const current = steps.findIndex((step) => !step.complete);
  return (
    <>
      <p role="status" aria-atomic="true" className="live-meta">
        {running && current >= 0 ? `Prueba en curso · ${steps[current]?.label}` : ''}
      </p>
      <ol className="live-smoke-steps" aria-label="Pasos de la prueba de humo">
        {steps.map((step, index) => {
          const status = step.failed
            ? 'Fallido'
            : step.complete
              ? 'Completado'
              : running && index === current
                ? 'En curso'
                : result?.failedStep && index > current
                  ? 'No ejecutado'
                  : 'Pendiente';
          return (
            <li
              key={step.label}
              className={`live-smoke-step ${step.failed ? 'live-smoke-failed' : step.complete ? 'live-smoke-complete' : running && index === current ? 'live-smoke-running' : ''}`}
              aria-current={running && index === current ? 'step' : undefined}
            >
              <LiveIcon kind={step.failed ? 'pendiente' : step.complete ? 'cumplido' : 'revisar'} />
              <div>
                <strong>{step.label}</strong>
                <span>{status}</span>
                {step.at && <time dateTime={step.at}>{time(step.at)}</time>}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
