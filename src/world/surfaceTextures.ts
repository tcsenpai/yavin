// Procedural Death Star hull material: tiling plate textures (albedo, normal from a generated height field,
// roughness) plus a large-scale "macro" texture that breaks the tiling, and procedural lit windows / height AO
// injected into MeshStandardMaterial. Geometry from MeshBuilder carries the per-vertex data the shader needs.
import * as THREE from 'three';
import { Rng } from '../core/rng';

export interface HullTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  /** R: albedo tone patches, G: roughness patches, B: grime. Sampled at two incommensurate world scales. */
  macroMap: THREE.Texture;
}

let cached: HullTextures | null = null;

const SIZE = 1024;
const MACRO = 256;

const gray = (v: number) => {
  const g = Math.round(Math.min(255, Math.max(0, v)));
  return `rgb(${g},${g},${g})`;
};

export function getHullTextures(): HullTextures {
  if (cached) return cached;
  const rng = new Rng(1977);
  const albedo = makeCanvas(SIZE);
  const height = makeCanvas(SIZE);
  const rough = makeCanvas(SIZE);
  const a = albedo.getContext('2d', { willReadFrequently: true })!;
  const h = height.getContext('2d', { willReadFrequently: true })!;
  const r = rough.getContext('2d', { willReadFrequently: true })!;

  a.fillStyle = '#56585c';
  a.fillRect(0, 0, SIZE, SIZE);
  h.fillStyle = gray(100);
  h.fillRect(0, 0, SIZE, SIZE);
  r.fillStyle = gray(190);
  r.fillRect(0, 0, SIZE, SIZE);

  // Recursive panel subdivision — the DS-I hull is a quilt of rectangular plates of very mixed sizes.
  const panels: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, hh: number, depth: number) => {
    const canSplit = depth < 8 && (w > 24 || hh > 24);
    if (canSplit && (depth < 2 || rng.chance(0.8))) {
      if (w > hh ? rng.chance(0.8) : rng.chance(0.2)) {
        const s = Math.round((w * rng.range(0.25, 0.75)) / 8) * 8 || w / 2;
        split(x, y, s, hh, depth + 1);
        split(x + s, y, w - s, hh, depth + 1);
      } else {
        const s = Math.round((hh * rng.range(0.25, 0.75)) / 8) * 8 || hh / 2;
        split(x, y, w, s, depth + 1);
        split(x, y + s, w, hh - s, depth + 1);
      }
      return;
    }
    panels.push([x, y, w, hh]);
  };
  split(0, 0, SIZE, SIZE, 0);

  for (const [x, y, w, hh] of panels) {
    // Plate: tone, slight warm/cool cast, bevelled plateau in the height field, own roughness.
    const tone = rng.range(-12, 10);
    const cast = rng.range(-2.5, 2.5);
    const g = 124 + tone;
    a.fillStyle = `rgb(${g + cast | 0},${g + 1 | 0},${g + 3 - cast | 0})`;
    a.fillRect(x + 1, y + 1, w - 2, hh - 2);
    const lift = rng.range(-18, 22);
    h.fillStyle = gray(128 + lift - 14);
    h.fillRect(x + 1, y + 1, w - 2, hh - 2);
    h.fillStyle = gray(128 + lift);
    h.fillRect(x + 3, y + 3, w - 6, hh - 6);
    const ro = rng.range(105, 215);
    r.fillStyle = gray(ro);
    r.fillRect(x + 1, y + 1, w - 2, hh - 2);

    const kind = rng.float();
    if (kind < 0.05 && w > 30 && hh > 30) {
      // Vent grille: parallel recessed slots.
      const horizontal = w > hh;
      const n = Math.floor((horizontal ? hh : w) / 6);
      for (let i = 1; i < n; i++) {
        h.fillStyle = gray(60);
        a.fillStyle = 'rgba(26,28,32,0.85)';
        r.fillStyle = gray(235);
        const rect: [number, number, number, number] = horizontal ? [x + 5, y + i * 6, w - 10, 2] : [x + i * 6, y + 5, 2, hh - 10];
        h.fillRect(...rect);
        a.fillRect(...rect);
        r.fillRect(...rect);
      }
    } else if (kind < 0.27 && w > 20 && hh > 20) {
      // Raised (or sunken) inner hatch with its own bevel and seam.
      const up = rng.chance(0.7);
      const ix = x + Math.round(w * rng.range(0.15, 0.25));
      const iy = y + Math.round(hh * rng.range(0.15, 0.25));
      const iw = x + w - ix - (ix - x);
      const ih = y + hh - iy - (iy - y);
      const base = 128 + lift + (up ? 26 : -30);
      h.fillStyle = gray(base - (up ? 12 : -12));
      h.fillRect(ix, iy, iw, ih);
      h.fillStyle = gray(base);
      h.fillRect(ix + 2, iy + 2, iw - 4, ih - 4);
      const t = g + rng.range(-14, 14);
      a.fillStyle = `rgba(${t | 0},${t + 1 | 0},${t + 4 | 0},0.9)`;
      a.fillRect(ix, iy, iw, ih);
      a.strokeStyle = 'rgba(30,32,36,0.5)';
      a.lineWidth = 1;
      a.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
      r.fillStyle = gray(ro + rng.range(-40, 30));
      r.fillRect(ix, iy, iw, ih);
    } else if (kind < 0.42 && w > 16 && hh > 16) {
      // Greeble cluster: small boxes of random height (the miniature's kit-bash detail).
      const n = 3 + Math.floor(rng.float() * 7);
      for (let i = 0; i < n; i++) {
        const gw = 4 + Math.floor(rng.float() * Math.min(28, w * 0.4));
        const gh = 4 + Math.floor(rng.float() * Math.min(28, hh * 0.4));
        const gx = x + 3 + Math.floor(rng.float() * Math.max(1, w - gw - 6));
        const gy = y + 3 + Math.floor(rng.float() * Math.max(1, hh - gh - 6));
        const gl = 128 + lift + rng.range(-35, 45);
        h.fillStyle = gray(gl - 10);
        h.fillRect(gx, gy, gw, gh);
        h.fillStyle = gray(gl);
        h.fillRect(gx + 1, gy + 1, gw - 2, gh - 2);
        const t = g + rng.range(-22, 18);
        a.fillStyle = `rgb(${t | 0},${t + 1 | 0},${t + 3 | 0})`;
        a.fillRect(gx, gy, gw, gh);
      }
    } else if (kind < 0.5) {
      // Rivet / bolt rows along the plate edges.
      a.fillStyle = 'rgba(40,42,46,0.5)';
      h.fillStyle = gray(128 + lift + 30);
      for (let i = x + 6; i < x + w - 4; i += 8) {
        h.fillRect(i, y + 5, 2, 2);
        h.fillRect(i, y + hh - 7, 2, 2);
        a.fillRect(i, y + 5, 2, 2);
        a.fillRect(i, y + hh - 7, 2, 2);
      }
    } else if (kind < 0.56 && (w > 40 || hh > 40)) {
      // Conduit strip: raised round-ish ridge (three height steps) along the plate.
      const horizontal = w > hh;
      const c = horizontal ? y + hh / 2 : x + w / 2;
      for (const [off, dh] of [[5, 18], [3, 34], [1, 44]] as const) {
        h.fillStyle = gray(128 + lift + dh);
        if (horizontal) h.fillRect(x + 4, c - off, w - 8, off * 2);
        else h.fillRect(c - off, y + 4, off * 2, hh - 8);
      }
      a.fillStyle = 'rgba(150,152,156,0.35)';
      if (horizontal) a.fillRect(x + 4, c - 1, w - 8, 1);
      else a.fillRect(c - 1, y + 4, 1, hh - 8);
    } else if (kind < 0.6 && w > 20 && hh > 14) {
      // Unlit slot rows (dark glass / ports).
      a.fillStyle = 'rgba(18,19,22,0.9)';
      h.fillStyle = gray(70);
      r.fillStyle = gray(60);
      for (let yy = y + 4; yy < y + hh - 6; yy += 9) {
        for (let xx = x + 4; xx < x + w - 6; xx += 7) {
          a.fillRect(xx, yy, 4, 3);
          h.fillRect(xx, yy, 4, 3);
          r.fillRect(xx, yy, 4, 3);
        }
      }
    }
    // Panel seams: dark recessed lines with a worn bright lip on one side.
    a.strokeStyle = 'rgba(28,30,34,0.6)';
    a.lineWidth = 2;
    a.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
    a.fillStyle = 'rgba(215,217,222,0.13)';
    a.fillRect(x + 2, y + 2, w - 4, 1);
    a.fillRect(x + 2, y + 2, 1, hh - 4);
    h.strokeStyle = gray(30);
    h.lineWidth = 2;
    h.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
  }

  // Grime: soft blotches darken albedo and raise roughness (wrapped so the tile stays seamless).
  for (let i = 0; i < 360; i++) {
    const x = rng.range(0, SIZE);
    const y = rng.range(0, SIZE);
    const rad = rng.range(8, 70);
    const al = rng.range(0.04, 0.15);
    wrapped(x, y, rad, SIZE, (px, py) => {
      const grd = a.createRadialGradient(px, py, 0, px, py, rad);
      grd.addColorStop(0, `rgba(18,18,22,${al})`);
      grd.addColorStop(1, 'rgba(18,18,22,0)');
      a.fillStyle = grd;
      a.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      const grr = r.createRadialGradient(px, py, 0, px, py, rad);
      grr.addColorStop(0, `rgba(255,255,255,${al * 1.4})`);
      grr.addColorStop(1, 'rgba(255,255,255,0)');
      r.fillStyle = grr;
      r.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  // Streaks: long faint drips along v (vertical on walls).
  for (let i = 0; i < 220; i++) {
    const x = rng.range(0, SIZE);
    const y = rng.range(0, SIZE);
    const len = rng.range(30, 220);
    const wd = rng.range(1.5, 6);
    const grd = a.createLinearGradient(0, y, 0, y + len);
    grd.addColorStop(0, `rgba(20,20,24,${rng.range(0.05, 0.13)})`);
    grd.addColorStop(1, 'rgba(20,20,24,0)');
    a.fillStyle = grd;
    a.fillRect(x, y, wd, len);
    if (y + len > SIZE) {
      a.save();
      a.translate(0, -SIZE);
      a.fillRect(x, y, wd, len);
      a.restore();
    }
  }

  // Per-pixel micro variation (breaks the flat CG look up close).
  const noise = new Rng(4242);
  const ai = a.getImageData(0, 0, SIZE, SIZE);
  const ri = r.getImageData(0, 0, SIZE, SIZE);
  for (let i = 0; i < ai.data.length; i += 4) {
    const n = (noise.float() - 0.5) * 9;
    ai.data[i] += n;
    ai.data[i + 1] += n;
    ai.data[i + 2] += n;
    ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = ri.data[i] + (noise.float() - 0.5) * 22;
  }
  a.putImageData(ai, 0, 0);
  r.putImageData(ri, 0, 0);

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(rough);
  const normalMap = heightToNormal(h.getImageData(0, 0, SIZE, SIZE).data, 2.6);
  const macroMap = makeMacro();
  for (const t of [map, roughnessMap, normalMap, macroMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16; // clamped by three to the GPU maximum; key against grazing-angle stripes
    t.userData.shared = true;
    t.needsUpdate = true;
  }
  cached = { map, normalMap, roughnessMap, macroMap };
  return cached;
}

/** Call `draw` at (x,y) and at the wrapped copies needed for a seamless tile. */
function wrapped(x: number, y: number, rad: number, size: number, draw: (x: number, y: number) => void): void {
  for (const ox of [0, -size, size]) {
    for (const oy of [0, -size, size]) {
      const cx = x + ox;
      const cy = y + oy;
      if (cx + rad < 0 || cx - rad > size || cy + rad < 0 || cy - rad > size) continue;
      draw(cx, cy);
    }
  }
}

/** Large-scale tonal quilt + grime, in three independent channels. */
function makeMacro(): THREE.DataTexture {
  const rng = new Rng(5150);
  const layer = (quilt: boolean, blotches: number, base: number): Uint8ClampedArray => {
    const c = makeCanvas(MACRO);
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.fillStyle = gray(base);
    x.fillRect(0, 0, MACRO, MACRO);
    if (quilt) {
      const split = (px: number, py: number, w: number, hh: number, depth: number) => {
        if (depth < 7 && (w > 8 || hh > 8) && (depth < 2 || rng.chance(0.75))) {
          if (w > hh ? rng.chance(0.75) : rng.chance(0.25)) {
            const s = Math.max(2, Math.round(w * rng.range(0.3, 0.7)));
            split(px, py, s, hh, depth + 1);
            split(px + s, py, w - s, hh, depth + 1);
          } else {
            const s = Math.max(2, Math.round(hh * rng.range(0.3, 0.7)));
            split(px, py, w, s, depth + 1);
            split(px, py + s, w, hh - s, depth + 1);
          }
          return;
        }
        x.fillStyle = gray(base + rng.range(-60, 60));
        x.fillRect(px, py, w, hh);
      };
      split(0, 0, MACRO, MACRO, 0);
    }
    for (let i = 0; i < blotches; i++) {
      const bx = rng.range(0, MACRO);
      const by = rng.range(0, MACRO);
      const rad = rng.range(4, 40);
      const dark = rng.chance(0.5);
      const al = rng.range(0.1, 0.35);
      wrapped(bx, by, rad, MACRO, (px, py) => {
        const grd = x.createRadialGradient(px, py, 0, px, py, rad);
        const col = dark ? '0,0,0' : '255,255,255';
        grd.addColorStop(0, `rgba(${col},${al})`);
        grd.addColorStop(1, `rgba(${col},0)`);
        x.fillStyle = grd;
        x.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      });
    }
    return x.getImageData(0, 0, MACRO, MACRO).data;
  };
  const tone = layer(true, 90, 128);
  const rough = layer(true, 40, 128);
  const grime = layer(false, 160, 40);
  const out = new Uint8Array(MACRO * MACRO * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = tone[i];
    out[i + 1] = rough[i];
    out[i + 2] = grime[i];
    out[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, MACRO, MACRO, THREE.RGBAFormat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function heightToNormal(src: Uint8ClampedArray, strength: number): THREE.DataTexture {
  const out = new Uint8Array(SIZE * SIZE * 4);
  const hAt = (x: number, y: number) => src[(((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4] / 255;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * strength;
      const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * SIZE + x) * 4;
      out[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, SIZE, SIZE, THREE.RGBAFormat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// Per-vertex hull data (attribute `aHullDet`, written by MeshBuilder):
//   x = window grid u (m along the face), y = height above local ground (m),
//   z = lit-window probability (0 = no windows), w = height-AO strength (vertical faces).
const HULL_VERT_PARS = /* glsl */ `
attribute vec4 aHullDet;
varying vec4 vHullDet;
`;

const HULL_FRAG_PARS = /* glsl */ `
uniform sampler2D hullMacroMap;
varying vec4 vHullDet;
float hullHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

// Window grid: one window per 2.1 m x 2.7 m cell. The pattern is box-filtered analytically and fades to its
// mean (coverage x lit fraction) once a cell shrinks below a few pixels, so distant walls glow evenly instead
// of sparkling/aliasing.
const HULL_MAP = /* glsl */ `
#include <map_fragment>
vec2 hullUv = vMapUv;
vec4 hullMacro = texture2D(hullMacroMap, mat2(0.921, 0.389, -0.389, 0.921) * hullUv * 0.0917);
vec4 hullMacroFar = texture2D(hullMacroMap, mat2(0.6, -0.8, 0.8, 0.6) * hullUv * 0.0219 + 0.37);
diffuseColor.rgb *= mix(0.68, 1.25, hullMacro.r) * mix(0.82, 1.14, hullMacroFar.r) * (1.0 - 0.45 * hullMacro.b);
diffuseColor.rgb *= 1.0 - vHullDet.w * (1.0 - smoothstep(0.0, 10.0, vHullDet.y));
vec3 hullWin = vec3(0.0);
if (vHullDet.z > 0.0) {
  vec2 g = vec2(vHullDet.x / 1.6, vHullDet.y / 2.2);
  vec2 id = floor(g);
  vec2 f = fract(g);
  vec2 fw = max(fwidth(g), vec2(1e-4));
  const vec2 wa = vec2(0.22, 0.44);
  const vec2 wb = vec2(0.78, 0.57);
  vec2 cov2 = clamp((min(f + fw * 0.5, wb) - max(f - fw * 0.5, wa)) / fw, 0.0, 1.0);
  float cov = cov2.x * cov2.y;
  float h = hullHash(id + 0.5);
  float rowRun = hullHash(vec2(id.y * 1.7 + 0.3, floor(id.x / 6.0) + 11.0));
  float rowLit = 2.4 * rowRun * rowRun;
  float lit = step(h, vHullDet.z * rowLit);
  float h2 = hullHash(id.yx + 7.31);
  vec3 col = (h2 < 0.7 ? vec3(1.0, 0.74, 0.46) : vec3(0.6, 0.8, 1.0)) * (0.45 + 1.1 * hullHash(id + 3.7));
  float far = smoothstep(0.28, 0.7, max(fw.x, fw.y));
  float area = (wb.x - wa.x) * (wb.y - wa.y);
  float winA = mix(cov, area, far);
  hullWin = mix(cov * lit * col, vec3(1.0, 0.84, 0.66) * (area * min(vHullDet.z, 1.0) * 0.8 * 0.8), far);
  diffuseColor.rgb *= 1.0 - 0.35 * winA;
}
`;

const HULL_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (hullMacro.g - 0.5) * 0.4 + hullMacro.b * 0.25, 0.18, 1.0);
`;

const HULL_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += hullWin * 1.15;
`;

let hullMaterial: THREE.MeshStandardMaterial | null = null;

/** Shared Death Star hull material. Geometry UVs are world-space metres × HULL_UV_SCALE. */
export function getHullMaterial(): THREE.MeshStandardMaterial {
  if (hullMaterial) return hullMaterial;
  const t = getHullTextures();
  hullMaterial = new THREE.MeshStandardMaterial({
    map: t.map,
    normalMap: t.normalMap,
    normalScale: new THREE.Vector2(1, 1),
    roughnessMap: t.roughnessMap,
    roughness: 1,
    metalness: 0.22,
    vertexColors: true,
  });
  hullMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.hullMacroMap = { value: t.macroMap };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HULL_VERT_PARS}`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvHullDet = aHullDet;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${HULL_FRAG_PARS}`)
      .replace('#include <map_fragment>', HULL_MAP)
      .replace('#include <roughnessmap_fragment>', HULL_ROUGH)
      .replace('#include <emissivemap_fragment>', HULL_EMISSIVE);
  };
  hullMaterial.customProgramCacheKey = () => 'ds-hull-v2';
  hullMaterial.userData.shared = true;
  return hullMaterial;
}

// 1/67: deliberately incommensurate with the 24 m architecture cells so tiling never lines up with blocks.
export const HULL_UV_SCALE = 1 / 67;
