import * as THREE from 'three';

/** Small, fast deterministic PRNG (returns floats in [0, 1)). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Panel styles. All panel textures are NEUTRAL (near-white base): the hull colour comes from
 * `material.color`, so one texture set serves every tint (hull, stripes, accents).
 */
export type PanelStyle = 'fighter' | 'freighter' | 'imperial' | 'deathstar';

export interface PanelTextures {
  /** sRGB colour map (panel tones, panel lines, grime). */
  map: THREE.CanvasTexture;
  /** Linear bump map (panel line grooves, raised plates, rivets). */
  bumpMap: THREE.CanvasTexture;
}

interface StyleParams {
  seed: number;
  size: number;
  /** Smallest panel edge in px. */
  minPanel: number;
  /** Probability of stopping subdivision early (bigger panels). */
  stop: number;
  /** Panel tone variation amplitude (0..1 alpha). */
  tone: number;
  /** Panel line opacity. */
  line: number;
  /** Grime blotch opacity multiplier. */
  grime: number;
  blotches: number;
  streaks: number;
  /** Chance of a hatch/vent detail per panel. */
  hatch: number;
  /** Chance of a rivet row per panel. */
  rivet: number;
  /** Per-pixel noise amplitude (0..255). */
  noise: number;
  /** Bump height variation of plates (0..127). */
  plate: number;
}

const STYLES: Record<PanelStyle, StyleParams> = {
  fighter: { seed: 11, size: 512, minPanel: 28, stop: 0.2, tone: 0.08, line: 0.36, grime: 0.8, blotches: 70, streaks: 90, hatch: 0.18, rivet: 0.25, noise: 7, plate: 10 },
  freighter: { seed: 23, size: 512, minPanel: 20, stop: 0.14, tone: 0.16, line: 0.42, grime: 1.0, blotches: 110, streaks: 150, hatch: 0.3, rivet: 0.3, noise: 9, plate: 16 },
  imperial: { seed: 37, size: 512, minPanel: 32, stop: 0.22, tone: 0.06, line: 0.3, grime: 0.35, blotches: 30, streaks: 30, hatch: 0.15, rivet: 0.2, noise: 5, plate: 8 },
  deathstar: { seed: 53, size: 512, minPanel: 18, stop: 0.12, tone: 0.2, line: 0.4, grime: 0.6, blotches: 60, streaks: 24, hatch: 0.25, rivet: 0.1, noise: 8, plate: 22 },
};

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('textures: 2D canvas unavailable');
  return [c, ctx];
}

function configure(tex: THREE.Texture, color: boolean): void {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
}

/** Draws `fn` at (x, y) plus wrapped copies so blotches tile seamlessly. */
function drawWrapped(size: number, x: number, y: number, r: number, fn: (x: number, y: number) => void): void {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const px = x + ox;
      const py = y + oy;
      if (px + r < 0 || py + r < 0 || px - r > size || py - r > size) continue;
      fn(px, py);
    }
  }
}

function addNoise(ctx: CanvasRenderingContext2D, size: number, amp: number, rng: () => number): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amp;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

interface Rect { x: number; y: number; w: number; h: number }

