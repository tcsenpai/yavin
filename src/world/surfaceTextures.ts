// Procedural Death Star hull textures: albedo, normal (from a generated height field) and window-light emissive.
import * as THREE from 'three';
import { Rng } from '../core/rng';

export interface HullTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  emissiveMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

let cached: HullTextures | null = null;

const SIZE = 1024;

export function getHullTextures(): HullTextures {
  if (cached) return cached;
  const rng = new Rng(1977);
  const albedo = makeCanvas();
  const height = makeCanvas();
  const emis = makeCanvas();
  const rough = makeCanvas();
  const a = albedo.getContext('2d')!;
  const h = height.getContext('2d')!;
  const e = emis.getContext('2d')!;
  const r = rough.getContext('2d')!;

  a.fillStyle = '#7d7f83';
  a.fillRect(0, 0, SIZE, SIZE);
  h.fillStyle = 'rgb(128,128,128)';
  h.fillRect(0, 0, SIZE, SIZE);
  e.fillStyle = '#000';
  e.fillRect(0, 0, SIZE, SIZE);
  r.fillStyle = 'rgb(170,170,170)';
  r.fillRect(0, 0, SIZE, SIZE);

  // Recursive panel subdivision — the DS-I hull is a quilt of rectangular plates of very mixed sizes.
  const panels: [number, number, number, number][] = [];
  const split = (x: number, y: number, w: number, hh: number, depth: number) => {
    const canSplit = depth < 7 && (w > 24 || hh > 24);
    if (canSplit && (depth < 2 || rng.chance(0.78))) {
      if (w > hh ? rng.chance(0.8) : rng.chance(0.2)) {
        const s = Math.round(w * rng.range(0.25, 0.75) / 8) * 8 || w / 2;
        split(x, y, s, hh, depth + 1);
        split(x + s, y, w - s, hh, depth + 1);
      } else {
        const s = Math.round(hh * rng.range(0.25, 0.75) / 8) * 8 || hh / 2;
        split(x, y, w, s, depth + 1);
        split(x, y + s, w, hh - s, depth + 1);
      }
      return;
    }
    panels.push([x, y, w, hh]);
  };
  split(0, 0, SIZE, SIZE, 0);

  for (const [x, y, w, hh] of panels) {
    const tone = rng.range(-9, 7);
    const g = 125 + tone;
    a.fillStyle = `rgb(${g},${g + 1},${g + 4})`;
    a.fillRect(x + 1, y + 1, w - 2, hh - 2);
    const lift = rng.range(-14, 22);
    h.fillStyle = `rgb(${128 + lift},${128 + lift},${128 + lift})`;
    h.fillRect(x + 2, y + 2, w - 4, hh - 4);
    const ro = 150 + rng.range(-40, 50);
    r.fillStyle = `rgb(${ro},${ro},${ro})`;
    r.fillRect(x, y, w, hh);

    const kind = rng.float();
    if (kind < 0.05 && w > 30 && hh > 30) {
      // Vent grille: parallel recessed slots.
      const horizontal = w > hh;
      const n = Math.floor((horizontal ? hh : w) / 6);
      for (let i = 1; i < n; i++) {
        h.fillStyle = 'rgb(70,70,70)';
        a.fillStyle = 'rgba(30,32,36,0.8)';
        if (horizontal) {
          h.fillRect(x + 5, y + i * 6, w - 10, 2);
          a.fillRect(x + 5, y + i * 6, w - 10, 2);
        } else {
          h.fillRect(x + i * 6, y + 5, 2, hh - 10);
          a.fillRect(x + i * 6, y + 5, 2, hh - 10);
        }
      }
    } else if (kind < 0.34 && w > 20 && hh > 20) {
      // Raised inner plate / hatch.
      const ix = x + w * 0.2;
      const iy = y + hh * 0.2;
      h.fillStyle = 'rgb(175,175,175)';
      h.fillRect(ix, iy, w * 0.6, hh * 0.6);
      a.fillStyle = `rgba(${rng.chance(0.5) ? '136,138,142' : '114,116,120'},0.9)`;
      a.fillRect(ix, iy, w * 0.6, hh * 0.6);
    } else if (kind < 0.42) {
      // Rows of small lit windows (the hull "city lights").
      const rows = Math.max(1, Math.floor(hh / 10));
      const cols = Math.max(1, Math.floor(w / 7));
      for (let ry = 0; ry < rows; ry++) {
        for (let cx = 0; cx < cols; cx++) {
          if (!rng.chance(0.55)) continue;
          const wx = x + 3 + cx * 7;
          const wy = y + 3 + ry * 10;
          a.fillStyle = '#1b1c1f';
          a.fillRect(wx, wy, 4, 3);
          h.fillStyle = 'rgb(90,90,90)';
          h.fillRect(wx, wy, 4, 3);
          if (rng.chance(0.45)) {
            const warm = rng.chance(0.75);
            e.fillStyle = warm ? '#fff1c8' : '#bfe0ff';
            e.fillRect(wx, wy, 4, 3);
          }
        }
      }
    }
    // Panel seams: dark recessed lines.
    a.strokeStyle = 'rgba(40,42,46,0.45)';
    a.lineWidth = 2;
    a.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
    h.strokeStyle = 'rgb(40,40,40)';
    h.lineWidth = 2;
    h.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
  }

  // Grime: soft blotches darken albedo and raise roughness.
  for (let i = 0; i < 420; i++) {
    const x = rng.range(0, SIZE);
    const y = rng.range(0, SIZE);
    const rad = rng.range(6, 60);
    const grd = a.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(20,20,24,${rng.range(0.04, 0.16)})`);
    grd.addColorStop(1, 'rgba(20,20,24,0)');
    a.fillStyle = grd;
    a.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  const emissiveMap = new THREE.CanvasTexture(emis);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(rough);
  const normalMap = heightToNormal(h.getImageData(0, 0, SIZE, SIZE).data, 3.0);
  for (const t of [map, emissiveMap, roughnessMap, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.userData.shared = true;
    t.needsUpdate = true;
  }
  cached = { map, normalMap, emissiveMap, roughnessMap };
  return cached;
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
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

let hullMaterial: THREE.MeshStandardMaterial | null = null;

/** Shared Death Star hull material. Geometry UVs are world-space metres × HULL_UV_SCALE. */
export function getHullMaterial(): THREE.MeshStandardMaterial {
  if (hullMaterial) return hullMaterial;
  const t = getHullTextures();
  hullMaterial = new THREE.MeshStandardMaterial({
    map: t.map,
    normalMap: t.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: t.roughnessMap,
    emissiveMap: t.emissiveMap,
    emissive: new THREE.Color(1.0, 0.9, 0.75),
    roughness: 0.85,
    metalness: 0.35,
    vertexColors: true,
  });
  hullMaterial.userData.shared = true;
  return hullMaterial;
}

// 1/67: deliberately incommensurate with the 24 m architecture cells so tiling never lines up with blocks.
export const HULL_UV_SCALE = 1 / 67;
