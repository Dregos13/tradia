import {
  LIVE_DECLARATION_REQUIREMENTS,
  type LiveChecklistItem,
  type LiveDeclareRequest,
  type LiveDeclarationRequirement,
} from '../../../../shared/live';
import type { DeliveryTestableChannel } from '../../../../shared/journal';
import { DeclarationForm } from './DeclarationForm';
import { LiveIcon, RequirementStatus, timestamp } from './presentation';

export function ChecklistRow({
  item,
  disabled,
  stopDisabled,
  onDeclare,
  onTestStop,
  onTestAlert,
  channel,
  onChannel,
  onOpenValidation,
  onOpenPaper,
  onOpenAlerts,
}: {
  item: LiveChecklistItem;
  disabled: boolean;
  stopDisabled: boolean;
  onDeclare: (request: LiveDeclareRequest) => Promise<boolean>;
  onTestStop: () => void;
  onTestAlert: () => void;
  channel: DeliveryTestableChannel;
  onChannel: (channel: DeliveryTestableChannel) => void;
  onOpenValidation?: () => void;
  onOpenPaper?: () => void;
  onOpenAlerts?: () => void;
}) {
  const manual = (LIVE_DECLARATION_REQUIREMENTS as readonly string[]).includes(item.requirement);
  return (
    <li className="live-checklist-row">
      <div>
        <RequirementStatus state={item.state} />
        <p className="live-origin">
          {!manual && <LiveIcon kind="lock" />}
          {manual ? 'Declaración del usuario' : 'Verificación automática'}
        </p>
      </div>
      <div>
        <h4>{item.title}</h4>
        <p>{item.evidence ?? 'Sin evidencia guardada.'}</p>
        {item.markedAt && (
          <p className="live-meta">
            {manual ? 'Declarada' : 'Evaluada'}{' '}
            <time dateTime={item.markedAt}>{timestamp(item.markedAt)}</time>
          </p>
        )}
        {item.declaration && <p>{item.declaration}</p>}
        {item.declarationDetail && <p className="live-detail">{item.declarationDetail}</p>}
        {manual ? (
          <DeclarationForm
            key={`${item.markedAt}-${item.state}-${item.declarationDetail}`}
            item={item}
            requirement={item.requirement as LiveDeclarationRequirement}
            disabled={disabled}
            onDeclare={onDeclare}
          />
        ) : (
          <div className="live-actions">
            {item.requirement === 'validacion-fuera-muestra' && onOpenValidation && (
              <button className="button" onClick={onOpenValidation}>
                Ver validación
              </button>
            )}
            {item.requirement === 'paper-continuo' && onOpenPaper && (
              <button className="button" onClick={onOpenPaper}>
                Ver paper
              </button>
            )}
            {item.requirement === 'parada-probada' && (
              <button className="button" disabled={disabled || stopDisabled} onClick={onTestStop}>
                Probar parada
              </button>
            )}
            {item.requirement === 'alertas-activas' && (
              <>
                <label>
                  Canal de prueba
                  <select
                    value={channel}
                    disabled={disabled}
                    onChange={(event) => onChannel(event.target.value as DeliveryTestableChannel)}
                  >
                    <option value="telegram">Telegram</option>
                    <option value="correo">Correo</option>
                  </select>
                </label>
                <button className="button" disabled={disabled} onClick={onTestAlert}>
                  Enviar alerta de prueba
                </button>
                {onOpenAlerts && (
                  <button className="button" onClick={onOpenAlerts}>
                    Configurar alertas
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
