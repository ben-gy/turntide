#!/usr/bin/env node
/**
 * gen-icons.mjs — generate the PWA / home-screen icon set from the same visual
 * identity as public/favicon.svg. No dependencies: sharp and canvas are native
 * modules that break CI on a whim, so this plots pixels into an RGBA buffer and
 * emits the PNG itself (zlib ships with Node; the rest is IHDR/IDAT/IEND plus a
 * CRC32).
 *
 *   node scripts/gen-icons.mjs
 *
 * Deterministic: same bytes on every run and every machine, so a regenerated
 * icon is a no-op in git unless the artwork actually changed.
 *
 * Outputs (public/icons/):
 *   icon-192.png           any-purpose, transparent outside the rounded square
 *   icon-512.png           ditto
 *   icon-512-maskable.png  content inside the centre-80% safe zone; Android
 *                          crops maskable icons to a circle/squircle of its
 *                          choosing, so anything near the edge is lost.
 *   apple-touch-icon.png   180x180, FULLY OPAQUE — iOS composites a transparent
 *                          icon onto black, which haloes the rounded corners.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ── palette (must match public/favicon.svg) ─────────────────────────────────
const BG = [0x0e, 0x17, 0x20]; // deep tidal ground
const TEAL = [0x2e, 0xc4, 0xb6]; // the face it is turning FROM
const AMBER = [0xff, 0x9f, 0x1c]; // the face it is turning TO

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode a raw RGBA buffer (size*size*4) as a PNG. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Filter byte 0 (None) in front of every scanline — simple and lossless.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing ─────────────────────────────────────────────────────────────────
// Artwork is authored in a 64x64 co-ordinate space (same as the favicon) and
// sampled per pixel. Edges are antialiased from a signed distance, which keeps
// the output deterministic without supersampling.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Signed distance to a rounded rect. Negative inside. */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a circle. Negative inside. */
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/**
 * Approximate signed distance to an axis-aligned ellipse. Scaling the exact
 * circle distance by the smaller radius is close enough for a 3-unit rim and
 * costs none of the iteration an exact solve would.
 */
function sdEllipse(px, py, cx, cy, rx, ry) {
  const k = Math.hypot((px - cx) / rx, (py - cy) / ry);
  return (k - 1) * Math.min(rx, ry);
}

function makeCanvas(size) {
  const buf = Buffer.alloc(size * size * 4); // transparent
  return {
    size,
    buf,
    /** Source-over composite of one colour at one pixel. */
    blend(i, [r, g, b], a) {
      if (a <= 0) return;
      const dr = buf[i];
      const dg = buf[i + 1];
      const db = buf[i + 2];
      const da = buf[i + 3] / 255;
      const outA = a + da * (1 - a);
      if (outA <= 0) return;
      buf[i] = Math.round((r * a + dr * da * (1 - a)) / outA);
      buf[i + 1] = Math.round((g * a + dg * da * (1 - a)) / outA);
      buf[i + 2] = Math.round((b * a + db * da * (1 - a)) / outA);
      buf[i + 3] = Math.round(outA * 255);
    },
  };
}

/**
 * Render one icon.
 *
 * @param {number} size
 * @param {{ maskable?: boolean, opaque?: boolean }} opts
 *  - maskable: shrink the artwork into the centre-80% safe zone and bleed the
 *    background to every edge, so Android's crop can never clip the stone.
 *  - opaque: fill the corners with the background instead of leaving them clear.
 */
function render(size, opts = {}) {
  const { maskable = false, opaque = false } = opts;
  const canvas = makeCanvas(size);
  const { buf } = canvas;

  // Content scale within the tile. 0.72 keeps every drawn shape well inside the
  // centre-80% circle that maskable icons are guaranteed to keep.
  const scale = maskable ? 0.72 : 1;
  // Pixel -> 64-space. AA width is expressed in the same space.
  const toArt = (p) => (((p + 0.5) / size - 0.5) * 64) / scale + 32;
  const pxPerUnit = (size * scale) / 64;
  const cover = (d) => clamp01(0.5 - d * pxPerUnit);

  // A full-bleed background is what makes the maskable crop and the opaque
  // apple icon safe; otherwise the rounded square carries its own transparency.
  const bleed = maskable || opaque;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = toArt(x);
      const v = toArt(y);

      // The mark is ONE STONE CAUGHT MID-FLIP — the whole game in a glyph. A
      // disc split down a foreshortened seam: teal on the face it is leaving,
      // amber on the face it is turning to. Nothing is captured; it just turns.

      // 1. Board.
      if (bleed) canvas.blend(i, BG, 1);
      else canvas.blend(i, BG, cover(sdRoundRect(u, v, 0, 0, 64, 64, 14)));

      // 2. Cool tidal glow under the stone, so it sits on the ground rather
      //    than floating on it.
      const gd = Math.hypot(u - 32, v - 32) / 30;
      canvas.blend(i, TEAL, 0.16 * clamp01(1 - gd));

      // 3. The disc, split by the vertical mid-line. The half-plane is
      //    antialiased with the same `cover` so the seam is not a jagged step.
      const disc = cover(sdCircle(u, v, 32, 32, 22));
      const left = cover(u - 32);
      canvas.blend(i, TEAL, disc * left);
      canvas.blend(i, AMBER, disc * (1 - left));

      // 4. The rim of the turning face, read edge-on. This is what makes the
      //    disc look like it is rotating rather than merely bicoloured.
      const rim = cover(Math.abs(sdEllipse(u, v, 32, 32, 6, 22)) - 1.5);
      canvas.blend(i, BG, disc * rim);

      // iOS composites any transparency onto black; leave no alpha at all.
      if (opaque) buf[i + 3] = 255;
    }
  }

  return encodePng(buf, size);
}

// ── emit ────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-512-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { opaque: true }],
];

for (const [name, size, opts] of targets) {
  const png = render(size, opts);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}
