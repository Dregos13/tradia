// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { SettingsPage } from '../SettingsPage';
import { DeliverySettings } from './DeliverySettings';
import { RoutineSettings } from './RoutineSettings';
import { BackupSettings } from './BackupSettings';
import { LogSettings } from './LogSettings';
import {
  DELIVERY_CONFIG_DEFAULTS,
  DELIVERY_SECRET_KEYS,
  ROUTINE_DEFAULTS,
  type BackupInfo,
  type DeliveryConfig,
  type DeliveryConfigInput,
} from '../../../../shared/journal';

let api: ReturnType<typeof createSimulatedAdapter>['api'];
let config: DeliveryConfig;
let secretKeys: Set<string>;
const backup: BackupInfo = {
  fileName: 'tradia-2026-10-09.db',
  sizeBytes: 5033164,
  createdAt: '2026-10-09T02:00:00Z',
  schemaVersion: 8,
  integrityOk: true,
};
beforeEach(() => {
  api = createSimulatedAdapter().api;
  window.tradia = api;
  secretKeys = new Set();
  config = {
    telegram: { ...DELIVERY_CONFIG_DEFAULTS.telegram, hasToken: false },
    email: { ...DELIVERY_CONFIG_DEFAULTS.email, hasPassword: false },
  };
  vi.spyOn(api.secrets, 'setKey').mockImplementation(async (key) => {
    secretKeys.add(key);
  });
  vi.spyOn(api.delivery, 'getConfig').mockImplementation(async () => config);
  vi.spyOn(api.delivery, 'setConfig').mockImplementation(async (value: DeliveryConfigInput) => {
    config = {
      telegram: {
        ...value.telegram,
        hasToken: secretKeys.has(DELIVERY_SECRET_KEYS.telegramBotToken),
      },
      email: { ...value.email, hasPassword: secretKeys.has(DELIVERY_SECRET_KEYS.emailPassword) },
    };
    return config;
  });
  vi.spyOn(api.delivery, 'test').mockResolvedValue({ ok: true, error: null, latencyMs: 12 });
  vi.spyOn(api.backup, 'list').mockResolvedValue([backup]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function channels() {
  await act(async () => {
    render(<DeliverySettings />);
  });
  return {
    telegram: within(screen.getByRole('region', { name: 'Telegram' })),
    email: within(screen.getByRole('region', { name: 'Correo' })),
  };
}
async function fillTelegram() {
  await userEvent.type(screen.getByLabelText('Token del bot'), 'token-secreto');
  await userEvent.type(screen.getByLabelText('Chat'), '-100123');
}
async function fillEmail() {
  await userEvent.type(screen.getByLabelText('Contraseña SMTP'), 'smtp-secreto');
  await userEvent.type(screen.getByLabelText('Servidor SMTP'), 'smtp.example.com');
  await userEvent.type(screen.getByLabelText('Usuario SMTP'), 'tradia@example.com');
  await userEvent.type(screen.getByLabelText('Destino'), 'destino@example.com');
}

describe('canales externos', () => {
  it('bloquea activar y probar hasta validar, sin escribir secretos inválidos', async () => {
    const { telegram, email } = await channels();
    expect(telegram.getByRole('switch')).toBeDisabled();
    expect(email.getByRole('button', { name: 'Enviar prueba' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Token del bot'), 'token-secreto');
    await userEvent.type(screen.getByLabelText('Chat'), 'chat con espacios');
    await userEvent.click(telegram.getByRole('button', { name: 'Guardar Telegram' }));
    expect(telegram.getByRole('alert')).toHaveTextContent('chat válido');
    expect(api.secrets.setKey).not.toHaveBeenCalled();
    expect(api.delivery.setConfig).not.toHaveBeenCalled();
  });
  it('valida destino y puerto SMTP incluso con el canal desactivado', async () => {
    const { email } = await channels();
    await fillEmail();
    fireEvent.change(screen.getByLabelText('Puerto'), { target: { value: '65536' } });
    await userEvent.click(email.getByRole('button', { name: 'Guardar Correo' }));
    expect(email.getByRole('alert')).toHaveTextContent('1–65535');
    expect(api.delivery.setConfig).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Puerto'), { target: { value: '587' } });
    fireEvent.change(screen.getByLabelText('Destino'), { target: { value: 'incorrecto' } });
    expect(email.getByRole('switch')).toBeDisabled();
    await userEvent.click(email.getByRole('button', { name: 'Guardar Correo' }));
    expect(api.secrets.setKey).not.toHaveBeenCalled();
  });
  it.each(['Telegram', 'Correo'] as const)(
    'guarda los eventos y prueba %s sin secretos en delivery',
    async (title) => {
      const regions = await channels();
      const region = title === 'Telegram' ? regions.telegram : regions.email;
      if (title === 'Telegram') await fillTelegram();
      else await fillEmail();
      await userEvent.click(region.getByRole('switch'));
      await userEvent.click(region.getByLabelText('Señal vetada'));
      await userEvent.click(region.getByRole('button', { name: 'Enviar prueba' }));
      expect(await region.findByRole('status')).toHaveTextContent(`Prueba enviada por ${title}`);
      expect(api.delivery.test).toHaveBeenCalledWith({
        channel: title === 'Telegram' ? 'telegram' : 'correo',
      });
      const saved = vi.mocked(api.delivery.setConfig).mock.calls[0]?.[0];
      const channel = title === 'Telegram' ? saved?.telegram : saved?.email;
      expect(channel?.enabled).toBe(true);
      expect(channel?.events).not.toContain('senal-vetada');
      expect(JSON.stringify(saved)).not.toMatch(/secreto|hasToken|hasPassword/);
      expect(region.getByText('Guardado')).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/token-secreto|smtp-secreto/);
    },
  );
  it.each(['Telegram', 'Correo'] as const)(
    'muestra fallo de prueba de %s sin revelar credenciales',
    async (title) => {
      const regions = await channels();
      const region = title === 'Telegram' ? regions.telegram : regions.email;
      if (title === 'Telegram') await fillTelegram();
      else await fillEmail();
      vi.mocked(api.delivery.test).mockResolvedValue({
        ok: false,
        error: 'token-secreto smtp-secreto',
        latencyMs: null,
      });
      await userEvent.click(region.getByRole('button', { name: 'Enviar prueba' }));
      expect(await region.findByRole('alert')).toHaveTextContent(
        'Revisa el destino, las credenciales y la conexión',
      );
      expect(document.body.textContent).not.toMatch(/token-secreto|smtp-secreto/);
    },
  );
  it('no recupera secretos guardados y permite reemplazar sin repintarlos', async () => {
    secretKeys.add(DELIVERY_SECRET_KEYS.telegramBotToken);
    config.telegram = { ...config.telegram, chatId: '@canal', hasToken: true };
    const { telegram } = await channels();
    expect(telegram.getByText('Guardado')).toBeInTheDocument();
    expect(telegram.queryByLabelText('Token del bot')).not.toBeInTheDocument();
    await userEvent.click(telegram.getByRole('button', { name: 'Reemplazar token del bot' }));
    expect(screen.getByLabelText('Token del bot')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Token del bot'), 'nuevo-secreto');
    await userEvent.click(telegram.getByRole('button', { name: 'Guardar Telegram' }));
    expect(api.secrets.setKey).toHaveBeenCalledWith(
      DELIVERY_SECRET_KEYS.telegramBotToken,
      'nuevo-secreto',
    );
    expect(screen.getByLabelText('Token del bot')).toHaveValue('');
  });
  it('conserva los cambios del otro canal y bloquea los controles durante el envío', async () => {
    const { telegram } = await channels();
    await userEvent.type(screen.getByLabelText('Servidor SMTP'), 'sin-guardar.example.com');
    await fillTelegram();
    let resolve!: (result: { ok: boolean; error: null; latencyMs: number }) => void;
    vi.mocked(api.delivery.test).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await userEvent.click(telegram.getByRole('button', { name: 'Enviar prueba' }));
    expect(telegram.getByRole('button', { name: 'Enviando…' })).toBeDisabled();
    expect(screen.getByLabelText('Servidor SMTP')).toBeDisabled();
    await act(async () => resolve({ ok: true, error: null, latencyMs: 1 }));
    expect(screen.getByLabelText('Servidor SMTP')).toHaveValue('sin-guardar.example.com');
  });
  it('limpia secretos y explica fallos de escritura y de IPC sin exponer el error', async () => {
    const { telegram } = await channels();
    await fillTelegram();
    vi.mocked(api.secrets.setKey).mockRejectedValue(new Error('token-secreto'));
    await userEvent.click(telegram.getByRole('button', { name: 'Guardar Telegram' }));
    expect(await telegram.findByRole('alert')).toHaveTextContent('almacén de secretos');
    expect(screen.getByLabelText('Token del bot')).toHaveValue('');
    expect(api.delivery.setConfig).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('token-secreto');
  });
  it('ofrece reintento si falla cargar canales', async () => {
    vi.mocked(api.delivery.getConfig).mockRejectedValueOnce(new Error('IPC'));
    render(<DeliverySettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('cargar los canales');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar canales' }));
    expect(await screen.findByRole('region', { name: 'Telegram' })).toBeInTheDocument();
  });
});

describe('rutina, copias y registros', () => {
  it('valida las tres horas y guarda en la zona fija del contrato', async () => {
    const save = vi.spyOn(api.routine, 'setConfig');
    await act(async () => {
      render(<RoutineSettings />);
    });
    expect(screen.getByText('America/New_York')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Resumen previo a la apertura'), {
      target: { value: '' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Guardar horarios' }));
    expect(screen.getByRole('alert')).toHaveTextContent('tres horas');
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Resumen previo a la apertura'), {
      target: { value: '08:45' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Guardar horarios' }));
    expect(save).toHaveBeenCalledWith({ ...ROUTINE_DEFAULTS, preapertura: '08:45' });
    expect(screen.getByRole('status')).toHaveTextContent('Horarios guardados');
  });
  it('cancela restaurar sin llamar al backend y devuelve el foco', async () => {
    const restore = vi.spyOn(api.backup, 'restore');
    await act(async () => {
      render(<BackupSettings />);
    });
    const trigger = screen.getByRole('button', { name: /Restaurar copia/ });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('se reiniciará');
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Restaurar y reiniciar' })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(restore).not.toHaveBeenCalled();
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(restore).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });
  it('restaura solo con confirmación explícita y bloquea cancelar mientras reinicia', async () => {
    const restore = vi.spyOn(api.backup, 'restore').mockResolvedValue({ accepted: true });
    await act(async () => {
      render(<BackupSettings />);
    });
    await userEvent.click(screen.getByRole('button', { name: /Restaurar copia/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar y reiniciar' }));
    expect(restore).toHaveBeenCalledWith({ fileName: backup.fileName, confirm: true });
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
  it('mantiene el diálogo y permite cancelar tras un error de restauración', async () => {
    vi.spyOn(api.backup, 'restore').mockResolvedValue({ accepted: false });
    await act(async () => {
      render(<BackupSettings />);
    });
    await userEvent.click(screen.getByRole('button', { name: /Restaurar copia/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar y reiniciar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La base actual no se ha sustituido',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
  it('muestra vacío, crea una copia y conserva la lista al fallar recargar', async () => {
    vi.mocked(api.backup.list).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('IPC'));
    vi.spyOn(api.backup, 'create').mockResolvedValue(backup);
    await act(async () => {
      render(<BackupSettings />);
    });
    expect(screen.getByText(/Todavía no hay copias/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Crear copia ahora' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cargar las copias');
    expect(screen.getByText(/Copia creada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restaurar copia/ })).toBeEnabled();
    expect(screen.getByText('4,8 MB · Esquema 8')).toBeInTheDocument();
  });
  it('no permite restaurar copias que fallan la integridad', async () => {
    vi.mocked(api.backup.list).mockResolvedValue([{ ...backup, integrityOk: false }]);
    await act(async () => {
      render(<BackupSettings />);
    });
    expect(screen.getByRole('button', { name: /Restaurar copia/ })).toBeDisabled();
    expect(screen.getByText('Integridad no verificada')).toBeInTheDocument();
  });
  it('abre registros y ofrece ruta seleccionable y copia si el sistema falla', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    vi.spyOn(api.logs, 'openFolder').mockResolvedValue({ ok: false, path: '/datos/tradia/logs' });
    render(<LogSettings />);
    await user.click(screen.getByRole('button', { name: 'Abrir carpeta de registros' }));
    expect(screen.getByLabelText('Ruta de los registros')).toHaveValue('/datos/tradia/logs');
    await user.click(screen.getByRole('button', { name: 'Copiar ruta' }));
    expect(write).toHaveBeenCalledWith('/datos/tradia/logs');
    expect(screen.getByRole('status')).toHaveTextContent('Ruta copiada');
  });
  it('integra todas las secciones en Ajustes', async () => {
    await act(async () => {
      render(
        <SettingsPage
          state={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
        />,
      );
    });
    for (const name of ['Telegram', 'Correo', 'Rutina diaria', 'Copias de seguridad', 'Registros'])
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Crear copia ahora' })).toBeEnabled(),
    );
  });
});
