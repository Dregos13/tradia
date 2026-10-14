import type { ReactNode } from 'react';

export function SettingsSection({
  title,
  description,
  children,
  after,
}: {
  title: string;
  description: string;
  children: ReactNode;
  /** Tarjetas propias que siguen al panel en la misma columna, a 24 px. */
  after?: ReactNode;
}) {
  const panel = <div className="settings-panel">{children}</div>;
  return (
    <section data-layout-block={title} className="settings-section" aria-label={title}>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {after ? (
        <div className="settings-stack">
          {panel}
          {after}
        </div>
      ) : (
        panel
      )}
    </section>
  );
}

export function SettingsFeedback({ error, message }: { error: string; message?: string }) {
  return (
    <>
      {message && (
        <p className="settings-message success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="settings-message error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
