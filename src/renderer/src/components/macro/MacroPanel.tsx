import type { MacroSeriesSnapshot } from '../../../../shared/ipc';
import { MacroCard } from './MacroCard';
import { indicators } from './model';
import './macro.css';

export function MacroPanel({
  series,
  simulated = false,
}: {
  series: MacroSeriesSnapshot[];
  simulated?: boolean;
}) {
  return (
    <>
      {simulated && (
        <p className="macro-simulation">
          Datos simulados · Entorno de pruebas. Los valores no representan cotizaciones reales.
        </p>
      )}
      <section className="macro-grid" aria-label="Indicadores macroeconómicos">
        {indicators.map((indicator) => (
          <MacroCard
            key={indicator.id}
            indicator={indicator}
            series={series.find((item) => item.id === indicator.id)}
          />
        ))}
      </section>
    </>
  );
}
