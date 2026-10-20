// Procedural app icon (no image assets): an X-wing seen head-on, S-foils in attack position, in front of
// the orange gas giant Yavin, framed by an amber targeting ring. Rendered in software with 4x4 supersampling
// and written as a 1024x1024 PNG to build/icon.png, which electron-builder turns into .icns / .ico.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 1024;
const SS = 4;

// ------------------------------------------------------------------ helpers
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function roundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// Value noise for the gas giant's bands.
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ------------------------------------------------------------------ scene
const C = { x: 512, y: 470 };
// Wing tips: an X opened ~22 degrees either side of horizontal.
const WING = 22 * (Math.PI / 180);
const TIP = 390;
const wings = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
].map(([sx, sy]) => ({ x: C.x + sx * Math.cos(WING) * TIP, y: C.y + sy * Math.sin(WING) * TIP, sx, sy }));
const PLANET = { x: 900, y: 1010, r: 560 };
const LIGHT = [-0.6, -0.75];

// Deterministic star field, bucketed into a 16x16 grid of 64 px cells (stars never straddle a cell).
const stars = Array.from({ length: 256 }, () => []);
let seed = 1977;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let i = 0; i < 160; i++) {
  const x = rnd() * N;
  const y = rnd() * N;
  const r = 0.8 + rnd() * 2.2;
  const b = 0.4 + rnd() * 0.6;
  const cx = Math.floor(x / 64);
  const cy = Math.floor(y / 64);
  if (x - r < cx * 64 || x + r > cx * 64 + 64 || y - r < cy * 64 || y + r > cy * 64 + 64) continue;
  stars[cy * 16 + cx].push({ x, y, r, b });
}

function shade(px, py) {
  // Icon plate: rounded square with a small margin (macOS-style), transparent outside.
  const plate = roundedBox(px, py, 512, 512, 470, 470, 190);
  if (plate > 0) return null;
  // Deep space.
  const g = clamp(Math.hypot(px - 380, py - 330) / 760, 0, 1);
  let col = mix([18, 24, 48], [2, 3, 8], g);
  for (const s of stars[Math.min(15, Math.floor(py / 64)) * 16 + Math.min(15, Math.floor(px / 64))]) {
    const d = Math.hypot(px - s.x, py - s.y);
    if (d < s.r) col = mix(col, [255, 248, 230], s.b);
  }
  // Yavin: banded orange gas giant, lit from the upper left, with a thin warm atmosphere rim.
  const pd = Math.hypot(px - PLANET.x, py - PLANET.y);
  if (pd < PLANET.r + 14) {
    if (pd < PLANET.r) {
      const nx = (px - PLANET.x) / PLANET.r;
      const ny = (py - PLANET.y) / PLANET.r;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      // Zonal bands: mostly latitude, gently warped, with streaky detail along the bands.
      const lat = ny + 0.05 * noise(nx * 3, ny * 7);
      const band = 0.5 + 0.5 * Math.sin(lat * 30 + 1.5 * noise(nx * 2 + 4, ny * 12));
      let pc = mix([128, 52, 14], [232, 140, 60], band);
      pc = mix(pc, [250, 200, 130], clamp(noise(nx * 5, ny * 45) - 0.6, 0, 1) * 1.2);
      const lit = clamp(nx * LIGHT[0] + ny * LIGHT[1] + nz * 0.35, 0, 1);
      pc = pc.map((v) => v * (0.12 + 0.95 * lit));
      col = pc;
    } else {
      const t = 1 - (pd - PLANET.r) / 14;
      col = mix(col, [255, 150, 70], t * 0.55);
    }
  }
  // Targeting ring and corner ticks (HUD amber).
  const rd = Math.hypot(px - C.x, py - C.y);
  const ang = Math.atan2(py - C.y, px - C.x);
  const gap = Math.abs(Math.sin(ang * 2)) < 0.22; // breaks in the ring at the diagonals
  if (Math.abs(rd - 445) < 5 && !gap) col = mix(col, [255, 179, 71], 0.9);
  // X-wing, head-on.
  for (const w of wings) {
    const wd = segDist(px, py, C.x, C.y, w.x, w.y);
    const along = Math.hypot(px - C.x, py - C.y) / TIP;
    if (wd < 24) {
      col = [214, 212, 202];
      // Red Squadron stripe near the tip.
      if (along > 0.62 && along < 0.78) col = [176, 40, 42];
      // Panel shading: lit from the top.
      col = col.map((v) => v * (w.sy < 0 ? 1 : 0.78));
    }
    // Laser cannon at the tip, seen end-on.
    const td = Math.hypot(px - w.x, py - w.y);
    if (td < 30) col = td < 14 ? [40, 40, 44] : [236, 234, 226];
    // Engine intake near the root, with a hot glow inside.
    const ex = C.x + w.sx * Math.cos(WING) * 150;
    const ey = C.y + w.sy * Math.sin(WING) * 150 + w.sy * 26;
    const ed = Math.hypot(px - ex, py - ey);
    if (ed < 44) col = ed < 30 ? mix([255, 120, 60], [255, 230, 190], clamp(1 - ed / 30, 0, 1)) : [120, 120, 124];
  }
  // Fuselage nose, seen head-on.
  const fd = Math.hypot(px - C.x, py - C.y);
  if (fd < 66) col = fd < 50 ? mix([200, 198, 190], [120, 118, 112], clamp((py - C.y + 50) / 100, 0, 1)) : [90, 90, 96];
  return col;
}

// ------------------------------------------------------------------ render
const rgba = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        a++;
      }
    }
    const i = (y * N + x) * 4;
    const k = a || 1;
    rgba[i] = clamp(Math.round(r / k), 0, 255);
    rgba[i + 1] = clamp(Math.round(g / k), 0, 255);
    rgba[i + 2] = clamp(Math.round(b / k), 0, 255);
    rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

// ------------------------------------------------------------------ PNG encode
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log('build/icon.png written');
