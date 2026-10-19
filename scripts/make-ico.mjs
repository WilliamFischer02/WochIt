// Build scripts/wochit.ico from the PNG icons under web/public/icons. No dependencies.
//
//   node scripts/make-ico.mjs
//
// An ICO file is a small directory followed by the images; since Vista each image may be a PNG
// instead of a BMP, so the file is just the PNGs with a 6 + 16·n byte header in front. We take
// every non-maskable PNG of 256 px or less as it is, then decode the largest one (8-bit RGB or
// RGBA, non-interlaced) and box-downsample it to the sizes Windows actually draws on the desktop,
// the taskbar and in Explorer, so the small renderings are crisp instead of being scaled by the
// shell from 192 px. If decoding is not possible the original PNGs alone still make a valid icon.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const iconsDir = join(repo, 'web', 'public', 'icons');
const outFile = join(here, 'wochit.ico');
const DERIVED_SIZES = [64, 48, 32, 24, 16];

// ------------------------------------------------------------------ PNG helpers

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function pngHeader(buf) {
  const ihdr = readChunks(buf).find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG without IHDR');
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    interlace: ihdr.data[12],
  };
}

/** Decode an 8-bit RGB (2) or RGBA (6) non-interlaced PNG to straight-alpha RGBA bytes. */
function decodeRgba(buf) {
  const h = pngHeader(buf);
  if (h.bitDepth !== 8 || (h.colorType !== 2 && h.colorType !== 6) || h.interlace !== 0) {
    return null;
  }
  const bpp = h.colorType === 6 ? 4 : 3;
  const stride = h.width * bpp;
  const idat = Buffer.concat(readChunks(buf).filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);
  if (raw.length !== (stride + 1) * h.height) throw new Error('unexpected PNG data length');

  const out = Buffer.alloc(h.width * h.height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < h.height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; // left
      const b = prev[i]; // up
      const c = i >= bpp ? prev[i - bpp] : 0; // upper-left
      let v = cur[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < h.width; x++) {
      const s = x * bpp, d = (y * h.width + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width: h.width, height: h.height, rgba: out };
}

/** Box-downsample by an integer factor, averaging premultiplied colour so edges stay clean. */
function downsample(img, size) {
  const f = img.width / size;
  if (!Number.isInteger(f) || img.width !== img.height) throw new Error(`cannot derive ${size} from ${img.width}`);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * img.width + (x * f + dx)) * 4;
          const al = img.rgba[i + 3];
          r += img.rgba[i] * al; g += img.rgba[i + 1] * al; b += img.rgba[i + 2] * al; a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (f * f));
    }
  }
  return { width: size, height: size, rgba: out };
}

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** Encode straight-alpha RGBA as an 8-bit RGBA PNG (filter 0 on every row; zlib does the rest). */
function encodePng(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    img.rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ ICO

function buildIco(entries) {
  // entries: [{ size, png }] — any order; Windows reads the directory, not the order.
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // 1 = icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((e, i) => {
    const d = 6 + 16 * i;
    dir[d] = e.size >= 256 ? 0 : e.size; // width, 0 means 256
    dir[d + 1] = e.size >= 256 ? 0 : e.size; // height
    dir[d + 2] = 0; // colour count (0 for 32-bit)
    dir[d + 3] = 0; // reserved
    dir.writeUInt16LE(1, d + 4); // colour planes
    dir.writeUInt16LE(32, d + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, d + 8);
    dir.writeUInt32LE(offset, d + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.png)]);
}

// ------------------------------------------------------------------ main

const sources = readdirSync(iconsDir)
  .filter((f) => f.toLowerCase().endsWith('.png') && !/maskable/i.test(f))
  .map((f) => ({ file: f, png: readFileSync(join(iconsDir, f)) }))
  .map((s) => ({ ...s, ...pngHeader(s.png) }))
  .filter((s) => s.width === s.height && s.width <= 256)
  .sort((a, b) => b.width - a.width);

if (sources.length === 0) {
  console.error(`No square PNG of 256 px or less in ${iconsDir}`);
  process.exit(1);
}

const entries = sources.map((s) => ({ size: s.width, png: s.png, from: s.file }));
const have = new Set(entries.map((e) => e.size));

const largest = sources[0];
const decoded = decodeRgba(largest.png);
if (decoded) {
  for (const size of DERIVED_SIZES) {
    if (have.has(size) || size >= decoded.width || decoded.width % size !== 0) continue;
    entries.push({ size, png: encodePng(downsample(decoded, size)), from: `${largest.file} ÷ ${decoded.width / size}` });
    have.add(size);
  }
} else {
  console.warn(`${largest.file} is not 8-bit RGB/RGBA non-interlaced; keeping the original PNGs only.`);
}

entries.sort((a, b) => b.size - a.size);
const ico = buildIco(entries);
writeFileSync(outFile, ico);

console.log(`Wrote ${outFile} (${ico.length} bytes, ${entries.length} images):`);
for (const e of entries) console.log(`  ${String(e.size).padStart(3)} px  ${String(e.png.length).padStart(6)} bytes  from ${e.from}`);
