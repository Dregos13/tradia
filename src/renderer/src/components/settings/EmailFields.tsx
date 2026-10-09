import {
  DELIVERY_ADDRESS_MAX_LENGTH,
  DELIVERY_HOST_MAX_LENGTH,
  type EmailChannelInput,
  type SmtpSecurity,
} from '../../../../shared/journal';

export function EmailFields({
  value,
  onChange,
}: {
  value: EmailChannelInput;
  onChange: (patch: Partial<EmailChannelInput>) => void;
}) {
  return (
    <>
      <div className="channel-field">
        <label htmlFor="email-host">Servidor SMTP</label>
        <input
          id="email-host"
          maxLength={DELIVERY_HOST_MAX_LENGTH}
          value={value.host}
          onChange={(e) => onChange({ host: e.target.value })}
        />
      </div>
      <div className="channel-field">
        <label htmlFor="email-port">Puerto</label>
        <input
          id="email-port"
          type="number"
          min="1"
          max="65535"
          value={Number.isNaN(value.port) ? '' : value.port}
          onChange={(e) => onChange({ port: e.target.valueAsNumber })}
        />
      </div>
      <div className="channel-field">
        <label htmlFor="email-user">Usuario SMTP</label>
        <input
          id="email-user"
          maxLength={DELIVERY_ADDRESS_MAX_LENGTH}
          value={value.user}
          onChange={(e) => onChange({ user: e.target.value })}
        />
      </div>
      <div className="channel-field">
        <label htmlFor="email-to">Destino</label>
        <input
          id="email-to"
          type="email"
          maxLength={DELIVERY_ADDRESS_MAX_LENGTH}
          value={value.to}
          onChange={(e) => onChange({ to: e.target.value })}
        />
      </div>
      <div className="channel-field">
        <label htmlFor="email-security">Seguridad</label>
        <select
          id="email-security"
          value={value.security}
          onChange={(e) => onChange({ security: e.target.value as SmtpSecurity })}
        >
          <option value="starttls">STARTTLS</option>
          <option value="tls">TLS</option>
          <option value="ninguna">Sin cifrado</option>
        </select>
      </div>
    </>
  );
}
