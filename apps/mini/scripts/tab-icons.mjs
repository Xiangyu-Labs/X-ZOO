#!/usr/bin/env node
/**
 * The bundled tab-bar icons (docs/mini/design.md §3.1): four glyphs, each as a normal and a
 * selected 81 × 81 PNG in `src/assets/tab-bar/`, which `src/platform/tab-pages.ts` names as
 * `iconPath` / `selectedIconPath`. WeChat takes PNG/JPG only, ≤ 40 KB each, no network paths;
 * a shop that uploads its own icons replaces these at runtime (`platform/tab-bar.ts`).
 *
 *   node scripts/tab-icons.mjs          write the eight PNGs
 *   node scripts/tab-icons.mjs --check  fail if a committed PNG differs from what this draws
 *
 * Plain node, no image library: each glyph is a few outline strokes on a 24-unit grid (the
 * same pen as a 24 × 24 SVG icon with `stroke-width="1.7"`, round caps and joins), drawn by
 * distance to the stroke with analytic anti-aliasing, and encoded with node:zlib. The selected
 * icon is the same outline in the selected colour with a light fill of its closed shapes, so
 * the state does not rest on colour alone.
 *
 * Colours: unselected `#666666` (design.md §3.1, `DEFAULT_TAB_BAR.color`); selected is the
 * default theme's `primaryText` (`deriveTheme`, the same value the tab label gets).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DEFAULT_PRIMARY, deriveTheme } from '@shop/contracts/system/theme';

const appRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(appRoot, 'src/assets/tab-bar');

const SIZE = 81;
const MAX_BYTES = 40 * 1024;
/** 24 grid units → 72 px, centred: the glyphs span units 2–22, about 60 px. */
const SCALE = 3;
const OFFSET = (SIZE - 24 * SCALE) / 2;
const STROKE = 1.7;
const SELECTED_FILL_ALPHA = 0.16;

const NORMAL = '#666666';
const SELECTED = deriveTheme({ primary: DEFAULT_PRIMARY }).primaryText;

// ---------------------------------------------------------------------------
// Shapes: strokes (distance to the outline) and fills (signed distance, negative inside).

const hypot = Math.hypot;

function segment(ax, ay, bx, by) {
  return (x, y) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return hypot(x - ax - t * dx, y - ay - t * dy);
  };
}

function polyline(points, closed = false) {
  const parts = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    parts.push(segment(ax, ay, bx, by));
  }
  return (x, y) => Math.min(...parts.map((part) => part(x, y)));
}

function circle(cx, cy, r) {
  return (x, y) => Math.abs(hypot(x - cx, y - cy) - r);
}

/** The upper half of a circle (screen y points down). */
function upperArc(cx, cy, r) {
  return (x, y) =>
    y <= cy
      ? Math.abs(hypot(x - cx, y - cy) - r)
      : Math.min(hypot(x - cx + r, y - cy), hypot(x - cx - r, y - cy));
}

function roundRectSigned(x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  return (x, y) => {
    const qx = Math.abs(x - cx) - hx;
    const qy = Math.abs(y - cy) - hy;
    return hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}

function roundRect(x0, y0, x1, y1, r) {
  const signed = roundRectSigned(x0, y0, x1, y1, r);
  return (x, y) => Math.abs(signed(x, y));
}

function discSigned(cx, cy, r) {
  return (x, y) => hypot(x - cx, y - cy) - r;
}

function polygonSigned(points) {
  const edge = polyline(points, true);
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? -edge(x, y) : edge(x, y);
  };
}

function halfDiscSigned(cx, cy, r) {
  const disc = discSigned(cx, cy, r);
  return (x, y) => Math.max(disc(x, y), y - cy);
}

// ---------------------------------------------------------------------------
// The glyphs, on a 24-unit grid.

const HOUSE = [
  [5.4, 9.2],
  [12, 3.9],
  [18.6, 9.2],
  [18.6, 20.4],
  [5.4, 20.4],
];
const BASKET = [
  [5.2, 7.4],
  [20.6, 7.4],
  [18.2, 15.4],
  [7.2, 15.4],
];

