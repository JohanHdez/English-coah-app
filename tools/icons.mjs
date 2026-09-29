// Minimal PNG encoder (no dependency on an image library): builds the IHDR/IDAT/IEND
// chunks by hand, deflates the raw scanlines with node:zlib, and CRCs each chunk with
// a hand-rolled table, because the project takes no dependencies for a handful of icons.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }

  const idat = deflateSync(raw);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const nearLeft = x < x0 + r;
  const nearRight = x > x1 - r;
  const nearTop = y < y0 + r;
  const nearBottom = y > y1 - r;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const ccx = nearLeft ? x0 + r : x1 - r;
    const ccy = nearTop ? y0 + r : y1 - r;
    const dx = x - ccx;
    const dy = y - ccy;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

function triSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = triSign(px, py, ax, ay, bx, by);
  const d2 = triSign(px, py, bx, by, cx, cy);
  const d3 = triSign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const BACKGROUND = [0x1a, 0x73, 0xe8, 255];
const WHITE = [255, 255, 255, 255];

// A rounded-rectangle body with a small triangular tail, sized as a fraction of the
// canvas (`scale`) and centred, so the maskable variant can shrink it to fit the
// platform's central safe zone without a second code path.
function bubbleAt(size, scale) {
  const bodyW = size * scale;
  const bodyH = bodyW * 0.66;
  const tailH = bodyW * 0.22;
  const totalH = bodyH + tailH;
  const x0 = (size - bodyW) / 2;
  const x1 = x0 + bodyW;
  const y0 = (size - totalH) / 2;
  const y1 = y0 + bodyH;
  const radius = bodyH * 0.3;
  const tailBaseW = bodyW * 0.22;
  const tailBaseX0 = x0 + bodyW * 0.18;
  const tailBaseX1 = tailBaseX0 + tailBaseW;
  const tailApexX = tailBaseX0 + tailBaseW * 0.25;
  const tailApexY = y1 + tailH;

  return (x, y) => {
    if (inRoundedRect(x, y, x0, y0, x1, y1, radius)) return true;
    return inTriangle(x, y, tailBaseX0, y1, tailBaseX1, y1, tailApexX, tailApexY);
  };
}

function renderIcon(size, scale) {
  const inBubble = bubbleAt(size, scale);
  return encodePNG(size, size, (x, y) => (inBubble(x + 0.5, y + 0.5) ? WHITE : BACKGROUND));
}

function writeIcon(path, size, scale) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderIcon(size, scale));
  console.log(`wrote ${path} (${size}x${size}, scale ${scale})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  writeIcon(resolve(root, 'icons/icon-192.png'), 192, 0.6);
  writeIcon(resolve(root, 'icons/icon-512.png'), 512, 0.6);
  // The OS may crop up to 10% on each edge of a maskable icon; 0.78 keeps the whole
  // shape, tail included, inside that central 80% safe zone with a small margin.
  writeIcon(resolve(root, 'icons/maskable-512.png'), 512, 0.78);
}
