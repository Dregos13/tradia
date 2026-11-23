/* global document, Image */
// Setup: npm install && npx playwright install chromium
// Regenerate: node scripts/generar-iconos.mjs
// Edit only build/icon.svg, including its optical/tray variants in <defs>.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
// Standard and Retina representations (16@2x, 32@2x, 128@2x, 256@2x, 512@2x).
const icnsSizes = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, trailer]);
}

// RGBA, filter 0, fixed zlib settings and no timestamps: identical pixels give identical bytes.
function png(size, rgba, sourceHash) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`Source-SHA256\0${sourceHash}`)),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const directory = Buffer.alloc(6 + icoSizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(icoSizes.length, 4);
  let offset = directory.length;
  icoSizes.forEach((size, index) => {
    const image = images.get(size);
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([directory, ...icoSizes.map((size) => images.get(size))]);
}

function icns(images) {
  const entries = icnsSizes.map(([type, size]) => {
    const image = images.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(image.length + 8, 4);
    return Buffer.concat([header, image]);
  });
  const header = Buffer.alloc(8);
  header.write('icns');
  header.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  return Buffer.concat([header, ...entries]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // One versioned master includes the approved optical corrections and tray states.
  const source = await readFile(new URL('build/icon.svg', root), 'utf8');
  function extractVariant(id) {
    const svg = source.match(new RegExp(`<svg id="${id}"[\\s\\S]*?</svg>`))?.[0];
    if (!svg) throw new Error(`Missing icon variant: ${id}`);
    return svg.replace(` id="${id}"`, '') + '\n';
  }
  const sourceMaster = source;
  async function render(source, size) {
    const pixels = await page.evaluate(
      async ({ source, size }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, size, size);
        return Array.from(ctx.getImageData(0, 0, size, size).data);
      },
      { source, size },
    );
    return png(
      size,
      Buffer.from(pixels),
      createHash('sha256').update(sourceMaster).update('\0').update(source).digest('hex'),
    );
  }
  const small = extractVariant('app-small');
  const images = new Map();
  for (const size of new Set([...icoSizes, ...icnsSizes.map(([, size]) => size)])) {
    images.set(size, await render(size <= 32 ? small : source, size));
  }
  const outputs = new Map([
    ['build/icon.png', images.get(1024)],
    ['resources/icon.png', images.get(512)],
    ['build/icon.ico', ico(images)],
    ['build/icon.icns', icns(images)],
  ]);
  for (const state of ['online', 'offline', 'paused', 'stopped']) {
    for (const variant of ['', '-Template']) {
      const base = `resources/tray/tray-${state}${variant}`;
      const svg = extractVariant(`tray-${state}${variant}`);
      outputs.set(`${base}.svg`, svg);
      outputs.set(`${base}.png`, await render(svg, 16));
      outputs.set(`${base}@2x.png`, await render(svg, 32));
    }
  }
  for (const [path, bytes] of outputs) await writeFile(new URL(path, root), bytes);
  process.stdout.write(`Generados ${outputs.size} iconos en ${fileURLToPath(root)}\n`);
} finally {
  await browser.close();
}
