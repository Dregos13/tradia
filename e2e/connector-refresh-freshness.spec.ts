import { expect, test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage } from './phase-6-7.helpers';

for (const provider of ['tiingo', 'fred'] as const) {
  test(`${provider}: una descarga correcta no anuncia éxito total con EUR sin datos`, async () => {
    const context = await launchPhaseApp('tradia-connector-refresh-');
    try {
      const { app, page } = context;
      // Contrato renderer por IPC real: la descarga funciona, pero la lista
      // conserva un activo heredado sin cobertura.
      await app.evaluate(({ ipcMain }, provider) => {
        const channel = provider === 'tiingo' ? 'market:refresh-now' : 'macro:refresh-now';
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => ({ accepted: true, ok: true, reason: null }));
        ipcMain.removeHandler('data-status:freshness');
        ipcMain.handle('data-status:freshness', () => ({
          state: 'current',
          sinceDate: null,
          expectedSessionDate: '2026-10-09',
          missingSessions: 0,
          items: [],
          uncovered: [{ ticker: 'EUR', reason: 'Sin datos', suggestion: 'FXE' }],
          updatedAt: new Date().toISOString(),
        }));
      }, provider);
      await page.evaluate(
        (provider) => window.tradia.testing!.providers.simulateTest({ provider, status: 'ok' }),
        provider,
      );
      await openPage(page, 'Ajustes');
      const form = page.getByRole('form', {
        name: `Proveedor ${provider === 'tiingo' ? 'Tiingo' : 'FRED'}`,
      });
      await form.getByRole('button', { name: 'Probar conexión' }).click();
      const refresh = form.getByRole('button', { name: 'Actualizar datos ahora' });
      await expect(refresh).toBeEnabled();
      await refresh.focus();
      await page.keyboard.press('Enter');
      await expect(form.getByText('Actualización parcial · sin datos: EUR')).toBeVisible();
      await expect(page.getByText('Datos actualizados.', { exact: true })).toHaveCount(0);
      await expect(refresh).toBeFocused();
    } finally {
      await closePhaseApp(context);
    }
  });
}
