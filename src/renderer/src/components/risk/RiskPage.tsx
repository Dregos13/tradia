import type { RiskState } from '../../hooks/useRisk';
import { LimitsForm } from './LimitsForm';
import { VetoLog } from './VetoLog';
import { SignalTester } from './SignalTester';
import { CautionBanner } from './CautionBanner';
import './risk.css';
export function RiskPage({ risk }: { risk: RiskState }) {
  return (
    <section className="risk-page" aria-labelledby="risk-page-title">
      <h2 id="risk-page-title">Control de riesgo</h2>
      <p className="risk-muted">Límites independientes y registro de cada decisión vetada.</p>
      <CautionBanner caution={risk.caution} />
      {risk.loading && <p role="status">Cargando estado de riesgo…</p>}
      {risk.error && (
        <div className="risk-error" role="alert">
          <p>{risk.error}</p>
          <button className="button" onClick={() => void risk.reload()}>
            Reintentar
          </button>
        </div>
      )}
      <div className="risk-grid">
        {risk.limits && <LimitsForm limits={risk.limits} caution={risk.caution} />}
        <VetoLog
          vetoes={risk.vetoes}
          loading={risk.loading}
          error={risk.error}
          onRetry={() => void risk.reload()}
        />
        <SignalTester />
      </div>
    </section>
  );
}