const GLYPHS = {
  home: {
    strokes: [
      polyline([
        [2.8, 11],
        [12, 3.6],
        [21.2, 11],
      ]),
      polyline([
        [5.4, 9.3],
        [5.4, 20.4],
        [18.6, 20.4],
        [18.6, 9.3],
      ]),
      polyline([
        [9.9, 20.4],
        [9.9, 14.6],
        [14.1, 14.6],
        [14.1, 20.4],
      ]),
    ],
    fills: [polygonSigned(HOUSE)],
  },
  category: {
    strokes: [
      roundRect(3.5, 3.5, 10.5, 10.5, 1.8),
      roundRect(13.5, 3.5, 20.5, 10.5, 1.8),
      roundRect(3.5, 13.5, 10.5, 20.5, 1.8),
      circle(17, 17, 3.6),
    ],
    fills: [
      roundRectSigned(3.5, 3.5, 10.5, 10.5, 1.8),
      roundRectSigned(13.5, 3.5, 20.5, 10.5, 1.8),
      roundRectSigned(3.5, 13.5, 10.5, 20.5, 1.8),
      discSigned(17, 17, 3.6),
    ],
  },
  cart: {
    strokes: [
      polyline([
        [2.2, 3.8],
        [4.5, 3.8],
        [7.2, 15.4],
        [18.2, 15.4],
        [20.6, 7.4],
        [5.2, 7.4],
      ]),
      circle(8.8, 19.4, 1.5),
      circle(16.8, 19.4, 1.5),
    ],
    fills: [polygonSigned(BASKET), discSigned(8.8, 19.4, 1.5), discSigned(16.8, 19.4, 1.5)],
  },
  me: {
    strokes: [circle(12, 7.6, 3.7), upperArc(12, 21, 7.4), segment(4.6, 21, 19.4, 21)],
    fills: [discSigned(12, 7.6, 3.7), halfDiscSigned(12, 21, 7.4)],
  },
};

// ---------------------------------------------------------------------------
// Drawing and PNG encoding.

function rgb(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`tab-icons: not a #rrggbb colour: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Coverage of a shape at a pixel from its distance in px: a 1 px anti-aliased edge. */
const coverage = (distancePx) => Math.max(0, Math.min(1, 0.5 - distancePx));

function draw(glyph, colour, selected) {
  const [r, g, b] = rgb(colour);
  // One filter-type byte per row, then RGBA.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let py = 0; py < SIZE; py++) {
    const row = py * (1 + SIZE * 4);
    raw[row] = 0;
    for (let px = 0; px < SIZE; px++) {
      const x = (px + 0.5 - OFFSET) / SCALE;
      const y = (py + 0.5 - OFFSET) / SCALE;
      const line = Math.min(...glyph.strokes.map((shape) => shape(x, y)));
      const stroke = coverage((line - STROKE / 2) * SCALE);
      let fill = 0;
      if (selected) {
        const inside = Math.min(...glyph.fills.map((shape) => shape(x, y)));
        fill = coverage(inside * SCALE) * SELECTED_FILL_ALPHA;
      }
      const alpha = stroke + fill * (1 - stroke);
      const at = row + 1 + px * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = Math.round(alpha * 255);
    }
  }
  return png(raw);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering (every row: none)
  header[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const check = process.argv.includes('--check');
const failures = [];
fs.mkdirSync(outDir, { recursive: true });

for (const [name, glyph] of Object.entries(GLYPHS)) {
  for (const [suffix, colour, selected] of [
    ['', NORMAL, false],
    ['-active', SELECTED, true],
  ]) {
    const file = path.join(outDir, `${name}${suffix}.png`);
    const bytes = draw(glyph, colour, selected);
    if (bytes.length > MAX_BYTES)
      failures.push(`${name}${suffix}.png is ${bytes.length} B (> 40 KB)`);
    const relative = path.relative(appRoot, file);
    if (check) {
      const committed = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (!committed || !committed.equals(bytes))
        failures.push(`${relative} is not what this script draws`);
    } else {
      fs.writeFileSync(file, bytes);
      console.log(`${relative}  ${SIZE}×${SIZE}  ${bytes.length} B  ${colour}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`tab-icons: ${failure}`);
  process.exit(1);
}
if (check) console.log('tab-icons: ok');
