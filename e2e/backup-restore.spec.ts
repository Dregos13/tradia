import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { CreateStrategyRequest } from '../src/shared/strategy';

const projectRoot = resolve('.');

const marker = 'Copia fase cuatro E2E';
const strategyDraft: CreateStrategyRequest = {
  name: marker,
  hypothesis: 'Persistencia de tendencia observada en cierres consecutivos.',
  rules: {
    entry: 'Comprar tras un cierre por encima de la media.',
    exit: 'Salir cuando el cierre quede bajo la media.',
    stop: 'Stop fijo del dos por ciento.',
    target: 'Objetivo fijo del cuatro por ciento.',
  },
  parameters: {},
  markets: ['SPY'],
  regime: 'Tendencial',
  note: 'Registro persistente para probar restauración.',
};

async function launchTradia(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
  });
}

async function acceptRisk(page: Page): Promise<void> {
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
}

test('Profesional independiente: restaura en un userData limpio y conserva estrategias', async () => {
  test.setTimeout(90_000);
  const sourceData = mkdtempSync(join(tmpdir(), 'tradia-backup-source-'));
  const cleanData = mkdtempSync(join(tmpdir(), 'tradia-backup-clean-'));
  let sourceApp: ElectronApplication | null = null;
  let restoreApp: ElectronApplication | null = null;
  try {
    sourceApp = await launchTradia(sourceData);
    const sourcePage = await sourceApp.firstWindow();
    await acceptRisk(sourcePage);
    await sourcePage.evaluate((draft) => window.tradia.strategies.create(draft), strategyDraft);
    const created = await sourcePage.evaluate(() => window.tradia.backup.create());
    expect(created.integrityOk).toBe(true);
    expect(created.schemaVersion).toBeGreaterThan(0);
    await sourceApp.close();
    sourceApp = null;

    const sourcePath = join(sourceData, 'backups', created.fileName);
    mkdirSync(join(cleanData, 'backups'), { recursive: true });
    copyFileSync(sourcePath, join(cleanData, 'backups', created.fileName));

    restoreApp = await launchTradia(cleanData);
    const restorePage = await restoreApp.firstWindow();
    await acceptRisk(restorePage);
    expect(
      await restorePage.evaluate(
        async (name) =>
          (await window.tradia.strategies.list()).some((strategy) => strategy.name === name),
        marker,
      ),
    ).toBe(false);

    await restorePage.getByRole('link', { name: 'Ajustes', exact: true }).click();
    await expect(restorePage.getByRole('heading', { name: 'Ajustes', exact: true })).toBeVisible();
    const backups = await restorePage.evaluate(() => window.tradia.backup.list());
    const importIndex = backups.findIndex((backup) => backup.fileName === created.fileName);
    expect(importIndex).toBeGreaterThanOrEqual(0);
    await restorePage
      .locator('.backup-list li')
      .nth(importIndex)
      .getByRole('button', { name: /Restaurar copia/ })
      .click();
    const confirmation = restorePage.getByRole('alertdialog', { name: 'Restaurar esta copia' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
    const restoreExit = new Promise<void>((resolveExit) => {
      restoreApp!.process().once('exit', () => resolveExit());
    });
    await confirmation.getByRole('button', { name: 'Restaurar y reiniciar', exact: true }).click();
    // La restauración reinicia Electron y cierra el renderer antes de que
    // Playwright pueda volver a consultar el diálogo.
    await restoreExit;

    await expect
      .poll(() => {
        const database = new Database(join(cleanData, 'tradia.db'), { readonly: true });
        try {
          return Boolean(
            database.prepare('SELECT 1 FROM strategy_versions WHERE nombre = ?').get(marker),
          );
        } finally {
          database.close();
        }
      })
      .toBe(true);
  } finally {
    if (sourceApp) await sourceApp.close();
    if (restoreApp) await restoreApp.close().catch(() => undefined);
    rmSync(sourceData, { recursive: true, force: true });
    rmSync(cleanData, { recursive: true, force: true });
  }
});
