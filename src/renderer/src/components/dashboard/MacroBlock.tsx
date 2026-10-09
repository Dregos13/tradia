import type { MacroSeriesSnapshot } from '../../../../shared/ipc';
import { MacroCard } from '../macro/MacroCard';
import { indicators } from '../macro/model';
import '../macro/macro.css';
export function MacroBlock({
  series,
  simulated,
}: {
  series: MacroSeriesSnapshot[];
  simulated: boolean;
}) {
  return (
    <>
      <p>
        Régimen · <strong>Sin clasificar</strong> · Fuente {simulated ? 'Simulada' : 'FRED'}
      </p>
      <div className="dashboard-macro">
        {['VIXCLS', 'DGS10', 'CPIAUCSL']
          .map((id) => indicators.find((row) => row.id === id)!)
          .map((indicator) => (
            <MacroCard
              key={indicator.id}
              indicator={indicator}
              series={series.find((row) => row.id === indicator.id)}
              simulated={simulated}
            />
          ))}
      </div>
    </>
  );
}
