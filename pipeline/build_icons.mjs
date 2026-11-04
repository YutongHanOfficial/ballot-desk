#!/usr/bin/env node
// Draws the site icon (favicon.svg) as PNG files and packs favicon.ico, for search engines and browsers that can't
// use the SVG. Google shows a site's icon beside its search results only when it can fetch the icon from a real
// address, so an icon inlined in the page as a data: URI never appears there.
//
//   favicon.ico            16, 32 and 48 px (Google wants sizes that are multiples of 48 px)
//   icon-192.png           192 px, for Android and for Google
//   apple-touch-icon.png   180 px with square corners (iOS rounds them itself, so rounded ones would leave black gaps)
//
// The shapes below are favicon.svg's, so change the two together. Run: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = [0x1f, 0x5f, 0xd1], TO = [0xd0, 0x31, 0x2d];   // the gradient, from top left to bottom right
const CHECK = [[11.6, 16.4], [14.9, 19.7], [21.1, 12.6]];   // the check mark's path
const SUPERSAMPLE = 8;                                      // 8 x 8 samples a pixel smooth the edges

/** Signed distance from (x, y) to a rounded rectangle centred on (cx, cy): negative inside. */
function roundedBox(x, y, cx, cy, half, r) {
  const qx = Math.abs(x - cx) - (half - r), qy = Math.abs(y - cy) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function toSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** The logo's colour at one point of its 32-unit square: [r, g, b] in 0..1, or null outside it. */
function colourAt(x, y, square) {
  if (roundedBox(x, y, 16, 16, 16, square ? 0 : 8) > 0) return null;
  const t = Math.min(1, Math.max(0, (x + y) / 64));
  let c = FROM.map((v, i) => (v + (TO[i] - v) * t) / 255);
  // The ballot box: a white outline (2.2 wide) at 55% opacity.
  if (Math.abs(roundedBox(x, y, 16, 16, 8, 3.5)) <= 1.1) c = c.map(v => v * 0.45 + 0.55);
  // The check mark: solid white, 2.8 wide with round ends and joins.
  if (Math.min(toSegment(x, y, CHECK[0], CHECK[1]), toSegment(x, y, CHECK[1], CHECK[2])) <= 1.4) c = [1, 1, 1];
  return c;
}

/** An n x n RGBA image of the logo, its edges antialiased. */
function draw(n, square = false) {
  const px = Buffer.alloc(n * n * 4);
  const S = SUPERSAMPLE;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, cover = 0;
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
        const c = colourAt(((x + (j + 0.5) / S) * 32) / n, ((y + (i + 0.5) / S) * 32) / n, square);
        if (!c) continue;
        r += c[0]; g += c[1]; b += c[2]; cover++;
      }
      const o = (y * n + x) * 4;
      if (cover) { px[o] = Math.round((r / cover) * 255); px[o + 1] = Math.round((g / cover) * 255); px[o + 2] = Math.round((b / cover) * 255); }
      px[o + 3] = Math.round((cover / (S * S)) * 255);
    }
  }
  return px;
}

/** PNG file for an n x n RGBA image, every row Paeth-filtered (smooth gradients compress far better). */
function png(n, px) {
  const stride = n * 4, raw = Buffer.alloc(n * (stride + 1));
  for (let y = 0; y < n; y++) {
    raw[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      raw[y * (stride + 1) + 1 + x] = (px[y * stride + x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** An .ico holding PNG images, which every current browser and crawler reads. */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ n, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = n; head[e + 1] = n;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(im => im.data)]);
}

const write = (file, data) => { fs.writeFileSync(path.join(ROOT, file), data); console.log(`${file} ${data.length} bytes`); };
write('favicon.ico', ico([16, 32, 48].map(n => ({ n, data: png(n, draw(n)) }))));
write('icon-192.png', png(192, draw(192)));
write('apple-touch-icon.png', png(180, draw(180, true)));
