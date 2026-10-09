import { useEffect, useState } from 'react';
import { isDeliveryConfigInput } from '../../../../shared/ipc';
import {
  DELIVERY_CHAT_ID_MAX_LENGTH,
  DELIVERY_SECRET_KEYS,
  type DeliveryConfig,
  type DeliveryConfigInput,
  type DeliveryTestableChannel,
  type EmailChannelInput,
  type TelegramChannelInput,
} from '../../../../shared/journal';
import { SettingsFeedback, SettingsSection } from './SettingsSection';
import { EventFields, SecretField } from './ChannelFields';
import { EmailFields } from './EmailFields';

function inputConfig(config: DeliveryConfig): DeliveryConfigInput {
  const { hasToken: _token, ...telegram } = config.telegram;
  const { hasPassword: _password, ...email } = config.email;
  return { telegram, email };
}

export function DeliverySettings() {
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void window.tradia.delivery
      .getConfig()
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch(() => {
        if (active) setError('No se pudieron cargar los canales. Inténtalo de nuevo.');
      });
    return () => {
      active = false;
    };
  }, [retry]);
  async function save(
    channel: DeliveryTestableChannel,
    value: TelegramChannelInput | EmailChannelInput,
    secret: string,
  ) {
    if (!config) throw new Error('Configuración no disponible');
    const next = inputConfig(config);
    if (channel === 'telegram') next.telegram = value as TelegramChannelInput;
    else next.email = value as EmailChannelInput;
    if (!isDeliveryConfigInput(next)) throw new Error('Configuración inválida');
    if (secret) {
      await window.tradia.secrets.setKey(
        channel === 'telegram'
          ? DELIVERY_SECRET_KEYS.telegramBotToken
          : DELIVERY_SECRET_KEYS.emailPassword,
        secret,
      );
      setConfig(
        (previous) =>
          previous &&
          (channel === 'telegram'
            ? { ...previous, telegram: { ...previous.telegram, hasToken: true } }
            : { ...previous, email: { ...previous.email, hasPassword: true } }),
      );
    }
    const saved = await window.tradia.delivery.setConfig(next);
    setConfig(saved);
  }
  if (!config)
    return (
      <SettingsSection title="Canales externos" description="Telegram y correo son opcionales.">
        {error ? (
          <>
            <SettingsFeedback error={error} />
            <button className="button" onClick={() => setRetry((value) => value + 1)}>
              Reintentar canales
            </button>
          </>
        ) : (
          <p className="settings-message" role="status">
            Cargando canales…
          </p>
        )}
      </SettingsSection>
    );
  return (
    <>
      {(['telegram', 'correo'] as const).map((channel) => (
        <ChannelSettings
          key={channel}
          channel={channel}
          config={config}
          busy={busy}
          setBusy={setBusy}
          save={save}
        />
      ))}
    </>
  );
}

