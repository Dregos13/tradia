import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOSTART_HIDDEN_ARG,
  buildDesktopEntry,
  isLinuxAutostartEnabled,
  LINUX_DESKTOP_FILENAME,
  linuxAutostartDir,
  linuxAutostartFile,
  quoteDesktopExec,
  setLinuxAutostart,
} from './autostart';

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tradia-autostart-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generador del .desktop de Linux', () => {
  it('genera una entrada de escritorio válida que arranca oculta', () => {
    const content = buildDesktopEntry({ execPath: '/opt/Tradia/tradia' });

    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain('Type=Application');
    expect(content).toContain('Name=Tradia');
    expect(content).toContain(`Exec="/opt/Tradia/tradia" ${AUTOSTART_HIDDEN_ARG}`);
    expect(content).toContain('Terminal=false');
    expect(content).toContain('X-GNOME-Autostart-enabled=true');
  });

  it('escapa comillas y barras invertidas en la ruta del ejecutable', () => {
    expect(quoteDesktopExec('/opt/Mi App/tradia')).toBe('"/opt/Mi App/tradia"');
    expect(quoteDesktopExec('/opt/a"b/tradia')).toBe('"/opt/a\\"b/tradia"');
    expect(quoteDesktopExec('C:\\Apps\\tradia.exe')).toBe('"C:\\\\Apps\\\\tradia.exe"');
  });

  it('ubica el autostart en ~/.config/autostart y respeta XDG_CONFIG_HOME', () => {
    expect(linuxAutostartDir({ home: '/home/u' })).toBe('/home/u/.config/autostart');
    expect(linuxAutostartDir({ home: '/home/u', configHome: '/xdg' })).toBe('/xdg/autostart');
    expect(linuxAutostartFile({ home: '/home/u' })).toBe(
      `/home/u/.config/autostart/${LINUX_DESKTOP_FILENAME}`,
    );
  });

  it('activar escribe el .desktop y desactivar lo borra', () => {
    const home = tempHome();
    const options = { home, execPath: '/opt/Tradia/tradia' };

    expect(isLinuxAutostartEnabled(options)).toBe(false);
    expect(setLinuxAutostart(true, options)).toBe(true);

    const file = linuxAutostartFile(options);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain(`Exec="/opt/Tradia/tradia" ${AUTOSTART_HIDDEN_ARG}`);
    expect(isLinuxAutostartEnabled(options)).toBe(true);

    expect(setLinuxAutostart(false, options)).toBe(true);
    expect(isLinuxAutostartEnabled(options)).toBe(false);
    // Desactivar dos veces no falla.
    expect(setLinuxAutostart(false, options)).toBe(true);
  });

  it('crea el directorio de autostart si no existe', () => {
    const home = tempHome();
    expect(setLinuxAutostart(true, { home, execPath: '/usr/bin/tradia' })).toBe(true);
    expect(
      readFileSync(join(home, '.config', 'autostart', LINUX_DESKTOP_FILENAME), 'utf8'),
    ).toContain('[Desktop Entry]');
  });
});
