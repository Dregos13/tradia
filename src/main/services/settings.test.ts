import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db/database';
import { createSettingsService, DEFAULT_NOTIFICATION_PREFS } from './settings';

const dirs: string[] = [];
const dbs: Database.Database[] = [];

function fileDb(): { db: Database.Database; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tradia-settings-'));
  dirs.push(dir);
  const file = join(dir, 'tradia.db');
  const db = openDatabase(file);
  dbs.push(db);
  return { db, file };
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('servicio de ajustes', () => {
  it('devuelve los valores por defecto en una instalación limpia', () => {
    const settings = createSettingsService(fileDb().db);

    expect(settings.get()).toEqual({ autostart: false, disclaimerAcceptedVersion: null });
    expect(settings.getNotificationPrefs()).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('persiste los cambios entre instancias sobre la misma base de datos', () => {
    const { db } = fileDb();
    const settings = createSettingsService(db);

    const updated = settings.set({ autostart: true, disclaimerAcceptedVersion: '2026-10' });
    expect(updated).toEqual({ autostart: true, disclaimerAcceptedVersion: '2026-10' });

    // Una nueva instancia lee lo persistido, no memoria.
    const reloaded = createSettingsService(db);
    expect(reloaded.get().autostart).toBe(true);
    expect(reloaded.get().disclaimerAcceptedVersion).toBe('2026-10');
  });

  it('persiste las preferencias de notificación por nivel', () => {
    const { db } = fileDb();
    const settings = createSettingsService(db);

    settings.setNotificationPrefs({ info: false, alerta: true, critica: true });
    expect(createSettingsService(db).getNotificationPrefs()).toEqual({
      info: false,
      alerta: true,
      critica: true,
    });
  });

  it('restablece el aviso aceptado cuando el patch llega con null', () => {
    const settings = createSettingsService(fileDb().db);
    settings.set({ disclaimerAcceptedVersion: '2026-10' });
    const reset = settings.set({ disclaimerAcceptedVersion: null as unknown as string });
    expect(reset.disclaimerAcceptedVersion).toBeNull();
  });

  it('degrada a memoria cuando el almacén no está disponible', () => {
    const settings = createSettingsService(null);
    expect(settings.get()).toEqual({ autostart: false, disclaimerAcceptedVersion: null });
    expect(settings.set({ autostart: true }).autostart).toBe(true);
    expect(settings.get().autostart).toBe(true);
  });

  it('expone el almacén clave-valor interno para otros servicios', () => {
    const settings = createSettingsService(fileDb().db);
    settings.setValue('clave.interna', 'valor');
    expect(settings.getValue('clave.interna')).toBe('valor');
    expect(settings.getValue('inexistente')).toBeNull();
  });
});