function ChannelSettings({
  channel,
  config,
  busy,
  setBusy,
  save,
}: {
  channel: DeliveryTestableChannel;
  config: DeliveryConfig;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  save: (
    channel: DeliveryTestableChannel,
    value: TelegramChannelInput | EmailChannelInput,
    secret: string,
  ) => Promise<void>;
}) {
  const telegram = channel === 'telegram';
  const title = telegram ? 'Telegram' : 'Correo';
  const [draft, setDraft] = useState(() => inputConfig(config));
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const value = telegram ? draft.telegram : draft.email;
  const stored = telegram ? config.telegram.hasToken : config.email.hasPassword;
  const candidate = {
    ...inputConfig(config),
    [telegram ? 'telegram' : 'email']: { ...value, enabled: true },
  };
  const valid = isDeliveryConfigInput(candidate) && (stored || secret.trim().length > 0);
  function editTelegram(patch: Partial<TelegramChannelInput>) {
    setDraft((old) => ({ ...old, telegram: { ...old.telegram, ...patch } }));
    setMessage('');
  }
  function editEmail(patch: Partial<EmailChannelInput>) {
    setDraft((old) => ({ ...old, email: { ...old.email, ...patch } }));
    setMessage('');
  }
  async function submit(test: boolean) {
    setMessage('');
    setError('');
    const submitted = { ...inputConfig(config), [telegram ? 'telegram' : 'email']: value };
    if (!isDeliveryConfigInput(submitted) || ((value.enabled || test || secret) && !valid)) {
      setError(
        telegram
          ? 'Introduce un token y un chat válido, sin espacios.'
          : 'Revisa servidor SMTP, puerto (1–65535), usuario, contraseña y destino de correo.',
      );
      return;
    }
    setBusy(true);
    setTesting(test);
    const submittedSecret = secret;
    setSecret('');
    try {
      await save(channel, value, submittedSecret);
      if (test) {
        const result = await window.tradia.delivery.test({ channel });
        if (!result.ok) {
          setError(
            `No se pudo enviar la prueba por ${title}. Revisa el destino, las credenciales y la conexión.`,
          );
          return;
        }
        setMessage(`Prueba enviada por ${title}`);
      } else setMessage(`${title} guardado.`);
    } catch {
      setError(
        `No se pudo ${test ? 'enviar la prueba' : 'guardar la configuración'} de ${title}. Revisa la conexión y el almacén de secretos e inténtalo de nuevo.`,
      );
    } finally {
      setBusy(false);
      setTesting(false);
    }
  }
  return (
    <SettingsSection
      title={title}
      description={
        telegram
          ? 'Señales y resúmenes en un chat opcional.'
          : 'Entrega por SMTP a una dirección de destino.'
      }
    >
      <form
        className="settings-form operational-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        aria-busy={busy}
      >
        <fieldset disabled={busy} className="channel-fields">
          <div className="setting-row channel-toggle">
            <div>
              <strong>Canal {value.enabled ? 'activo' : 'desactivado'}</strong>
              <p id={`${channel}-help`}>
                {valid
                  ? 'La configuración está completa.'
                  : 'Completa la configuración antes de activarlo o enviar una prueba.'}
              </p>
            </div>
            <label className="setting-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label={`Activar ${title}`}
                aria-describedby={`${channel}-help`}
                checked={value.enabled}
                disabled={!value.enabled && !valid}
                onChange={(e) =>
                  telegram
                    ? editTelegram({ enabled: e.target.checked })
                    : editEmail({ enabled: e.target.checked })
                }
              />
              <span className="switch-track" aria-hidden="true" />
            </label>
          </div>
          <div className="channel-grid">
            <SecretField
              key={`${channel}-${stored}`}
              label={telegram ? 'Token del bot' : 'Contraseña SMTP'}
              id={`${channel}-secret`}
              stored={stored}
              value={secret}
              onChange={setSecret}
            />
            {telegram ? (
              <div className="channel-field">
                <label htmlFor="telegram-chat">Chat</label>
                <input
                  id="telegram-chat"
                  maxLength={DELIVERY_CHAT_ID_MAX_LENGTH}
                  value={draft.telegram.chatId}
                  onChange={(e) => editTelegram({ chatId: e.target.value })}
                />
              </div>
            ) : (
              <EmailFields value={draft.email} onChange={editEmail} />
            )}
          </div>
          <EventFields
            events={value.events}
            onChange={(events) => (telegram ? editTelegram({ events }) : editEmail({ events }))}
          />
          <div className="settings-actions">
            <button
              className="button"
              type="button"
              disabled={!valid}
              onClick={() => void submit(true)}
            >
              {testing ? 'Enviando…' : 'Enviar prueba'}
            </button>
            <button className="button primary" type="submit">
              Guardar {title}
            </button>
          </div>
        </fieldset>
      </form>
      <SettingsFeedback error={error} message={message} />
    </SettingsSection>
  );
}
