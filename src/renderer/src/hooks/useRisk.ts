import { useCallback, useEffect, useRef, useState } from 'react';
import type { RiskOverview, RiskVeto } from '../../../shared/risk';

export function useRisk() {
  const [overview, setOverview] = useState<Partial<RiskOverview>>({});
  const [vetoes, setVetoes] = useState<RiskVeto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const revision = useRef(0);
  const vetoRevision = useRef(0);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    const stateVersion = revision.current;
    const logVersion = vetoRevision.current;
    setLoading(true);
    setError(null);
    const api = window.tradia.risk;
    const results = await Promise.allSettled([
      api.getLimits(),
      api.getKillSwitch(),
      api.getCaution(),
      api.listVetoes(),
    ]);
    if (version !== generation.current) return;
    const [limits, killSwitch, caution, log] = results;
    if (stateVersion === revision.current)
      setOverview((previous) => ({
        ...previous,
        ...(limits.status === 'fulfilled' ? { limits: limits.value } : {}),
        ...(killSwitch.status === 'fulfilled' ? { killSwitch: killSwitch.value } : {}),
        ...(caution.status === 'fulfilled' ? { caution: caution.value } : {}),
      }));
    if (log.status === 'fulfilled')
      setVetoes((previous) => {
        if (logVersion === vetoRevision.current) return log.value;
        const byId = new Map(log.value.map((row) => [row.id, row]));
        previous.forEach((row) => byId.set(row.id, row));
        return [...byId.values()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
          .slice(0, 500);
      });
    setError(
      results.some((result) => result.status === 'rejected')
        ? 'No se pudo actualizar el estado de riesgo. Inténtalo de nuevo.'
        : null,
    );
    setLoading(false);
  }, []);
  useEffect(() => {
    const offChanged = window.tradia.risk.onChanged((value) => {
      revision.current++;
      setOverview(value);
    });
    const offVetoed = window.tradia.risk.onVetoed((value) => {
      vetoRevision.current++;
      setVetoes((previous) =>
        [value, ...previous.filter((row) => row.id !== value.id)].slice(0, 500),
      );
    });
    void reload();
    return () => {
      generation.current++;
      offChanged();
      offVetoed();
    };
  }, [reload]);
  const updateKillSwitch = useCallback((killSwitch: RiskOverview['killSwitch']) => {
    revision.current++;
    setOverview((previous) => ({ ...previous, killSwitch }));
  }, []);
  return { ...overview, vetoes, loading, error, reload, updateKillSwitch };
}
export type RiskState = ReturnType<typeof useRisk>;