function generatePanels(p: StyleParams): PanelTextures {
  const S = p.size;
  const rng = mulberry32(p.seed);
  const [cc, c] = makeCanvas(S);
  const [bc, b] = makeCanvas(S);

  c.fillStyle = '#ededeb';
  c.fillRect(0, 0, S, S);
  b.fillStyle = '#808080';
  b.fillRect(0, 0, S, S);

  // --- kd subdivision into hull plates -------------------------------------------------
  const leaves: Rect[] = [];
  const split = (x: number, y: number, w: number, h: number, d: number): void => {
    const cw = w >= p.minPanel * 2;
    const ch = h >= p.minPanel * 2;
    if ((!cw && !ch) || (d >= 2 && rng() < p.stop)) {
      leaves.push({ x, y, w, h });
      return;
    }
    const vertical = cw && (!ch || w > h * (0.7 + rng() * 0.6));
    if (vertical) {
      const s = Math.max(p.minPanel, Math.min(w - p.minPanel, Math.round(w * (0.25 + rng() * 0.5))));
      split(x, y, s, h, d + 1);
      split(x + s, y, w - s, h, d + 1);
    } else {
      const s = Math.max(p.minPanel, Math.min(h - p.minPanel, Math.round(h * (0.25 + rng() * 0.5))));
      split(x, y, w, s, d + 1);
      split(x, y + s, w, h - s, d + 1);
    }
  };
  split(0, 0, S, S, 0);

  for (const r of leaves) {
    // plate tone
    const t = (rng() - 0.5) * 2 * p.tone;
    c.fillStyle = t > 0 ? `rgba(255,255,255,${t})` : `rgba(20,18,16,${-t})`;
    c.fillRect(r.x, r.y, r.w, r.h);
    const g = Math.round(128 + (rng() - 0.5) * 2 * p.plate);
    b.fillStyle = `rgb(${g},${g},${g})`;
    b.fillRect(r.x, r.y, r.w, r.h);

    // hatch / vent details
    if (rng() < p.hatch && r.w > 36 && r.h > 36) {
      const iw = r.w * (0.3 + rng() * 0.4);
      const ih = r.h * (0.3 + rng() * 0.4);
      const ix = r.x + (r.w - iw) * rng();
      const iy = r.y + (r.h - ih) * rng();
      if (rng() < 0.5) {
        // grille
        c.fillStyle = `rgba(25,25,28,${0.25 + rng() * 0.25})`;
        b.fillStyle = '#3a3a3a';
        const step = 4;
        for (let yy = iy; yy < iy + ih; yy += step) {
          c.fillRect(ix, yy, iw, 1.5);
          b.fillRect(ix, yy, iw, 1.5);
        }
      } else {
        // hatch
        c.strokeStyle = `rgba(30,30,32,${p.line * 0.8})`;
        c.lineWidth = 1;
        c.strokeRect(ix + 0.5, iy + 0.5, iw, ih);
        b.strokeStyle = '#2a2a2a';
        b.lineWidth = 1.5;
        b.strokeRect(ix, iy, iw, ih);
        b.fillStyle = `rgb(${g + 14},${g + 14},${g + 14})`;
        b.fillRect(ix + 2, iy + 2, iw - 4, ih - 4);
      }
    }

    // rivet rows
    if (rng() < p.rivet && r.w > 24) {
      const yy = rng() < 0.5 ? r.y + 3 : r.y + r.h - 3;
      c.fillStyle = 'rgba(40,40,40,0.25)';
      b.fillStyle = '#b0b0b0';
      for (let xx = r.x + 4; xx < r.x + r.w - 3; xx += 6) {
        c.fillRect(xx, yy, 1.5, 1.5);
        b.fillRect(xx, yy, 1.5, 1.5);
      }
    }
  }

  // panel lines (soft AO halo + crisp groove)
  for (const r of leaves) {
    c.strokeStyle = `rgba(30,28,26,${p.line * 0.22})`;
    c.lineWidth = 3;
    c.strokeRect(r.x, r.y, r.w, r.h);
    c.strokeStyle = `rgba(22,22,24,${p.line})`;
    c.lineWidth = 1;
    c.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    b.strokeStyle = '#1e1e1e';
    b.lineWidth = 2;
    b.strokeRect(r.x, r.y, r.w, r.h);
  }

  // grime blotches
  for (let i = 0; i < p.blotches; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = 8 + rng() * rng() * 90;
    const a = Math.min(0.6, p.grime * (0.04 + rng() * 0.12));
    drawWrapped(S, x, y, r, (px, py) => {
      const gr = c.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, `rgba(58,50,42,${a})`);
      gr.addColorStop(1, 'rgba(58,50,42,0)');
      c.fillStyle = gr;
      c.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }

  // streaks
  for (let i = 0; i < p.streaks; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const len = 20 + rng() * 140;
    const w = 1 + rng() * 2.5;
    const a = Math.min(0.5, p.grime * (0.05 + rng() * 0.12));
    drawWrapped(S, x, y + len / 2, len, (px, py) => {
      const top = py - len / 2;
      const gr = c.createLinearGradient(0, top, 0, top + len);
      gr.addColorStop(0, `rgba(45,40,35,${a})`);
      gr.addColorStop(1, 'rgba(45,40,35,0)');
      c.fillStyle = gr;
      c.fillRect(px, top, w, len);
    });
  }

  addNoise(c, S, p.noise, rng);
  addNoise(b, S, p.noise * 0.5, rng);

  const map = new THREE.CanvasTexture(cc);
  configure(map, true);
  const bumpMap = new THREE.CanvasTexture(bc);
  configure(bumpMap, false);
  return { map, bumpMap };
}

const panelCache = new Map<PanelStyle, PanelTextures>();

/** Cached neutral panel texture set for a style (generated once). */
export function getPanelTextures(style: PanelStyle): PanelTextures {
  let t = panelCache.get(style);
  if (!t) {
    t = generatePanels(STYLES[style]);
    panelCache.set(style, t);
  }
  return t;
}

let solarTex: THREE.CanvasTexture | null = null;

/** Dark TIE solar-collector cell grid (sRGB colour map, tiles every ~2 m with box UVs). */
export function getSolarPanelTexture(): THREE.CanvasTexture {
  if (solarTex) return solarTex;
  const S = 256;
  const cell = 32;
  const rng = mulberry32(1138);
  const [cv, c] = makeCanvas(S);
  c.fillStyle = '#16181c';
  c.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += cell) {
    for (let x = 0; x < S; x += cell) {
      const v = 20 + Math.floor(rng() * 12);
      c.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
      c.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      // subtle sheen gradient per cell
      const g = c.createLinearGradient(x, y, x + cell, y + cell);
      g.addColorStop(0, 'rgba(120,130,150,0.06)');
      g.addColorStop(1, 'rgba(0,0,0,0.08)');
      c.fillStyle = g;
      c.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    }
  }
  c.strokeStyle = '#3b4049';
  c.lineWidth = 2;
  for (let i = 0; i <= S; i += cell) {
    c.beginPath();
    c.moveTo(i, 0);
    c.lineTo(i, S);
    c.moveTo(0, i);
    c.lineTo(S, i);
    c.stroke();
  }
  addNoise(c, S, 6, rng);
  solarTex = new THREE.CanvasTexture(cv);
  configure(solarTex, true);
  return solarTex;
}

let plumeTex: THREE.CanvasTexture | null = null;

/** Vertical alpha gradient (opaque at uv.y = 0, transparent at uv.y = 1) for engine plumes. */
export function getPlumeAlphaTexture(): THREE.CanvasTexture {
  if (plumeTex) return plumeTex;
  const [cv, c] = makeCanvas(64);
  // canvas top row maps to uv.y = 1 (flipY), so fade towards the top
  const g = c.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, '#000000');
  g.addColorStop(0.55, '#404040');
  g.addColorStop(0.85, '#c0c0c0');
  g.addColorStop(1, '#ffffff');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  plumeTex = new THREE.CanvasTexture(cv);
  plumeTex.wrapS = plumeTex.wrapT = THREE.ClampToEdgeWrapping;
  return plumeTex;
}
