import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { _electron as electron, type Page } from 'playwright';

const projectRoot = resolve('.');

function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && input[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else if (char !== '\n') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function acceptRisk(page: Page): Promise<void> {
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
}

test('Responsable de equipo: consulta el motivo y exporta el diario a un CSV válido', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-journal-e2e-'));
  const exportPath = join(userData, 'diario-fase-4.csv');
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await acceptRisk(page);
    const decision = await page.evaluate(() =>
      window.tradia.risk.submitSignal({
        ticker: 'AAPL',
        direction: 'largo',
        entry: 100,
        stop: 95,
        target: 105,
        confidence: 0.7,
        origin: 'e2e',
      }),
    );
    expect(decision.status).toBe('vetada');

    await page.getByRole('link', { name: 'Diario', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Diario', level: 2 })).toBeVisible();
    const entryRow = page.getByRole('row').filter({ hasText: 'AAPL' }).first();
    await expect(entryRow).toContainText('Vetada');
    await entryRow.getByRole('button', { name: /Ver detalle/ }).click();
    const detail = page.getByRole('dialog', { name: /Detalle del diario/ });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('AAPL');
    await expect(detail).toContainText(/motivo|beneficio\/riesgo/i);
    await page.keyboard.press('Escape');

    await page.getByLabel('Activo', { exact: true }).fill('AAPL');
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, 'showSaveDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePath: path }),
      });
    }, exportPath);
    const filtered = await page.evaluate(() => window.tradia.journal.list({ ticker: 'AAPL' }));
    expect(filtered.total).toBeGreaterThan(0);
    await page.getByRole('button', { name: /Exportar CSV/ }).click();
    await expect(page.getByRole('status').filter({ hasText: exportPath })).toBeVisible();
    const csv = readFileSync(exportPath, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([
      'id',
      'fecha',
      'tipo',
      'activo',
      'estrategias',
      'resultado',
      'motivo',
      'datos_usados',
      'errores',
      'reglas',
      'senal_id',
    ]);
    expect(rows).toHaveLength(filtered.total + 1);
    const vetoRow = rows.slice(1).find((row) => row[2] === 'veto' && row[3] === 'AAPL');
    expect(vetoRow).toBeDefined();
    expect(vetoRow?.[5]).toBe('vetada');
    expect(vetoRow?.[6]).toMatch(/Beneficio\/riesgo|objetivo/i);
    expect(JSON.parse(vetoRow?.[9] ?? '[]')).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'RR_TOO_LOW', cumplida: false })]),
    );
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
