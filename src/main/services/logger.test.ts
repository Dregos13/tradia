import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMainLogger, redactLogText, type MainLogger } from './logger';

const dirs: string[] = [];
const loggers: MainLogger[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tradia-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  loggers.length = 0;
});

describe('registro rotado del proceso principal', () => {
  it('escribe líneas con fecha ISO y nivel en tradia.log', () => {
    const dir = tempDir();
    const logger = createMainLogger({ dir });
    loggers.push(logger);

    logger.info('[prueba] arranque correcto');
    logger.error('[prueba] fallo %s', 'inesperado');

    const content = readFileSync(join(dir, 'tradia.log'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[prueba\] arranque correcto$/,
    );
    expect(lines[1]).toContain('[ERROR] [prueba] fallo inesperado');
  });

  it('rota por tamaño y conserva como máximo maxFiles archivos', () => {
    const dir = tempDir();
    const logger = createMainLogger({ dir, maxFileBytes: 256, maxFiles: 3 });
    loggers.push(logger);

    // Cada línea supera holgadamente el umbral acumulado de 256 bytes.
    for (let i = 0; i < 12; i++) {
      logger.info(`[rotacion] línea ${i} ${'x'.repeat(200)}`);
    }

    const files = readdirSync(dir).sort();
    // El actual + 2 rotados = 3 archivos como máximo.
    expect(files).toEqual(['tradia.1.log', 'tradia.2.log', 'tradia.log']);
    // Las líneas más antiguas ya no están: solo sobreviven las últimas.
    const all = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(all).toContain('línea 11');
    expect(all).not.toContain('línea 0 ');
    expect(statSync(join(dir, 'tradia.log')).size).toBeLessThanOrEqual(256 + 300);
  });

  it('mantiene líneas anteriores tras reabrir (continúa el archivo actual)', () => {
    const dir = tempDir();
    const first = createMainLogger({ dir });
    first.info('primera sesión');
    const second = createMainLogger({ dir });
    second.info('segunda sesión');
    loggers.push(first, second);

    const content = readFileSync(join(dir, 'tradia.log'), 'utf8');
    expect(content).toContain('primera sesión');
    expect(content).toContain('segunda sesión');
  });

  it('captura console.*: escribe en el archivo y conserva la salida original', () => {
    const dir = tempDir();
    const logger = createMainLogger({ dir });
    loggers.push(logger);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const restore = logger.installConsoleCapture();
    try {
      console.error('[captura] error de prueba');
      expect(errorSpy).toHaveBeenCalledWith('[captura] error de prueba');
      const content = readFileSync(join(dir, 'tradia.log'), 'utf8');
      expect(content).toContain('[ERROR] [captura] error de prueba');
    } finally {
      restore();
      errorSpy.mockRestore();
    }
    // Tras restaurar, console ya no escribe en el archivo.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    console.warn('[captura] aviso posterior');
    spy.mockRestore();
    expect(readFileSync(join(dir, 'tradia.log'), 'utf8')).not.toContain('aviso posterior');
  });
});

describe('ocultación de secretos en el registro', () => {
  it('oculta parámetros sensibles de consulta y pares JSON', () => {
    const line = redactLogText(
      'GET https://api.example.com/v1?token=abc123XYZ&api_key=K-999&q=aapl ' +
        '{"password":"s3cr3t","note":"nada"}',
    );
    expect(line).toContain('token=***');
    expect(line).toContain('api_key=***');
    expect(line).toContain('"password":"***"');
    expect(line).toContain('"note":"nada"');
    expect(line).not.toContain('abc123XYZ');
    expect(line).not.toContain('K-999');
    expect(line).not.toContain('s3cr3t');
  });

  it('oculta cabeceras Bearer y tokens de bot de Telegram', () => {
    const line = redactLogText(
      'Authorization: Bearer sk-live-123456789 y https://api.telegram.org/bot123456789:AAFfTelegramToken_x/sendMessage',
    );
    expect(line).toContain('Bearer ***');
    expect(line).not.toContain('sk-live-123456789');
    expect(line).not.toContain('AAFfTelegramToken_x');
    expect(line).toContain('bot***');
  });

  it('oculta valores secretos exactos aportados por el almacén', () => {
    const secrets = ['mi-clave-super-secreta-001', 'x'];
    const line = redactLogText('fallo con clave mi-clave-super-secreta-001 y valor x', secrets);
    expect(line).toContain('fallo con clave ***');
    expect(line).not.toContain('mi-clave-super-secreta-001');
    // Los valores demasiado cortos no se censuran (evita borrar texto común).
    expect(line).toContain('valor x');
  });

  it('los mensajes registrados pasan por la ocultación', () => {
    const dir = tempDir();
    const logger = createMainLogger({ dir, secrets: () => ['TOKEN-EXACTO-777'] });
    loggers.push(logger);
    logger.warn('proveedor rechazó token=TOKEN-EXACTO-777');
    const content = readFileSync(join(dir, 'tradia.log'), 'utf8');
    expect(content).toContain('token=***');
    expect(content).not.toContain('TOKEN-EXACTO-777');
  });

  it('no rompe con argumentos no textuales', () => {
    const dir = tempDir();
    const logger = createMainLogger({ dir });
    loggers.push(logger);
    expect(() => logger.info('objeto %o', { a: 1 }, 42, undefined)).not.toThrow();
    const content = readFileSync(join(dir, 'tradia.log'), 'utf8');
    expect(content).toContain('{ a: 1 }');
    expect(existsSync(logger.filePath)).toBe(true);
  });
});
