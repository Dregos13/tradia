import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const appSource = 'build/icon.svg';
const master = readFileSync(appSource, 'utf8');

function variant(id: string): string {
  const svg = master.match(new RegExp(`<svg id="${id}"[\\s\\S]*?</svg>`))?.[0];
  expect(svg, `El maestro debe incluir ${id}`).toBeDefined();
  return svg!.replace(` id="${id}"`, '') + '\n';
}

function rasterSource(source: string, size: number): string {
  return source === appSource && size <= 32 ? variant('app-small') : readFileSync(source, 'utf8');
}

function checkPng(bytes: Buffer, size: number, source: string, template = false): Buffer {
  expect(bytes.subarray(0, 8)).toEqual(signature);
  const compressed: Buffer[] = [];
  let sourceHash = '';
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    expect(offset + length + 12).toBeLessThanOrEqual(bytes.length);
    if (type === 'IHDR') {
      expect(data.readUInt32BE(0)).toBe(size);
      expect(data.readUInt32BE(4)).toBe(size);
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === 'tEXt') sourceHash = data.toString();
    if (type === 'IDAT') compressed.push(data);
    if (type === 'IEND') expect(length).toBe(0);
    offset += length + 12;
  }
  expect(offset).toBe(bytes.length);
  // A stale raster from an older SVG fails even when dimensions and transparency still match.
  expect(sourceHash).toBe(
    `Source-SHA256\0${createHash('sha256').update(master).update('\0').update(rasterSource(source, size)).digest('hex')}`,
  );
  const rows = inflateSync(Buffer.concat(compressed));
  const stride = size * 4 + 1;
  expect(rows.length).toBe(size * stride);
  let visible = 0;
  const alpha = Buffer.alloc(size * size);
  for (let y = 0; y < size; y++) {
    // The generator deliberately uses filter 0; no platform PNG decoder needed in npm test.
    expect(rows[y * stride]).toBe(0);
    for (let x = 0; x < size; x++) {
      const pixel = y * stride + 1 + x * 4;
      alpha[y * size + x] = rows[pixel + 3]!;
      if (rows[pixel + 3]) {
        visible++;
        if (template) expect([...rows.subarray(pixel, pixel + 3)]).toEqual([0, 0, 0]);
      }
    }
  }
  expect(visible).toBeGreaterThan(size);
  for (const [x, y] of [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1],
  ]) {
    expect(rows[y! * stride + 1 + x! * 4 + 3]).toBe(0);
  }
  return alpha;
}

describe('Iconos instalables de Tradia', () => {
  it('las variantes ópticas y de bandeja pertenecen al único maestro', () => {
    expect(variant('app-small')).toContain('viewBox="0 0 32 32"');
    for (const state of ['online', 'offline', 'paused', 'stopped']) {
      for (const suffix of ['', '-Template']) {
        const id = `tray-${state}${suffix}`;
        expect(readFileSync(`resources/tray/${id}.svg`, 'utf8')).toBe(variant(id));
      }
    }
  });
  it.each([
    ['build/icon.png', 1024],
    ['resources/icon.png', 512],
  ] as const)('%s tiene tamaño correcto, fuente actual y esquinas transparentes', (path, size) =>
    checkPng(readFileSync(path), size, appSource),
  );

  it('ICO contiene las siete escalas con PNG RGBA transparentes y offsets válidos', () => {
    const bytes = readFileSync('build/icon.ico');
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBe(7);
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    let end = 6 + sizes.length * 16;
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      expect(bytes[entry] || 256).toBe(size);
      expect(bytes[entry + 1] || 256).toBe(size);
      expect(bytes.readUInt16LE(entry + 4)).toBe(1);
      expect(bytes.readUInt16LE(entry + 6)).toBe(32);
      const length = bytes.readUInt32LE(entry + 8);
      expect(bytes.readUInt32LE(entry + 12)).toBe(end);
      checkPng(bytes.subarray(end, end + length), size, appSource);
      end += length;
    });
    expect(end).toBe(bytes.length);
  });

  it('ICNS contiene las escalas 16–1024 y las representaciones Retina', () => {
    const bytes = readFileSync('build/icon.icns');
    expect(bytes.toString('ascii', 0, 4)).toBe('icns');
    expect(bytes.readUInt32BE(4)).toBe(bytes.length);
    const entries: Record<string, number> = {
      icp4: 16,
      icp5: 32,
      icp6: 64,
      ic07: 128,
      ic08: 256,
      ic09: 512,
      ic10: 1024,
      ic11: 32,
      ic12: 64,
      ic13: 256,
      ic14: 512,
    };
    const found: string[] = [];
    let offset = 8;
    while (offset < bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4);
      const length = bytes.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThan(8);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      expect(entries).toHaveProperty(type);
      checkPng(bytes.subarray(offset + 8, offset + length), entries[type]!, appSource);
      found.push(type);
      offset += length;
    }
    expect(offset).toBe(bytes.length);
    expect(found.sort()).toEqual(Object.keys(entries).sort());
  });

  for (const variant of ['', '-Template']) {
    for (const [suffix, size] of [
      ['', 16],
      ['@2x', 32],
    ] as const) {
      it(`bandeja ${variant || 'color'} ${size}px mantiene rutas, transparencia y cuatro estados distintos`, () => {
        const hashes = new Set<string>();
        for (const state of ['online', 'offline', 'paused', 'stopped']) {
          const base = `resources/tray/tray-${state}${variant}`;
          const bytes = readFileSync(`${base}${suffix}.png`);
          const alpha = checkPng(bytes, size, `${base}.svg`, variant === '-Template');
          // Silhouettes must distinguish states independently of RGB and PNG metadata.
          hashes.add(createHash('sha256').update(alpha).digest('hex'));
          const counterpart = `resources/tray/tray-${state}${variant ? '' : '-Template'}`;
          expect(alpha).toEqual(
            checkPng(
              readFileSync(`${counterpart}${suffix}.png`),
              size,
              `${counterpart}.svg`,
              !variant,
            ),
          );
        }
        expect(hashes.size).toBe(4);
      });
    }
  }
});
