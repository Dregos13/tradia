import { useEffect, useState } from 'react';
import type { MacroSeriesSnapshot } from '../../../../shared/ipc';
import type { RegimeOverview } from '../../../../shared/ai';
import { MacroCard } from '../macro/MacroCard';
import { indicators } from '../macro/model';
import { regimeLabels } from '../strategies/regimeLabels';
import '../macro/macro.css';

export function MacroBlock({
  series,
  simulated,
}: {
  series: MacroSeriesSnapshot[];
  simulated: boolean;
}) {
  const [overview, setOverview] = useState<RegimeOverview | null>(null);

  // El mismo régimen que la página «IA»: una única fuente evita que Inicio
  // diga «Sin clasificar» mientras IA muestra el régimen calculado.
  useEffect(() => {
    let active = true;
    const load = () => {
      window.tradia.ai
        .regimeOverview()
        .then((value) => {
          if (active) setOverview(value);
        })
        .catch(() => {
          if (active) setOverview(null);
        });
    };
    load();
    const unsubscribe = window.tradia.ai.onChanged(() => load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const regimeText = overview?.market
    ? overview.stale
      ? `Desactualizado (cierre ${overview.market.sessionDate})`
      : `${regimeLabels[overview.market.direction]} · ${regimeLabels[overview.market.volatility]}`
    : 'Sin clasificar';

  return (
    <>
      <p>
        Régimen · <strong>{regimeText}</strong> · Fuente {simulated ? 'Simulada' : 'FRED'}
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
