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
  /** sRGB colour map (panel tones, panel lines, grime, chipped paint). */
  map: THREE.CanvasTexture;
  /** Linear height map (panel line grooves, raised plates, rivets, paint chips). */
  bumpMap: THREE.CanvasTexture;
  /** Tangent-space normal map derived from the height map. */
  normalMap: THREE.CanvasTexture;
  /** Packed linear ORM map: R = cavity AO, G = roughness, B = metalness (absolute values). */
  ormMap: THREE.CanvasTexture;
}

interface StyleParams {
  seed: number;
  size: number;
  /** Smallest panel edge in px (512-px reference units, scaled with `size`). */
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
  /** Paint roughness / metalness and bare-metal (worn) roughness / metalness. */
  rough: number;
  metal: number;
  wornRough: number;
  wornMetal: number;
  /** Amount of edge wear / chipped paint (0..1). */
  wear: number;
  /** Normal map strength (height units → slope). */
  normal: number;
}

const STYLES: Record<PanelStyle, StyleParams> = {
  fighter: { seed: 11, size: 1024, minPanel: 28, stop: 0.2, tone: 0.08, line: 0.26, grime: 0.8, blotches: 70, streaks: 90, hatch: 0.22, rivet: 0.3, noise: 6, plate: 10, rough: 0.68, metal: 0.04, wornRough: 0.34, wornMetal: 0.85, wear: 0.5, normal: 5 },
  freighter: { seed: 23, size: 1024, minPanel: 20, stop: 0.14, tone: 0.16, line: 0.34, grime: 1.0, blotches: 110, streaks: 150, hatch: 0.32, rivet: 0.32, noise: 8, plate: 16, rough: 0.66, metal: 0.06, wornRough: 0.36, wornMetal: 0.8, wear: 0.8, normal: 5.5 },
  imperial: { seed: 37, size: 1024, minPanel: 32, stop: 0.22, tone: 0.07, line: 0.26, grime: 0.35, blotches: 30, streaks: 30, hatch: 0.18, rivet: 0.22, noise: 5, plate: 9, rough: 0.6, metal: 0.1, wornRough: 0.32, wornMetal: 0.8, wear: 0.25, normal: 4.5 },
  deathstar: { seed: 53, size: 512, minPanel: 18, stop: 0.12, tone: 0.2, line: 0.32, grime: 0.6, blotches: 60, streaks: 24, hatch: 0.25, rivet: 0.1, noise: 8, plate: 22, rough: 0.68, metal: 0.1, wornRough: 0.4, wornMetal: 0.7, wear: 0.3, normal: 4 },
};

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
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

/** Tileable fractal value noise over an S×S grid (returns [0, 1]). */
function fbm(S: number, rng: () => number, periods: number[]): Float32Array {
  const out = new Float32Array(S * S);
  periods.forEach((P, o) => {
    const amp = 1 / (o + 1);
    const lat = new Float32Array(P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    const k = P / S;
    for (let y = 0; y < S; y++) {
      const fy = y * k;
      const y0 = Math.floor(fy);
      let ty = fy - y0;
      ty = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % P) * P;
      const r1 = ((y0 + 1) % P) * P;
      for (let x = 0; x < S; x++) {
        const fx = x * k;
        const x0 = Math.floor(fx);
        let tx = fx - x0;
        tx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % P;
        const c1 = (x0 + 1) % P;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * tx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * tx;
        out[y * S + x] += (a + (b - a) * ty) * amp;
      }
    }
  });
  // stretch to the full [0, 1] range (octave sums cluster around 0.5)
  let lo = Infinity, hi = -Infinity;
  for (const v of out) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const inv = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * inv;
  return out;
}

