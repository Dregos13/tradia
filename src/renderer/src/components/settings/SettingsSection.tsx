import type { ReactNode } from 'react';

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" aria-label={title}>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-panel">{children}</div>
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
