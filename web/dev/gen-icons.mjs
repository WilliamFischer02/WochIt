#!/usr/bin/env node
// Generates web/public/icons/{icon.svg,icon-192.png,icon-512.png,icon-512-maskable.png}.
// Zero dependencies: the PNG is written by hand (zlib from Node), the mark is rasterised with
// 4×4 supersampling. The mark: a chat bubble with a play triangle fused inside.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- geometry (unit square)
const ACCENT = [0x8b, 0x5c, 0xf6];
const ACCENT2 = [0xf4, 0x72, 0xb6];
const BG = [0x0b, 0x0b, 0x10];
const WHITE = [255, 255, 255];

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function insideTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
function lerp(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

/** Colour + alpha at a unit-square point. `maskable` fills the whole square with the background. */
function sample(x, y, { maskable }) {
  // background: rounded square (radius .22) unless maskable (full bleed)
  const bgIn = maskable || insideRoundedRect(x, y, 0, 0, 1, 1, 0.22);
  if (!bgIn) return [0, 0, 0, 0];
  // bubble: body + tail, gradient accent → accent-2 along the diagonal
  const pad = maskable ? 0.1 : 0;
  const s = 1 - pad * 2;
  const u = (x - pad) / s;
  const v = (y - pad) / s;
  const body = insideRoundedRect(u, v, 0.14, 0.18, 0.86, 0.76, 0.17);
  const tail = insideTriangle(u, v, [0.26, 0.70], [0.21, 0.90], [0.44, 0.74]);
  const play = insideTriangle(u, v, [0.42, 0.33], [0.42, 0.61], [0.66, 0.47]);
  if (play) return [...WHITE, 255];
  if (body || tail) return [...lerp(ACCENT, ACCENT2, Math.min(1, Math.max(0, (u + v) / 2))), 255];
  return [...BG, 255];
}

function raster(size, opts) {
  const SS = 4;
  const px = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (i + (sx + 0.5) / SS) / size;
          const y = (j + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca] = sample(x, y, opts);
          // premultiply for correct edge blending
          r += (cr * ca) / 255;
          g += (cg * ca) / 255;
          b += (cb * ca) / 255;
          a += ca;
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      const A = a / n;
      if (A > 0) {
        px[o] = Math.round((r / n) * 255 / A);
        px[o + 1] = Math.round((g / n) * 255 / A);
        px[o + 2] = Math.round((b / n) * 255 / A);
      }
      px[o + 3] = Math.round(A);
    }
  }
  return px;
}

// ---------------------------------------------------------------- PNG encoder
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- write
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs>
  <rect width="100" height="100" rx="22" fill="#0b0b10"/>
  <path d="M31 18h38a17 17 0 0 1 17 17v24a17 17 0 0 1-17 17H44l-23 14 5-14h0a17 17 0 0 1-12-17V35a17 17 0 0 1 17-17z" fill="url(#g)"/>
  <path d="M42 33v28l24-14z" fill="#fff"/>
</svg>
`;
writeFileSync(join(out, 'icon.svg'), svg);
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-512-maskable.png', 512, true],
]) {
  writeFileSync(join(out, name), encodePng(size, raster(size, { maskable })));
  console.log('wrote', join(out, name));
}
console.log('wrote', join(out, 'icon.svg'));