/** Separable wrap-around box blur (`passes` ≈ gaussian). */
function blurWrapped(src: Float32Array, S: number, r: number, passes = 2): Float32Array {
  const a = src.slice();
  const b = new Float32Array(S * S);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < S; y++) {
      const row = y * S;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[row + ((k + S) % S)];
      for (let x = 0; x < S; x++) {
        b[row + x] = acc * inv;
        acc += a[row + ((x + r + 1) % S)] - a[row + ((x - r + S) % S)];
      }
    }
    for (let x = 0; x < S; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[((k + S) % S) * S + x];
      for (let y = 0; y < S; y++) {
        a[y * S + x] = acc * inv;
        acc += b[((y + r + 1) % S) * S + x] - b[((y - r + S) % S) * S + x];
      }
    }
  }
  return a;
}

function readChannel(ctx: CanvasRenderingContext2D, S: number): Float32Array {
  const d = ctx.getImageData(0, 0, S, S).data;
  const out = new Float32Array(S * S);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

/** Tangent-space normal map canvas from a wrapped height field (canvas rows top → bottom, flipY texture). */
function normalCanvas(h: Float32Array, S: number, strength: number): HTMLCanvasElement {
  const [cv, ctx] = makeCanvas(S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1 + S) % S) * S, y0 = y * S, yp = ((y + 1) % S) * S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      // Sobel
      const dx = (h[ym + xp] + 2 * h[y0 + xp] + h[yp + xp]) - (h[ym + xm] + 2 * h[y0 + xm] + h[yp + xm]);
      const dy = (h[yp + xm] + 2 * h[yp + x] + h[yp + xp]) - (h[ym + xm] + 2 * h[ym + x] + h[ym + xp]);
      // u grows with x; v grows towards the canvas top (flipY) → dh/dv = -dh/drow
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const l = 1 / Math.hypot(nx, ny, nz);
      nx *= l; ny *= l; nz *= l;
      const i = (y0 + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

interface Rect { x: number; y: number; w: number; h: number }

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function generatePanels(p: StyleParams): PanelTextures {
  const S = p.size;
  const k = S / 512;
  const rng = mulberry32(p.seed);
  const [cc, c] = makeCanvas(S);
  const [bc, b] = makeCanvas(S);
  const [, m] = makeCanvas(S); // edge mask (panel seams / hatch outlines) → wear proximity

  c.fillStyle = '#ededeb';
  c.fillRect(0, 0, S, S);
  b.fillStyle = '#808080';
  b.fillRect(0, 0, S, S);
  m.fillStyle = '#000';
  m.fillRect(0, 0, S, S);

  // --- kd subdivision into hull plates -------------------------------------------------
  const minP = p.minPanel * k;
  const leaves: Rect[] = [];
  const split = (x: number, y: number, w: number, h: number, d: number): void => {
    const cw = w >= minP * 2;
    const ch = h >= minP * 2;
    if ((!cw && !ch) || (d >= 2 && rng() < p.stop)) {
      leaves.push({ x, y, w, h });
      return;
    }
    const vertical = cw && (!ch || w > h * (0.7 + rng() * 0.6));
    if (vertical) {
      const s = Math.max(minP, Math.min(w - minP, Math.round(w * (0.25 + rng() * 0.5))));
      split(x, y, s, h, d + 1);
      split(x + s, y, w - s, h, d + 1);
    } else {
      const s = Math.max(minP, Math.min(h - minP, Math.round(h * (0.25 + rng() * 0.5))));
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
    if (rng() < p.hatch && r.w > 36 * k && r.h > 36 * k) {
      const iw = r.w * (0.3 + rng() * 0.4);
      const ih = r.h * (0.3 + rng() * 0.4);
      const ix = r.x + (r.w - iw) * rng();
      const iy = r.y + (r.h - ih) * rng();
      if (rng() < 0.5) {
        // recessed grille
        c.fillStyle = `rgba(25,25,28,${0.3 + rng() * 0.25})`;
        b.fillStyle = `rgb(${g - 30},${g - 30},${g - 30})`;
        b.fillRect(ix, iy, iw, ih);
        const step = 4 * k;
        for (let yy = iy; yy < iy + ih; yy += step) {
          c.fillRect(ix, yy, iw, 1.5 * k);
          b.fillStyle = '#2e2e2e';
          b.fillRect(ix, yy, iw, 1.5 * k);
        }
        m.strokeStyle = '#fff';
        m.lineWidth = 1.5 * k;
        m.strokeRect(ix, iy, iw, ih);
      } else {
        // raised hatch with a seam
        c.strokeStyle = `rgba(30,30,32,${p.line * 0.8})`;
        c.lineWidth = k;
        c.strokeRect(ix + 0.5, iy + 0.5, iw, ih);
        b.strokeStyle = '#262626';
        b.lineWidth = 1.5 * k;
        b.strokeRect(ix, iy, iw, ih);
        b.fillStyle = `rgb(${g + 16},${g + 16},${g + 16})`;
        b.fillRect(ix + 2 * k, iy + 2 * k, iw - 4 * k, ih - 4 * k);
        m.strokeStyle = '#fff';
        m.lineWidth = 1.5 * k;
        m.strokeRect(ix, iy, iw, ih);
      }
    }

    // rivet rows (raised)
    if (rng() < p.rivet && r.w > 24 * k) {
      const yy = rng() < 0.5 ? r.y + 3 * k : r.y + r.h - 3 * k;
      c.fillStyle = 'rgba(40,40,40,0.25)';
      b.fillStyle = '#c0c0c0';
      for (let xx = r.x + 4 * k; xx < r.x + r.w - 3 * k; xx += 6 * k) {
        c.fillRect(xx, yy, 1.5 * k, 1.5 * k);
        b.fillRect(xx, yy, 1.5 * k, 1.5 * k);
      }
    }
  }

  // panel lines (soft AO halo + crisp groove)
  for (const r of leaves) {
    c.strokeStyle = `rgba(30,28,26,${p.line * 0.25})`;
    c.lineWidth = 4 * k;
    c.strokeRect(r.x, r.y, r.w, r.h);
    c.strokeStyle = `rgba(18,18,20,${p.line})`;
    c.lineWidth = 1.5 * k;
    c.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    b.strokeStyle = '#141414';
    b.lineWidth = 2 * k;
    b.strokeRect(r.x, r.y, r.w, r.h);
    m.strokeStyle = '#fff';
    m.lineWidth = 2 * k;
    m.strokeRect(r.x, r.y, r.w, r.h);
  }

  // grime blotches (also tracked in a grime layer → roughness)
  const [, gctx] = makeCanvas(S);
  gctx.fillStyle = '#000';
  gctx.fillRect(0, 0, S, S);
  for (let i = 0; i < p.blotches; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = (8 + rng() * rng() * 90) * k;
    const a = Math.min(0.6, p.grime * (0.04 + rng() * 0.12));
    drawWrapped(S, x, y, r, (px, py) => {
      const gr = c.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, `rgba(58,50,42,${a})`);
      gr.addColorStop(1, 'rgba(58,50,42,0)');
      c.fillStyle = gr;
      c.fillRect(px - r, py - r, r * 2, r * 2);
      const gg = gctx.createRadialGradient(px, py, 0, px, py, r);
      gg.addColorStop(0, `rgba(255,255,255,${a * 2})`);
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      gctx.fillStyle = gg;
      gctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }

  // streaks
  for (let i = 0; i < p.streaks; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const len = (20 + rng() * 140) * k;
    const w = (1 + rng() * 2.5) * k;
    const a = Math.min(0.5, p.grime * (0.05 + rng() * 0.12));
    drawWrapped(S, x, y + len / 2, len, (px, py) => {
      const top = py - len / 2;
      const gr = c.createLinearGradient(0, top, 0, top + len);
      gr.addColorStop(0, `rgba(45,40,35,${a})`);
      gr.addColorStop(1, 'rgba(45,40,35,0)');
      c.fillStyle = gr;
      c.fillRect(px, top, w, len);
      const gg = gctx.createLinearGradient(0, top, 0, top + len);
      gg.addColorStop(0, `rgba(255,255,255,${a * 2})`);
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      gctx.fillStyle = gg;
      gctx.fillRect(px, top, w, len);
    });
  }

  // scratches (bare-metal hairlines, mostly near seams)
  m.lineCap = 'round';
  for (let i = 0; i < 40 * p.wear * k * k; i++) {
    const x = rng() * S, y = rng() * S;
    const a = rng() * Math.PI * 2;
    const len = (6 + rng() * 30) * k;
    m.strokeStyle = `rgba(255,255,255,${0.5 + rng() * 0.5})`;
    m.lineWidth = (0.6 + rng() * 0.8) * k;
    drawWrapped(S, x, y, len, (px, py) => {
      m.beginPath();
      m.moveTo(px, py);
      m.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
      m.stroke();
    });
  }

  addNoise(c, S, p.noise, rng);

  // --- per-pixel PBR combine -----------------------------------------------------------
  const seam = readChannel(m, S);
  const prox = blurWrapped(seam, S, Math.max(1, Math.round(3 * k)));
  const grime = readChannel(gctx, S);
  const height = readChannel(b, S);
  const nFine = fbm(S, rng, [16, 32, 64, 128].map((v) => Math.round(v * Math.max(1, k / 2))));
  const nCoarse = fbm(S, rng, [4, 8, 16]);

  const col = c.getImageData(0, 0, S, S);
  const cd = col.data;
  const [oc, octx] = makeCanvas(S);
  const orm = octx.createImageData(S, S);
  const od = orm.data;
  // paint chips: seam proximity broken up by noise, more where the coarse wear noise is high
  for (let i = 0; i < S * S; i++) {
    const nf = nFine[i];
    const ncv = nCoarse[i];
    const edge = Math.min(1, prox[i] * 2.2 + seam[i] * 0.3);
    const T = 1.1 - 0.28 * p.wear + (0.5 - ncv) * 0.25;
    const worn = smooth(T, T + 0.04, edge * 0.66 + nf * 0.75);
    // chipped paint sits slightly lower than the paint layer
    height[i] -= worn * 0.035;
    const j = i * 4;
    // bare metal: neutral grey, slightly cool
    cd[j] = cd[j] + (150 - cd[j]) * worn;
    cd[j + 1] = cd[j + 1] + (153 - cd[j + 1]) * worn;
    cd[j + 2] = cd[j + 2] + (158 - cd[j + 2]) * worn;
    const gr = grime[i];
    const rough = p.rough + (ncv - 0.5) * 0.14 + (nf - 0.5) * 0.06 + gr * 0.22;
    od[j + 1] = Math.min(1, Math.max(0.04, rough + (p.wornRough - rough) * worn)) * 255;
    od[j + 2] = Math.min(1, p.metal + (p.wornMetal - p.metal) * worn - gr * 0.05) * 255;
    od[j + 3] = 255;
  }
  c.putImageData(col, 0, 0);

  // cavity AO from the height field (grooves/recesses darken indirect light)
  const hBlur = blurWrapped(height, S, Math.max(1, Math.round(2 * k)));
  for (let i = 0; i < S * S; i++) {
    const cav = Math.max(0, hBlur[i] - height[i]);
    od[i * 4] = Math.max(0.3, 1 - cav * 7) * 255;
  }
  octx.putImageData(orm, 0, 0);

  // re-write the (chipped) height field into the bump canvas
  const bimg = b.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const v = Math.max(0, Math.min(255, height[i] * 255));
    bimg.data[i * 4] = bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = v;
  }
  b.putImageData(bimg, 0, 0);

  const map = new THREE.CanvasTexture(cc);
  configure(map, true);
  const bumpMap = new THREE.CanvasTexture(bc);
  configure(bumpMap, false);
  const normalMap = new THREE.CanvasTexture(normalCanvas(height, S, p.normal));
  configure(normalMap, false);
  const ormMap = new THREE.CanvasTexture(oc);
  configure(ormMap, false);
  return { map, bumpMap, normalMap, ormMap };
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

export interface SolarPanelTextures {
  /** sRGB colour map. */
  map: THREE.CanvasTexture;
  /** Raised cells / recessed frame grid. */
  normalMap: THREE.CanvasTexture;
  /** R = AO, G = roughness, B = metalness. */
  ormMap: THREE.CanvasTexture;
}

let solarSet: SolarPanelTextures | null = null;

/** TIE solar-collector cell grid: colour, normal and ORM maps (tiles every ~2 m with box UVs). */
export function getSolarPanelTextures(): SolarPanelTextures {
  if (solarSet) return solarSet;
  const S = 512;
  const cell = 64;
  const rng = mulberry32(1138);
  const [cv, c] = makeCanvas(S);
  const [, hc] = makeCanvas(S);
  const [ov, oc] = makeCanvas(S);
  c.fillStyle = '#121418';
  c.fillRect(0, 0, S, S);
  hc.fillStyle = '#404040';
  hc.fillRect(0, 0, S, S);
  oc.fillStyle = 'rgb(255,150,110)';
  oc.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += cell) {
    for (let x = 0; x < S; x += cell) {
      const v = 18 + Math.floor(rng() * 12);
      c.fillStyle = `rgb(${v},${v + 3},${v + 8})`;
      c.fillRect(x + 3, y + 3, cell - 6, cell - 6);
      // subtle sheen gradient per cell
      const g = c.createLinearGradient(x, y, x + cell, y + cell);
      g.addColorStop(0, 'rgba(120,135,160,0.08)');
      g.addColorStop(1, 'rgba(0,0,0,0.1)');
      c.fillStyle = g;
      c.fillRect(x + 3, y + 3, cell - 6, cell - 6);
      // fine horizontal cell striations
      c.fillStyle = 'rgba(0,0,0,0.18)';
      for (let yy = y + 8; yy < y + cell - 4; yy += 8) c.fillRect(x + 4, yy, cell - 8, 1);
      // glassy, slightly metallic cells; each cell slightly different
      const r = 50 + Math.floor(rng() * 30);
      oc.fillStyle = `rgb(255,${r},${90 + Math.floor(rng() * 40)})`;
      oc.fillRect(x + 3, y + 3, cell - 6, cell - 6);
      hc.fillStyle = '#c8c8c8';
      hc.fillRect(x + 3, y + 3, cell - 6, cell - 6);
    }
  }
  // frame grid
  c.strokeStyle = '#2f343c';
  c.lineWidth = 4;
  hc.strokeStyle = '#303030';
  hc.lineWidth = 4;
  for (let i = 0; i <= S; i += cell) {
    for (const ctx of [c, hc]) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, S);
      ctx.moveTo(0, i);
      ctx.lineTo(S, i);
      ctx.stroke();
    }
  }
  addNoise(c, S, 5, rng);
  const h = blurWrapped(readChannel(hc, S), S, 1, 1);
  const map = new THREE.CanvasTexture(cv);
  configure(map, true);
  const normalMap = new THREE.CanvasTexture(normalCanvas(h, S, 1.4));
  configure(normalMap, false);
  const ormMap = new THREE.CanvasTexture(ov);
  configure(ormMap, false);
  solarSet = { map, normalMap, ormMap };
  return solarSet;
}

/** Dark TIE solar-collector cell grid (sRGB colour map, tiles every ~2 m with box UVs). */
export function getSolarPanelTexture(): THREE.CanvasTexture {
  return getSolarPanelTextures().map;
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
