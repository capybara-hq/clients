// Generates apps/desktop/build/icons from the Capybara logo bitmap (no dependencies: a tiny PNG
// encoder on node:zlib). Run: node scripts/icons.ts
//   icon.png               1024x1024, the app and Dock fallback icon (logo on a rounded square)
//   trayTemplate.png       16x16, black on transparent: a macOS template image
//   trayTemplate@2x.png    32x32, the same at twice the size
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// 14x10 bitmap, copied from the org's logo (capybara-hq/.github scripts/logo-svg.ts, itself copied
// from core packages/design/src/display/logo.tsx). X is filled, O is the eye cut-out.
const BITMAP = [
  "..........X...",
  ".........XXX..",
  "...XXXXXXXXXXX",
  "..XXXXXXXXXOXX",
  ".XXXXXXXXXXXXX",
  ".XXXXXXXXXXXXX",
  ".XXXXXXXXXXXX.",
  "..XXXXXXXXXX..",
  "..XX..X..XX...",
  "..XX..X..XX...",
] as const;
const COLS = 14;
const ROWS = 10;

type Rgba = [number, number, number, number];

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(size: number, pixels: Uint8Array): Buffer {
  const stride = size * 4 + 1;
  const rows = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    // Filter type 0 (none), then the row.
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4).copy(
      rows,
      y * stride + 1,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Draws the logo with square cells of `cell` pixels at (left, top). */
function drawLogo(
  px: Uint8Array,
  size: number,
  cell: number,
  left: number,
  top: number,
  color: Rgba,
): void {
  BITMAP.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== "X") continue;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          px.set(color, ((top + y * cell + dy) * size + left + x * cell + dx) * 4);
        }
      }
    }
  });
}

function tray(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const cell = Math.floor(size / 16);
  const left = Math.floor((size - COLS * cell) / 2);
  const top = Math.floor((size - ROWS * cell) / 2);
  drawLogo(px, size, cell, left, top, [0, 0, 0, 255]);
  return encodePng(size, px);
}

function app(): Buffer {
  const size = 1024;
  const px = new Uint8Array(size * size * 4);
  // The macOS icon grid: an 824-point rounded square centred on the canvas.
  const inset = 100;
  const radius = 185;
  const lo = inset + radius;
  const hi = size - inset - radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(Math.max(x + 0.5, lo), hi);
      const cy = Math.min(Math.max(y + 0.5, lo), hi);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
      const coverage = Math.min(Math.max(0.5 - d, 0), 1);
      if (coverage > 0) px.set([22, 23, 21, Math.round(255 * coverage)], (y * size + x) * 4);
    }
  }
  const cell = 40;
  const left = (size - COLS * cell) / 2;
  const top = (size - ROWS * cell) / 2;
  drawLogo(px, size, cell, left, top, [255, 106, 19, 255]);
  return encodePng(size, px);
}

const out = new URL("../build/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon.png", out), app());
writeFileSync(new URL("trayTemplate.png", out), tray(16));
writeFileSync(new URL("trayTemplate@2x.png", out), tray(32));
console.log("wrote build/icons");
