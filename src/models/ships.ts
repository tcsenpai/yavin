import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getPanelTextures, getPlumeAlphaTexture, getSolarPanelTexture, mulberry32, type PanelStyle } from './textures';

// =====================================================================================
// Public API
// =====================================================================================

export interface ShipModel { root: THREE.Group; update(dt: number): void; dispose?(): void }

export interface XWingModel extends ShipModel {
  /** 0 = closed (wings flat, pairs overlapping), 1 = attack position (X, 13° per wing). */
  setSFoils(open01: number): void;
  /** Engine glow intensity / plume length. */
  setThrottle(t01: number): void;
  /** 4 empties at the flash-suppressor tips (children of the wings → follow the S-foils). */
  cannonMuzzles: THREE.Object3D[];
  /** 2 empties under the nose. */
  torpedoPorts: THREE.Object3D[];
  /** R2 dome behind the cockpit (rotates about Y on its own in update()). */
  astromech: THREE.Object3D;
  /** Pilot eye position for the cockpit camera. */
  cockpitAnchor: THREE.Object3D;
}

export interface GunShipModel extends ShipModel { cannonMuzzles: THREE.Object3D[]; setThrottle(t01: number): void }

export interface TowerModel {
  root: THREE.Group;
  /** Yaw about local Y. */
  turret: THREE.Object3D;
  /** Pitch about local X; barrels aim along local -Z. */
  barrels: THREE.Object3D;
  muzzles: THREE.Object3D[];
  height: number;
  radius: number;
}

// =====================================================================================
// Geometry toolkit
// =====================================================================================

type V2 = [number, number];
type V3 = [number, number, number];
type Parts = Map<string, THREE.BufferGeometry>;

const DEG = Math.PI / 180;
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _Z = new THREE.Vector3(0, 0, 1);

/** Transform matrix from position, Euler XYZ rotation and scale. */
function M(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_p.set(px, py, pz), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

const IDENT = new THREE.Matrix4();
const MX = new THREE.Matrix4().makeScale(-1, 1, 1);
const MY = new THREE.Matrix4().makeScale(1, -1, 1);
const MXY = new THREE.Matrix4().makeScale(-1, -1, 1);

/** Matrix placing a Z-aligned, origin-centred part between a and b. */
function alignM(a: V3, b: V3): { m: THREE.Matrix4; len: number } {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const d = vb.clone().sub(va);
  const len = d.length();
  d.divideScalar(len || 1);
  const q = new THREE.Quaternion().setFromUnitVectors(_Z, d);
  return { m: new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), len };
}

/** Cylinder along Z: r0 at the -Z end, r1 at the +Z end. */
function cylZ(r0: number, r1: number, len: number, seg = 16, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r1, r0, len, seg, 1, open).rotateX(Math.PI / 2);
}
function cylX(r: number, len: number, seg = 16): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2);
}
function cylY(rTop: number, rBot: number, h: number, seg = 16): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg);
}
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}
/** Octagonal prism along Y with flat faces facing ±X/±Z. */
function oct8(rTop: number, rBot: number, h: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, 8, 1).rotateY(Math.PI / 8);
}

interface Section { z: number; pts: V2[] }

/**
 * Flat-shaded loft through cross-sections (XY rings at increasing z, equal point counts,
 * convex). Ring winding is auto-detected; caps optional.
 */
function loft(sections: Section[], capStart = true, capEnd = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const n = sections[0].pts.length;
  const r0 = sections[0].pts;
  let area = 0;
  for (let j = 0; j < n; j++) {
    const a = r0[j];
    const b = r0[(j + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area >= 0;
  const tri = (a: V3, b: V3, c: V3): void => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) return;
    if (ccw) pos.push(...a, ...b, ...c);
    else pos.push(...a, ...c, ...b);
  };
  for (let i = 0; i < sections.length - 1; i++) {
    const s0 = sections[i];
    const s1 = sections[i + 1];
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a0: V3 = [s0.pts[j][0], s0.pts[j][1], s0.z];
      const b0: V3 = [s0.pts[k][0], s0.pts[k][1], s0.z];
      const a1: V3 = [s1.pts[j][0], s1.pts[j][1], s1.z];
      const b1: V3 = [s1.pts[k][0], s1.pts[k][1], s1.z];
      tri(a0, b0, b1);
      tri(a0, b1, a1);
    }
  }
  const capRing = (s: Section, front: boolean): void => {
    const p0: V3 = [s.pts[0][0], s.pts[0][1], s.z];
    for (let j = 1; j < n - 1; j++) {
      const pj: V3 = [s.pts[j][0], s.pts[j][1], s.z];
      const pk: V3 = [s.pts[j + 1][0], s.pts[j + 1][1], s.z];
      if (front) tri(p0, pk, pj);
      else tri(p0, pj, pk);
    }
  };
  if (capStart) capRing(sections[0], true);
  if (capEnd) capRing(sections[sections.length - 1], false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Prism of a convex XY polygon, extruded symmetrically along Z. */
function prism(poly: V2[], depth: number): THREE.BufferGeometry {
  return loft([{ z: -depth / 2, pts: poly }, { z: depth / 2, pts: poly }]);
}
/** Thin slab from an (x, z) polygon, thickness along Y. */
function slabXZ(poly: V2[], t: number): THREE.BufferGeometry {
  return prism(poly, t).rotateX(Math.PI / 2);
}
/** Thin slab from a (z, y) polygon, thickness along X. */
function slabYZ(poly: V2[], t: number): THREE.BufferGeometry {
  return prism(poly.map(([z, y]): V2 => [-z, y]), t).rotateY(Math.PI / 2);
}

/** Chamfered rectangle cross-section (8 pts, CCW) centred on x = cx. */
function octAt(cx: number, w: number, yt: number, yb: number, c: number): V2[] {
  const cc = Math.max(0, Math.min(c, w * 0.98, (yt - yb) * 0.49));
  return [
    [cx + w - cc, yb], [cx + w, yb + cc], [cx + w, yt - cc], [cx + w - cc, yt],
    [cx - w + cc, yt], [cx - w, yt - cc], [cx - w, yb + cc], [cx - w + cc, yb],
  ];
}
function oct(w: number, yt: number, yb: number, c: number): V2[] {
  return octAt(0, w, yt, yb, c);
}

/** Linear interpolation over keyframes [[z, a, b, ...], ...] sorted by z. */
function interpKeys(keys: number[][], z: number): number[] {
  if (z <= keys[0][0]) return keys[0].slice(1);
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (z <= k1[0]) {
      const t = (z - k0[0]) / (k1[0] - k0[0]);
      return k0.slice(1).map((v, j) => v + (k1[j + 1] - v) * t);
    }
  }
  return keys[keys.length - 1].slice(1);
}

function flipWinding(g: THREE.BufferGeometry): void {
  for (const name of ['position', 'normal']) {
    const attr = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    const a = attr.array;
    for (let i = 0; i < a.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = a[i + 3 + k];
        a[i + 3 + k] = a[i + 6 + k];
        a[i + 6 + k] = t;
      }
    }
    attr.needsUpdate = true;
  }
}

function transformGeo(g: THREE.BufferGeometry, m: THREE.Matrix4): void {
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
}

/** Per-triangle box projection: consistent texel density on every part (`tile` metres per repeat). */
function boxUV(pos: Float32Array, tile: number): Float32Array {
  const uv = new Float32Array((pos.length / 3) * 2);
  const inv = 1 / tile;
  for (let t = 0; t < pos.length; t += 9) {
    const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
    const vx = pos[t + 6] - pos[t], vy = pos[t + 7] - pos[t + 1], vz = pos[t + 8] - pos[t + 2];
    const nx = Math.abs(uy * vz - uz * vy), ny = Math.abs(uz * vx - ux * vz), nz = Math.abs(ux * vy - uy * vx);
    const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    for (let v = 0; v < 3; v++) {
      const i = t + v * 3;
      const j = (t / 3 + v) * 2;
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (axis === 0) { uv[j] = z * inv; uv[j + 1] = y * inv; }
      else if (axis === 1) { uv[j] = x * inv; uv[j + 1] = z * inv; }
      else { uv[j] = x * inv; uv[j + 1] = y * inv; }
    }
  }
  return uv;
}

/** Collects transformed parts per material slot and merges them into one geometry per slot. */
class PartBuilder {
  private readonly slots = new Map<string, THREE.BufferGeometry[]>();

  add(slot: string, geo: THREE.BufferGeometry, m?: THREE.Matrix4): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    g.clearGroups();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (m) transformGeo(g, m);
    this.push(slot, g);
    return this;
  }

  addBuilder(other: PartBuilder, m: THREE.Matrix4): this {
    for (const [slot, list] of other.slots) {
      for (const g of list) {
        const c = g.clone();
        transformGeo(c, m);
        this.push(slot, c);
      }
    }
    return this;
  }

  rod(slot: string, a: V3, b: V3, r0: number, r1 = r0, seg = 10): this {
    const { m, len } = alignM(a, b);
    return this.add(slot, cylZ(r0, r1, len, seg), m);
  }

  /** Box beam from a to b; `w` stays horizontal-ish (minimal rotation from +Z), `ext` lengthens both ends. */
  beam(slot: string, a: V3, b: V3, w: number, h: number, ext = 0): this {
    const { m, len } = alignM(a, b);
    return this.add(slot, box(w, h, len + ext * 2), m);
  }

  /**
   * Merges every slot into one geometry. Slots listed in `paint` are collapsed into a single
   * 'paint' geometry carrying a linear vertex-colour attribute (one draw call for all painted
   * hull parts, rendered with a vertexColors panel material).
   */
  finish(tile: number, paint: Record<string, THREE.ColorRepresentation> = {}): Parts {
    const groups = new Map<string, { geos: THREE.BufferGeometry[]; colors: (THREE.Color | null)[] }>();
    for (const [slot, list] of this.slots) {
      const painted = slot in paint;
      const key = painted ? 'paint' : slot;
      const color = painted ? new THREE.Color(paint[slot]) : null;
      let grp = groups.get(key);
      if (!grp) {
        grp = { geos: [], colors: [] };
        groups.set(key, grp);
      }
      for (const g of list) {
        grp.geos.push(g);
        grp.colors.push(color);
      }
    }
    const out: Parts = new Map();
    for (const [key, { geos, colors }] of groups) {
      let count = 0;
      for (const g of geos) count += g.getAttribute('position').count;
      const pos = new Float32Array(count * 3);
      const nor = new Float32Array(count * 3);
      const col = key === 'paint' ? new Float32Array(count * 3) : null;
      let o = 0;
      geos.forEach((g, i) => {
        const p = g.getAttribute('position');
        pos.set(p.array as ArrayLike<number>, o);
        nor.set(g.getAttribute('normal').array as ArrayLike<number>, o);
        const c = colors[i];
        if (col && c) {
          for (let k = o; k < o + p.count * 3; k += 3) {
            col[k] = c.r;
            col[k + 1] = c.g;
            col[k + 2] = c.b;
          }
        }
        o += p.count * 3;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(boxUV(pos, tile), 2));
      if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      out.set(key, geo);
    }
    return out;
  }

  private push(slot: string, g: THREE.BufferGeometry): void {
    let list = this.slots.get(slot);
    if (!list) {
      list = [];
      this.slots.set(slot, list);
    }
    list.push(g);
  }
}

/** Adds one static mesh per slot (geometry shared/cached, material from `mats`). */
function addParts(parent: THREE.Object3D, parts: Parts, mats: Record<string, THREE.Material>): void {
  for (const [slot, geo] of parts) {
    const mat = mats[slot];
    if (!mat) throw new Error(`ships: no material for slot "${slot}"`);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = slot;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    parent.add(mesh);
  }
}

function empty(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

// =====================================================================================
// Materials (module-level cache, shared by all instances)
// =====================================================================================

const matCache = new Map<string, THREE.Material>();

function cachedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) {
    m = make();
    matCache.set(key, m);
  }
  return m;
}

function panelMat(key: string, color: THREE.ColorRepresentation, style: PanelStyle, roughness: number, metalness: number, bumpScale = 1, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
  return cachedMat(`panel:${key}`, () => {
    const t = getPanelTextures(style);
    return new THREE.MeshStandardMaterial({ color, map: t.map, bumpMap: t.bumpMap, bumpScale, roughness, metalness, side });
  });
}

function plainMat(key: string, color: THREE.ColorRepresentation, roughness: number, metalness: number, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
  return cachedMat(`plain:${key}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness, side }));
}

/** Bright unlit material for bloom (HDR colour = color * intensity). */
function glowMat(key: string, color: THREE.ColorRepresentation, intensity: number): THREE.MeshBasicMaterial {
  return cachedMat(`glow:${key}`, () => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }));
}

/** Vertex-coloured panel material used by every 'paint' geometry (colour comes from the palette). */
function paintMat(style: PanelStyle, roughness: number, metalness: number, bumpScale = 0.8): THREE.MeshStandardMaterial {
  return cachedMat(`paint:${style}:${roughness}:${metalness}:${bumpScale}`, () => {
    const t = getPanelTextures(style);
    return new THREE.MeshStandardMaterial({ vertexColors: true, map: t.map, bumpMap: t.bumpMap, bumpScale, roughness, metalness });
  });
}

const C_DARK = 0x1a1b1e;
const C_METAL = 0x6e7176;
const C_R2_WHITE = 0xe6e7ea;
const glassMat = (): THREE.Material => cachedMat('glass', () => new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.06, metalness: 0.85, emissive: 0x020406 }));
const r2LightMat = (): THREE.Material => glowMat('r2light', 0xff3020, 3);
const impGlowMat = (): THREE.Material => glowMat('imperialCannon', 0x4dff6a, 2.6);

// =====================================================================================
// Engine glow (per-instance materials so throttle/flicker are independent per ship)
// =====================================================================================

let _plumeGeo: THREE.BufferGeometry | null = null;
let _coreGeo: THREE.BufferGeometry | null = null;
/** Open cone, base (radius 1) at z = 0, tip at z = +1. */
const plumeGeo = (): THREE.BufferGeometry => (_plumeGeo ??= new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2));
/** Unit disc facing +Z. */
const coreGeo = (): THREE.BufferGeometry => (_coreGeo ??= new THREE.CircleGeometry(1, 24));

/** `r === 0` marks a merged plume mesh (absolute radii baked in, only its length scales). */
interface Plume { mesh: THREE.Mesh; len: number; r: number }

class EngineGlow {
  readonly core: THREE.MeshBasicMaterial;
  readonly plume: THREE.MeshBasicMaterial;
  private readonly base: THREE.Color;
  private readonly plumes: Plume[] = [];
  private throttle = 0.5;
  private time = Math.random() * 100;
  private flick = 1;

  constructor(color: number, private readonly coreGain: number, private readonly plumeGain: number) {
    this.base = new THREE.Color(color);
    this.core = new THREE.MeshBasicMaterial({ color: this.base.clone() });
    this.plume = new THREE.MeshBasicMaterial({
      color: this.base.clone(),
      alphaMap: getPlumeAlphaTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.apply();
  }

  /** Glowing nozzle disc facing +Z at (x, y, z) plus an optional additive plume trailing to +Z. */
  addNozzle(parent: THREE.Object3D, x: number, y: number, z: number, radius: number, plumeLen: number): void {
    const c = new THREE.Mesh(coreGeo(), this.core);
    c.position.set(x, y, z);
    c.scale.setScalar(radius);
    parent.add(c);
    if (plumeLen > 0) {
      const p = new THREE.Mesh(plumeGeo(), this.plume);
      p.position.set(x, y, z + 0.005);
      p.renderOrder = 10;
      parent.add(p);
      this.plumes.push({ mesh: p, len: plumeLen, r: radius * 0.95 });
    }
    this.apply();
  }

  /** Arbitrary glowing mesh sharing the core material (e.g. the Falcon's engine strip). */
  addCoreMesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0): void {
    const c = new THREE.Mesh(geo, this.core);
    c.position.set(x, y, z);
    parent.add(c);
  }

  /** Pre-merged plume cones (bases at local z = 0, pointing +Z, unit length = full plume) placed at `z`. */
  addMergedPlume(parent: THREE.Object3D, geo: THREE.BufferGeometry, z: number): void {
    const p = new THREE.Mesh(geo, this.plume);
    p.position.z = z;
    p.renderOrder = 10;
    parent.add(p);
    this.plumes.push({ mesh: p, len: 1, r: 0 });
    this.apply();
  }

  setThrottle(t: number): void {
    this.throttle = Math.min(1, Math.max(0, t));
    this.apply();
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.flick = 1 + 0.05 * Math.sin(t * 31.7) + 0.035 * Math.sin(t * 73.1 + 1.3) + 0.02 * Math.sin(t * 151.3 + 0.7);
    this.apply();
  }

  dispose(): void {
    this.core.dispose();
    this.plume.dispose();
  }

  private apply(): void {
    const th = this.throttle;
    const k = (0.3 + 0.9 * th) * this.flick;
    this.core.color.copy(this.base).multiplyScalar(this.coreGain * k);
    this.plume.color.copy(this.base).multiplyScalar(this.plumeGain * k);
    const L = (0.25 + 0.95 * th) * this.flick;
    const rs = 0.85 + 0.25 * th;
    for (const p of this.plumes) {
      if (p.r === 0) p.mesh.scale.set(1, 1, L);
      else p.mesh.scale.set(p.r * rs, p.r * rs, p.len * L);
    }
  }
}

// =====================================================================================
// Shared sub-assemblies
// =====================================================================================

/** Faceted canopy: glass loft + frame cage. keys = [z, halfWidth, height] (z increasing). */
function addCanopy(b: PartBuilder, keys: number[][], baseY: (z: number) => number, frameSlot: string, ft: number): void {
  const sec = (k: number[], g = 0): V2[] => {
    const [z, wb, h] = k;
    const y0 = baseY(z);
    const w = wb + g;
    const hh = h + g;
    return [[w, y0], [w * 0.92, y0 + hh * 0.55], [w * 0.45, y0 + hh], [-w * 0.45, y0 + hh], [-w * 0.92, y0 + hh * 0.55], [-w, y0]];
  };
  b.add('glass', loft(keys.map((k) => ({ z: k[0], pts: sec(k) }))));
  const g = ft * 0.4;
  for (let i = 1; i < keys.length - 1; i++) {
    const s = sec(keys[i], g);
    for (let j = 0; j < 5; j++) {
      b.beam(frameSlot, [s[j][0], s[j][1], keys[i][0]], [s[j + 1][0], s[j + 1][1], keys[i][0]], ft, ft, ft * 0.5);
    }
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const s0 = sec(keys[i], g);
    const s1 = sec(keys[i + 1], g);
    for (const j of [1, 2, 3, 4]) {
      b.beam(frameSlot, [s0[j][0], s0[j][1], keys[i][0]], [s1[j][0], s1[j][1], keys[i + 1][0]], ft, ft);
    }
  }
}

/** Astromech dome (R2 unit), origin at the dome base centre, faces -Z. */
function buildAstromech(): PartBuilder {
  const b = new PartBuilder();
  const R = 0.26;
  b.add('r2white', new THREE.SphereGeometry(R, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2));
  b.add('metal', cylY(R + 0.004, R + 0.004, 0.08, 28), M(0, -0.03, 0));
  const front = Math.PI * 1.5;
  const panel = (phi0: number, dphi: number, th0: number, dth: number): void => {
    b.add('r2blue', new THREE.SphereGeometry(R + 0.004, 8, 4, phi0, dphi, th0, dth));
  };
  panel(front - 0.32, 0.64, 0.6, 0.42); // big front panel above the eye
  for (let k = 0; k < 6; k++) panel(front + 0.62 + k * 0.84, 0.4, 1.12, 0.38); // lower band
  for (let k = 0; k < 4; k++) panel(front + Math.PI / 4 + k * (Math.PI / 2), 0.5, 0.18, 0.22); // crown
  const sph = (phi: number, th: number, r: number): [number, number, number] => [-r * Math.cos(phi) * Math.sin(th), r * Math.cos(th), r * Math.sin(phi) * Math.sin(th)];
  const eye = sph(front, 1.0, R);
  b.add('dark', new THREE.SphereGeometry(0.052, 12, 8), M(...eye));
  const lamp = sph(front + 0.5, 1.28, R);
  b.add('r2light', new THREE.SphereGeometry(0.022, 8, 6), M(...lamp));
  return b;
}

/** TIE-style spherical cockpit front window: dark glass cap, outer ring, octagon hub and 8 spokes. */
function addTieWindow(b: PartBuilder, R: number, cz: number, ringR: number, octR: number): void {
  const zAt = (r: number, out: number): number => cz - Math.sqrt(Math.max(0, (R + out) * (R + out) - r * r));
  b.add('glass', new THREE.SphereGeometry(R + 0.012, 32, 6, 0, Math.PI * 2, 0, Math.asin(Math.min(1, (ringR + 0.02) / R))).rotateX(-Math.PI / 2), M(0, 0, cz));
  b.add('hull', new THREE.TorusGeometry(ringR, R * 0.065, 8, 40), M(0, 0, zAt(ringR, 0)));
  b.add('hull', new THREE.TorusGeometry(octR, R * 0.04, 6, 8), M(0, 0, zAt(octR, 0.02), 0, 0, Math.PI / 8));
  const w = R * 0.045;
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    const ca = Math.cos(a), sa = Math.sin(a);
    const steps = 3;
    let prev: V3 | null = null;
    for (let i = 0; i <= steps; i++) {
      const r = octR + ((ringR - octR) * i) / steps;
      const p: V3 = [r * ca, r * sa, zAt(r, 0.025)];
      if (prev) b.beam('hull', prev, p, w, w, w * 0.4);
      prev = p;
    }
  }
}

// =====================================================================================
// X-wing T-65 (Red Squadron)
// =====================================================================================

/** Fuselage keyframes: [z, halfWidth, yTop, yBottom]. Nose tip z = -7.6, tail z = +4.8. */
const XW_KEYS: number[][] = [
  [-7.6, 0.13, 0.0, -0.15],
  [-6.8, 0.22, 0.08, -0.22],
  [-5.0, 0.36, 0.22, -0.32],
  [-3.2, 0.48, 0.34, -0.4],
  [-2.2, 0.53, 0.39, -0.43],
  [-0.4, 0.56, 0.42, -0.45],
  [0.4, 0.6, 0.47, -0.47],
  [4.4, 0.62, 0.47, -0.47],
  [4.8, 0.5, 0.36, -0.38],
];
const xwP = (z: number): { w: number; yt: number; yb: number } => {
  const [w, yt, yb] = interpKeys(XW_KEYS, z);
  return { w, yt, yb };
};
const xwSec = (z: number, g = 0): V2[] => {
  const p = xwP(z);
  return oct(p.w + g, p.yt + g, p.yb - g, Math.min(p.w * 0.34, (p.yt - p.yb) * 0.3) + g * 0.4);
};

const XW_HINGE_X = 0.55;
const XW_HINGE_Y = 0.16;
const XW_WING_LEN = 4.85;
const XW_TE = 4.3;
const XW_CANNON_X = XW_WING_LEN + 0.1;
const XW_MUZZLE_Z = -3.5;
const XW_ENGINE_X = 0.55;
const XW_ENGINE_Y = 0.42;
const XW_NOZZLE_Z = 4.765;
const XW_R2_Z = 0.55;
const XW_SFOIL_ANGLE = 13 * DEG;

function buildXWingFuselage(): PartBuilder {
  const b = new PartBuilder();
  b.add('hull', loft(XW_KEYS.map((k) => ({ z: k[0], pts: xwSec(k[0]) }))));

  // red squadron nose bands + side flash
  for (const [z0, z1] of [[-6.55, -6.2], [-6.0, -5.65]]) {
    b.add('stripe', loft([{ z: z0, pts: xwSec(z0, 0.008) }, { z: z1, pts: xwSec(z1, 0.008) }]));
  }
  for (const s of [-1, 1]) {
    const p0 = xwP(-5.0);
    const p1 = xwP(-2.6);
    const ym0 = (p0.yt + p0.yb) / 2 + 0.03;
    const ym1 = (p1.yt + p1.yb) / 2 + 0.03;
    b.beam('stripe', [s * (p0.w + 0.004), ym0, -5.0], [s * (p1.w + 0.004), ym1, -2.6], 0.012, 0.09);
  }

  // nose tip sensor cap
  b.add('hullDark', loft([{ z: -7.64, pts: xwSec(-7.6, -0.03) }, { z: -7.45, pts: xwSec(-7.45, 0.004) }]));

  // canopy
  addCanopy(b, [[-2.5, 0.27, 0.0], [-1.65, 0.33, 0.33], [-0.85, 0.35, 0.42], [-0.25, 0.33, 0.37], [0.02, 0.29, 0.06]], (z) => xwP(z).yt - 0.03, 'hull', 0.035);

  // cockpit side intakes / sensor bumps
  for (const s of [-1, 1]) {
    const p = xwP(-1.4);
    b.add('hullDark', box(0.05, 0.16, 0.9), M(s * (p.w + 0.01), 0.18, -1.4));
    b.add('hullDark', box(0.05, 0.1, 0.5), M(s * (xwP(-3.6).w - 0.01), 0.05, -3.6, 0, s * 0.05, 0));
  }

  // astromech socket ring
  b.add('dark', new THREE.TorusGeometry(0.29, 0.04, 8, 28).rotateX(Math.PI / 2), M(0, xwP(XW_R2_Z).yt, XW_R2_Z));
  b.add('dark', cylY(0.27, 0.27, 0.02, 24), M(0, xwP(XW_R2_Z).yt - 0.005, XW_R2_Z));

  // torpedo launcher ports
  for (const s of [-1, 1]) {
    b.add('dark', box(0.16, 0.08, 0.36), M(s * 0.18, xwP(-2.9).yb - 0.012, -2.9));
    b.add('hullDark', box(0.24, 0.05, 0.5), M(s * 0.18, xwP(-2.9).yb + 0.005, -2.75));
  }

  // dorsal / rear detail
  b.add('hullDark', box(0.46, 0.08, 2.8), M(0, 0.49, 2.75));
  b.add('metal', box(0.16, 0.1, 0.5), M(0.16, 0.54, 1.7));
  b.add('metal', box(0.12, 0.08, 0.7), M(-0.15, 0.53, 3.4));
  b.add('hullDark', box(0.3, 0.06, 0.3), M(0, 0.55, 1.0));
  b.add('hullDark', box(0.86, 0.6, 0.06), M(0, -0.01, 4.81));
  b.add('metal', box(0.5, 0.2, 0.08), M(0, 0.05, 4.85));
  // ventral detail
  b.add('hullDark', box(0.6, 0.06, 1.6), M(0, -0.49, 1.5));
  b.add('hullDark', box(0.3, 0.05, 0.9), M(0, -0.42, -1.2));
  return b;
}

/** Top-right wing (local frame at the hinge, extends to +X, engine above). */
function buildXWingWingBase(): PartBuilder {
  const b = new PartBuilder();
  const L = XW_WING_LEN;
  const TE = XW_TE;
  const le = (x: number): number => 0.9 + ((3.05 - 0.9) * x) / L;
  b.add('hull', slabXZ([[0, le(0)], [L, le(L)], [L, TE], [0, TE]], 0.1));
  b.add('hull', slabXZ([[0, le(0) + 0.2], [1.2, le(1.2) + 0.15], [1.2, TE - 0.02], [0, TE - 0.02]], 0.16));
  for (const [x0, x1] of [[1.35, 1.6], [1.72, 1.84]]) {
    b.add('stripe', slabXZ([[x0, le(x0) + 0.006], [x1, le(x1) + 0.006], [x1, TE - 0.006], [x0, TE - 0.006]], 0.106));
  }
  // flap / control panel lines in relief
  b.add('hullDark', box(2.6, 0.112, 0.05), M(2.6, 0, TE - 0.6));

  // engine
  const EX = XW_ENGINE_X, EY = XW_ENGINE_Y;
  b.add('hull', cylZ(0.47, 0.47, 0.45, 24), M(EX, EY, 0.83));
  b.add('dark', new THREE.CircleGeometry(0.4, 24).rotateY(Math.PI), M(EX, EY, 0.6));
  b.add('metal', new THREE.ConeGeometry(0.13, 0.28, 16).rotateX(-Math.PI / 2), M(EX, EY, 0.46));
  b.add('hull', cylZ(0.43, 0.41, 3.2, 24), M(EX, EY, 2.65));
  for (const z of [1.75, 3.5]) b.add('hullDark', cylZ(0.445, 0.445, 0.12, 24), M(EX, EY, z));
  b.add('metal', cylZ(0.4, 0.34, 0.5, 24), M(EX, EY, 4.5));
  b.add('dark', cylZ(0.3, 0.3, 0.02, 20), M(EX, EY, 4.755));
  for (const a of [0.5, 1.9, 2.8]) {
    const px = EX + 0.445 * Math.cos(a);
    const py = EY + 0.445 * Math.sin(a);
    b.rod('metal', [px, py, 1.15], [px, py, 4.15], 0.035, 0.035, 8);
  }
  b.add('hullDark', box(0.5, 0.06, 2.4), M(EX + 0.05, 0.05, 2.7));

  // wingtip laser cannon
  const CX = XW_CANNON_X;
  b.add('hull', box(0.22, 0.08, TE - le(L) - 0.1), M(L, 0, (le(L) + TE) / 2));
  b.add('hull', cylZ(0.13, 0.15, 2.9, 16), M(CX, 0, 3.15));
  b.add('hullDark', new THREE.ConeGeometry(0.15, 0.3, 16).rotateX(Math.PI / 2), M(CX, 0, 4.75));
  b.add('hullDark', cylZ(0.155, 0.155, 0.08, 16), M(CX, 0, 2.2));
  b.add('metal', cylZ(0.095, 0.095, 1.2, 12), M(CX, 0, 1.1));
  b.add('metal', cylZ(0.05, 0.05, 3.3, 10), M(CX, 0, -1.15));
  b.add('hullDark', cylZ(0.075, 0.075, 0.18, 12), M(CX, 0, -0.6));
  b.add('metal', cylZ(0.085, 0.085, 0.65, 12), M(CX, 0, -3.125));
  for (const z of [-3.38, -3.12, -2.86]) b.add('hullDark', cylZ(0.105, 0.105, 0.05, 12), M(CX, 0, z));
  b.add('dark', new THREE.CircleGeometry(0.045, 10).rotateY(Math.PI), M(CX, 0, -3.455));
  return b;
}

interface XWParts { fuselage: Parts; wings: Parts[]; astromech: Parts }
let xwBuilders: { fuselage: PartBuilder; wing: PartBuilder; astromech: PartBuilder } | null = null;
const xwPartsByColor = new Map<string, XWParts>();

function getXWingParts(stripe: number, r2: number): XWParts {
  const key = `${stripe}:${r2}`;
  let parts = xwPartsByColor.get(key);
  if (parts) return parts;
  const src = (xwBuilders ??= { fuselage: buildXWingFuselage(), wing: buildXWingWingBase(), astromech: buildAstromech() });
  const palette = { hull: 0xd8d6cf, hullDark: 0x8b8a85, stripe, metal: C_METAL, dark: C_DARK };
  parts = {
    fuselage: src.fuselage.finish(3, palette),
    // order: top-right, top-left, bottom-right, bottom-left
    wings: [IDENT, MX, MY, MXY].map((m) => new PartBuilder().addBuilder(src.wing, m).finish(3, palette)),
    astromech: src.astromech.finish(3, { r2white: C_R2_WHITE, r2blue: r2, metal: C_METAL, dark: C_DARK }),
  };
  xwPartsByColor.set(key, parts);
  return parts;
}

export function createXWing(opts?: { stripeColor?: number; astromechColor?: number }): XWingModel {
  const parts = getXWingParts(opts?.stripeColor ?? 0xb0282a, opts?.astromechColor ?? 0x2a4fa8);
  const mats: Record<string, THREE.Material> = {
    paint: paintMat('fighter', 0.6, 0.15),
    glass: glassMat(),
    r2light: r2LightMat(),
  };

  const root = new THREE.Group();
  root.name = 'XWing';
  addParts(root, parts.fuselage, mats);

  const glow = new EngineGlow(0xff5a2a, 1.9, 0.9);
  const defs = [
    { mx: 1, my: 1, sign: 1 },
    { mx: -1, my: 1, sign: -1 },
    { mx: 1, my: -1, sign: -1 },
    { mx: -1, my: -1, sign: 1 },
  ];
  const wings: THREE.Group[] = [];
  const cannonMuzzles: THREE.Object3D[] = [];
  defs.forEach((d, i) => {
    const w = new THREE.Group();
    w.name = `wing_${d.my > 0 ? 'top' : 'bottom'}_${d.mx > 0 ? 'right' : 'left'}`;
    w.position.set(d.mx * XW_HINGE_X, d.my * XW_HINGE_Y, 0);
    addParts(w, parts.wings[i], mats);
    cannonMuzzles.push(empty(w, 'muzzle', d.mx * XW_CANNON_X, 0, XW_MUZZLE_Z));
    glow.addNozzle(w, d.mx * XW_ENGINE_X, d.my * XW_ENGINE_Y, XW_NOZZLE_Z, 0.3, 2.2);
    root.add(w);
    wings.push(w);
  });

  const torpedoPorts = [-1, 1].map((s) => empty(root, 'torpedoPort', s * 0.18, xwP(-3.1).yb - 0.05, -3.1));

  const astromech = new THREE.Group();
  astromech.name = 'astromech';
  astromech.position.set(0, xwP(XW_R2_Z).yt - 0.01, XW_R2_Z);
  addParts(astromech, parts.astromech, mats);
  root.add(astromech);

  const cockpitAnchor = empty(root, 'cockpitAnchor', 0, 0.66, -1.05);

  let r2Timer = 1 + Math.random() * 3;
  let r2Target = 0;
  const setSFoils = (open01: number): void => {
    const a = Math.min(1, Math.max(0, open01)) * XW_SFOIL_ANGLE;
    for (let i = 0; i < 4; i++) wings[i].rotation.z = defs[i].sign * a;
  };
  setSFoils(0);

  return {
    root,
    cannonMuzzles,
    torpedoPorts,
    astromech,
    cockpitAnchor,
    setSFoils,
    setThrottle: (t) => glow.setThrottle(t),
    update(dt: number): void {
      glow.update(dt);
      r2Timer -= dt;
      if (r2Timer <= 0) {
        r2Timer = 1.5 + Math.random() * 4;
        r2Target = (Math.random() - 0.5) * 2.6;
      }
      astromech.rotation.y += (r2Target - astromech.rotation.y) * Math.min(1, dt * 3);
    },
    dispose: () => glow.dispose(),
  };
}

// =====================================================================================
// Y-wing BTL (Gold Squadron)
// =====================================================================================

/** Cockpit module keyframes [z, halfWidth, yTop, yBottom]. */
const YW_KEYS: number[][] = [
  [-8.2, 0.3, 0.12, -0.3],
  [-7.4, 0.55, 0.38, -0.48],
  [-6.0, 0.75, 0.58, -0.6],
  [-4.2, 0.8, 0.62, -0.62],
  [-3.2, 0.78, 0.6, -0.6],
  [-2.7, 0.5, 0.42, -0.45],
];
const ywP = (z: number): { w: number; yt: number; yb: number } => {
  const [w, yt, yb] = interpKeys(YW_KEYS, z);
  return { w, yt, yb };
};
const ywSec = (z: number, g = 0): V2[] => {
  const p = ywP(z);
  return oct(p.w + g, p.yt + g, p.yb - g, Math.min(p.w * 0.34, (p.yt - p.yb) * 0.3) + g * 0.4);
};
const YW_NACELLE_X = 2.4;
const YW_NOZZLE_Z = 7.31;
const YW_MUZZLE_Z = -8.95;

function buildYWing(): PartBuilder {
  const b = new PartBuilder();
  const rng = mulberry32(4242);

  // cockpit module
  b.add('hull', loft(YW_KEYS.map((k) => ({ z: k[0], pts: ywSec(k[0]) }))));
  for (const [z0, z1] of [[-7.2, -6.9], [-6.75, -6.5]]) {
    b.add('stripe', loft([{ z: z0, pts: ywSec(z0, 0.008) }, { z: z1, pts: ywSec(z1, 0.008) }]));
  }
  b.add('stripe', box(0.5, 0.012, 1.6), M(0, ywP(-4.0).yt + 0.004, -3.6));
  addCanopy(b, [[-6.9, 0.3, 0.0], [-6.2, 0.38, 0.32], [-5.2, 0.4, 0.36], [-4.5, 0.36, 0.1]], (z) => ywP(z).yt - 0.03, 'frame', 0.04);
  for (const s of [-1, 1]) {
    b.add('frame', box(0.06, 0.3, 2.2), M(s * (ywP(-5.0).w + 0.02), 0.0, -5.0));
    // nose laser cannons
    b.add('frame', box(0.16, 0.16, 0.9), M(s * 0.24, -0.2, -7.75));
    b.add('metal', cylZ(0.05, 0.055, 1.0, 10), M(s * 0.24, -0.2, -8.45));
    b.add('dark', new THREE.CircleGeometry(0.035, 8).rotateY(Math.PI), M(s * 0.24, -0.2, -8.955));
  }
  // ion cannon turret
  const ty = ywP(-3.8).yt;
  b.add('frame', cylY(0.3, 0.34, 0.14, 16), M(0, ty + 0.05, -3.8));
  b.add('frame', new THREE.SphereGeometry(0.25, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), M(0, ty + 0.1, -3.8));
  for (const s of [-1, 1]) b.add('metal', cylZ(0.035, 0.04, 1.0, 8), M(s * 0.1, ty + 0.2, -4.4));

  // exposed neck / spine
  b.add('frame', box(0.6, 0.5, 8.4), M(0, 0, 1.4));
  const pipes: [number, number, number][] = [[0.33, 0.17, 0.06], [-0.33, 0.17, 0.06], [0.33, -0.2, 0.07], [-0.33, -0.2, 0.05], [0, 0.29, 0.07], [0.18, -0.29, 0.045]];
  for (const [x, y, r] of pipes) b.rod('metal', [x, y, -2.7], [x, y, 5.4], r, r, 8);
  for (let z = -2.2; z <= 5.2; z += 0.9) b.add('frame', box(0.82, 0.68, 0.1), M(0, 0, z));
  for (let i = 0; i < 16; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const top = rng() < 0.4;
    const w = 0.1 + rng() * 0.25, h = 0.08 + rng() * 0.2, l = 0.2 + rng() * 0.8;
    const z = -2.2 + rng() * 7.2;
    const slot = rng() < 0.5 ? 'hullDark' : 'metal';
    if (top) b.add(slot, box(w * 1.5, h, l), M((rng() - 0.5) * 0.3, 0.28 + h / 2, z));
    else b.add(slot, box(w, h * 1.5, l), M(side * (0.34 + w / 2), (rng() - 0.5) * 0.4, z));
  }
  // astromech socket behind the cockpit
  b.add('hullDark', box(0.62, 0.12, 0.62), M(0, 0.31, -2.2));
  b.addBuilder(buildAstromech(), M(0, 0.37, -2.2, 0, 0.4, 0));

  // cross wing
  b.add('hull', loft([
    { z: 0.8, pts: oct(YW_NACELLE_X, 0.12, -0.12, 0.08) },
    { z: 1.2, pts: oct(YW_NACELLE_X, 0.18, -0.18, 0.1) },
    { z: 2.4, pts: oct(YW_NACELLE_X, 0.16, -0.16, 0.1) },
  ]));
  for (const s of [-1, 1]) b.add('stripe', box(0.5, 0.37, 1.2), M(s * 1.3, 0, 1.75));

  // starboard nacelle (mirrored to port)
  const h = new PartBuilder();
  const X = YW_NACELLE_X;
  h.add('hull', new THREE.SphereGeometry(0.55, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), M(X, 0, -1.5));
  h.add('hullDark', new THREE.ConeGeometry(0.22, 0.4, 14).rotateX(-Math.PI / 2), M(X, 0, -2.12));
  h.add('hull', cylZ(0.55, 0.55, 6.6, 24), M(X, 0, 1.8));
  h.add('stripe', cylZ(0.56, 0.56, 0.4, 24), M(X, 0, -0.9));
  h.add('stripe', cylZ(0.56, 0.56, 0.14, 24), M(X, 0, -0.4));
  for (const z of [1.0, 3.5, 4.6]) h.add('hullDark', cylZ(0.57, 0.57, 0.1, 24), M(X, 0, z));
  h.add('frame', cylZ(0.5, 0.44, 1.0, 20), M(X, 0, 5.6));
  h.add('metal', cylZ(0.3, 0.3, 1.2, 16), M(X, 0, 6.7));
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    h.rod('metal', [X + 0.46 * Math.cos(a), 0.46 * Math.sin(a), 6.05], [X + 0.4 * Math.cos(a), 0.4 * Math.sin(a), 7.35], 0.04, 0.04, 6);
  }
  h.add('metal', new THREE.TorusGeometry(0.4, 0.045, 6, 20), M(X, 0, 7.35));
  h.add('dark', cylZ(0.36, 0.36, 0.06, 18), M(X, 0, 7.27));
  for (const a of [0.4, 1.4, 2.6]) {
    const px = X + 0.57 * Math.cos(a), py = 0.57 * Math.sin(a);
    h.rod('metal', [px, py, -0.1], [px, py, 4.8], 0.04, 0.04, 6);
  }
  b.addBuilder(h, IDENT);
  b.addBuilder(h, MX);
  return b;
}

let ywBuilder: PartBuilder | null = null;
const ywPartsByColor = new Map<number, Parts>();

export function createYWing(opts?: { stripeColor?: number }): GunShipModel {
  const stripe = opts?.stripeColor ?? 0xc9a227;
  let parts = ywPartsByColor.get(stripe);
  if (!parts) {
    parts = (ywBuilder ??= buildYWing()).finish(3, {
      hull: 0xcfcbbf, hullDark: 0x8a877f, frame: 0x75736d, stripe, metal: C_METAL, dark: C_DARK, r2white: C_R2_WHITE, r2blue: 0x2a4fa8,
    });
    ywPartsByColor.set(stripe, parts);
  }
  const root = new THREE.Group();
  root.name = 'YWing';
  addParts(root, parts, { paint: paintMat('freighter', 0.64, 0.18), glass: glassMat(), r2light: r2LightMat() });

  const glow = new EngineGlow(0xff5a2a, 1.8, 0.85);
  for (const s of [-1, 1]) glow.addNozzle(root, s * YW_NACELLE_X, 0, YW_NOZZLE_Z, 0.34, 2.6);
  const cannonMuzzles = [-1, 1].map((s) => empty(root, 'muzzle', s * 0.24, -0.2, YW_MUZZLE_Z));
  return {
    root,
    cannonMuzzles,
    setThrottle: (t) => glow.setThrottle(t),
    update: (dt) => glow.update(dt),
    dispose: () => glow.dispose(),
  };
}

// =====================================================================================
// TIE/ln fighter
// =====================================================================================

const TIE_R = 1.15;
const TIE_WING_X = 3.0;
const TIE_WING_R = 3.65;

function buildTIE(): Parts {
  const b = new PartBuilder();
  const R = TIE_R;
  b.add('hull', new THREE.SphereGeometry(R, 36, 24));
  addTieWindow(b, R, 0, 0.8, 0.3);
  // top hatch
  b.add('hullDark', cylY(0.42, 0.46, 0.16, 24), M(0, R - 0.03, 0));
  b.add('hull', cylY(0.22, 0.24, 0.1, 16), M(0, R + 0.08, 0));
  // rear engine panel + vents
  b.add('hullDark', cylZ(0.62, 0.55, 0.2, 24), M(0, 0, R - 0.06));
  for (const y of [-0.3, 0.3]) b.add('dark', box(0.6, 0.08, 0.04), M(0, y, R + 0.05));
  // chin cannons
  for (const s of [-1, 1]) {
    b.add('hullDark', box(0.2, 0.2, 0.42), M(s * 0.3, -0.8, -0.72));
    b.add('metal', cylZ(0.045, 0.05, 0.45, 10), M(s * 0.3, -0.8, -1.12));
    b.add('impGlow', cylZ(0.052, 0.052, 0.04, 10), M(s * 0.3, -0.8, -1.365));
  }

  // starboard pylon + wing (mirrored to port)
  const h = new PartBuilder();
  const WX = TIE_WING_X;
  h.add('hull', new THREE.CylinderGeometry(0.5, 0.3, 1.95, 16).rotateZ(-Math.PI / 2), M(1.98, 0, 0));
  h.add('hullDark', cylX(0.42, 0.16, 16), M(1.12, 0, 0));
  h.add('hullDark', cylX(0.62, 0.12, 16), M(2.62, 0, 0));
  for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const cy = Math.cos(a), cz = Math.sin(a);
    h.beam('hull', [2.1, cy * 0.35, cz * 0.35], [WX - 0.12, cy * 0.85, cz * 0.85], 0.1, 0.12);
  }
  h.add('hull', cylX(0.8, 0.38, 6), M(WX, 0, 0, Math.PI / 6));
  h.add('hullDark', cylX(0.52, 0.2, 6), M(WX + 0.26, 0, 0, Math.PI / 6));
  const hex: V2[] = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 3;
    hex.push([TIE_WING_R * Math.cos(a), TIE_WING_R * Math.sin(a)]); // (z, y)
  }
  h.add('solar', slabYZ(hex, 0.08), M(WX, 0, 0));
  for (let k = 0; k < 6; k++) {
    const p = hex[k], q = hex[(k + 1) % 6];
    h.beam('hull', [WX, p[1], p[0]], [WX, q[1], q[0]], 0.24, 0.2, 0.1);
    h.beam('hullDark', [WX, p[1] * 0.55, p[0] * 0.55], [WX, q[1] * 0.55, q[0] * 0.55], 0.13, 0.07, 0.03);
    h.beam('hull', [WX, p[1] * 0.2, p[0] * 0.2], [WX, p[1] * 0.97, p[0] * 0.97], 0.2, 0.15);
  }
  b.addBuilder(h, IDENT);
  b.addBuilder(h, MX);
  return b.finish(3, imperialPalette(0x939ba4));
}

let tieParts: Parts | null = null;

function imperialPalette(hull: number): Record<string, number> {
  return { hull, hullDark: 0x464b52, metal: C_METAL, dark: C_DARK };
}

function imperialMats(): Record<string, THREE.Material> {
  return {
    paint: paintMat('imperial', 0.5, 0.32, 0.7),
    solar: cachedMat('tie_solar', () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: getSolarPanelTexture(), roughness: 0.35, metalness: 0.45 })),
    glass: glassMat(),
    impGlow: impGlowMat(),
  };
}

export function createTIEFighter(): GunShipModel {
  const parts = (tieParts ??= buildTIE());
  const root = new THREE.Group();
  root.name = 'TIEFighter';
  addParts(root, parts, imperialMats());
  const glow = new EngineGlow(0x7dff9a, 0.66, 0);
  for (const s of [-1, 1]) glow.addNozzle(root, s * 0.22, 0, TIE_R + 0.045, 0.13, 0);
  const cannonMuzzles = [-1, 1].map((s) => empty(root, 'muzzle', s * 0.3, -0.8, -1.4));
  return {
    root,
    cannonMuzzles,
    setThrottle: (t) => glow.setThrottle(t),
    update: (dt) => glow.update(dt),
    dispose: () => glow.dispose(),
  };
}

// =====================================================================================
// TIE Advanced x1 (Vader)
// =====================================================================================

const TA_R = 1.0;
const TA_CZ = -2.6;
const TA_WING_X = 3.0;

function buildTIEAdvanced(): Parts {
  const b = new PartBuilder();
  const R = TA_R, CZ = TA_CZ;
  b.add('hull', new THREE.SphereGeometry(R, 32, 22), M(0, 0, CZ));
  addTieWindow(b, R, CZ, 0.66, 0.24);
  b.add('hullDark', cylY(0.36, 0.4, 0.14, 20), M(0, R - 0.03, CZ));
  // elongated rear hull
  b.add('hull', loft([
    { z: -2.4, pts: oct(0.55, 0.55, -0.55, 0.2) },
    { z: -1.0, pts: oct(0.82, 0.66, -0.64, 0.26) },
    { z: 2.6, pts: oct(0.98, 0.62, -0.62, 0.3) },
    { z: 4.7, pts: oct(1.08, 0.52, -0.56, 0.28) },
    { z: 5.35, pts: oct(0.92, 0.4, -0.44, 0.2) },
  ]));
  b.add('hullDark', box(1.25, 0.66, 0.06), M(0, -0.02, 5.37));
  for (const s of [-1, 1]) b.add('dark', cylZ(0.26, 0.26, 0.06, 18), M(s * 0.42, -0.02, 5.39));
  b.add('hullDark', box(0.5, 0.12, 4.0), M(0, 0.66, 1.4));
  b.add('hullDark', box(0.6, 0.1, 3.0), M(0, -0.66, 1.8));
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) b.add('dark', box(0.04, 0.32, 0.5), M(s * 1.0, 0, 2.9 + i * 0.6, 0, 0, 0));
    // twin laser cannons below the window
    b.add('hullDark', box(0.18, 0.18, 0.5), M(s * 0.36, -0.66, CZ - 0.55));
    b.add('metal', cylZ(0.04, 0.045, 0.6, 10), M(s * 0.36, -0.66, CZ - 1.1));
    b.add('impGlow', cylZ(0.048, 0.048, 0.04, 10), M(s * 0.36, -0.66, CZ - 1.42));
  }

  // starboard pylon + bent wing
  const h = new PartBuilder();
  const WX = TA_WING_X;
  h.add('hull', box(WX - 0.85, 0.36, 1.8), M((WX + 0.85) / 2, 0, 0.6));
  h.add('hullDark', cylX(0.32, WX - 0.9, 12), M((WX + 0.9) / 2, 0, 0.6));
  h.add('hull', cylX(0.62, 0.32, 6), M(WX, 0, 0.6, Math.PI / 6));
  const center: V2[] = [[-2.7, 0], [-2.0, 1.15], [2.7, 1.15], [3.0, 0], [2.7, -1.15], [-2.0, -1.15]];
  h.add('solar', slabYZ(center, 0.08), M(WX, 0, 0));
  for (let k = 0; k < center.length; k++) {
    const p = center[k], q = center[(k + 1) % center.length];
    h.beam('hull', [WX, p[1], p[0]], [WX, q[1], q[0]], 0.2, 0.16, 0.08);
  }
  h.beam('hull', [WX, 0, -2.6], [WX, 0, 2.9], 0.18, 0.14);
  for (const z of [-1.0, 1.4]) h.beam('hullDark', [WX, -1.15, z], [WX, 1.15, z], 0.14, 0.08);

  const L = 2.2;
  const seg = new PartBuilder();
  const segPoly: V2[] = [[-2.0, 0], [2.7, 0], [2.0, L], [-0.4, L]];
  seg.add('solar', slabYZ(segPoly, 0.08));
  for (let k = 0; k < segPoly.length; k++) {
    const p = segPoly[k], q = segPoly[(k + 1) % segPoly.length];
    seg.beam('hull', [0, p[1], p[0]], [0, q[1], q[0]], 0.2, 0.16, 0.08);
  }
  seg.beam('hullDark', [0, 0, 0.4], [0, L, 0.8], 0.14, 0.08);
  h.addBuilder(seg, new THREE.Matrix4().makeTranslation(WX, 1.15, 0).multiply(new THREE.Matrix4().makeRotationZ(30 * DEG)));
  h.addBuilder(seg, new THREE.Matrix4().makeTranslation(WX, -1.15, 0).multiply(new THREE.Matrix4().makeRotationZ(-30 * DEG)).multiply(MY));
  b.addBuilder(h, IDENT);
  b.addBuilder(h, MX);
  return b.finish(3, imperialPalette(0x7d838a));
}

let taParts: Parts | null = null;

export function createTIEAdvanced(): GunShipModel {
  const parts = (taParts ??= buildTIEAdvanced());
  const root = new THREE.Group();
  root.name = 'TIEAdvanced';
  addParts(root, parts, imperialMats());
  const glow = new EngineGlow(0x7dff9a, 0.8, 0.3);
  for (const s of [-1, 1]) glow.addNozzle(root, s * 0.42, -0.02, 5.425, 0.22, 0.9);
  const cannonMuzzles = [-1, 1].map((s) => empty(root, 'muzzle', s * 0.36, -0.66, TA_CZ - 1.47));
  return {
    root,
    cannonMuzzles,
    setThrottle: (t) => glow.setThrottle(t),
    update: (dt) => glow.update(dt),
    dispose: () => glow.dispose(),
  };
}

// =====================================================================================
// YT-1300 Millennium Falcon
// =====================================================================================

const FAL_CZ = 2.5;
/** Disk half-profile (r, y), bottom → top. */
const FAL_PROFILE: V2[] = [[0, -2.3], [3.0, -2.25], [3.4, -1.95], [11.0, -1.0], [12.6, -0.55], [12.9, 0], [12.6, 0.55], [11.0, 1.0], [3.4, 1.95], [3.0, 2.25], [0, 2.3]];
const FAL_TOP: number[][] = [[0, 2.3], [3.0, 2.25], [3.4, 1.95], [11.0, 1.0], [12.6, 0.55], [12.9, 0]];
const falTopY = (r: number): number => interpKeys(FAL_TOP, r)[0];

let _falStrip: THREE.BufferGeometry | null = null;
const falStripGeo = (): THREE.BufferGeometry => (_falStrip ??= new THREE.CylinderGeometry(12.95, 12.95, 0.5, 64, 1, true, -1.05, 2.1));

function buildFalcon(): Parts {
  const b = new PartBuilder();
  const rng = mulberry32(1977);

  // saucer: one lathe band per profile segment → crisp creases
  for (let i = 0; i < FAL_PROFILE.length - 1; i++) {
    const pts = [FAL_PROFILE[i], FAL_PROFILE[i + 1]].map(([r, y]) => new THREE.Vector2(r, y));
    b.add('hull', new THREE.LatheGeometry(pts, 72), M(0, 0, FAL_CZ));
  }
  // engine strip housing + dividers
  for (const y of [-0.31, 0.31]) b.add('dark', new THREE.CylinderGeometry(13.0, 13.0, 0.12, 64, 1, true, -1.1, 2.2), M(0, y, FAL_CZ));
  for (let k = 0; k <= 12; k++) {
    const th = -1.05 + (k * 2.1) / 12;
    b.add('hullDark', box(0.14, 0.62, 0.3), M(12.95 * Math.sin(th), 0, FAL_CZ + 12.95 * Math.cos(th), 0, th, 0));
  }
  // docking rings port/starboard
  for (const s of [-1, 1]) {
    b.add('hullDark', cylX(1.0, 0.7, 20), M(s * 12.75, 0, FAL_CZ));
    b.add('dark', cylX(0.6, 0.72, 16), M(s * 12.8, 0, FAL_CZ));
  }
  // forward hold recess between the mandibles
  b.add('dark', box(3.0, 1.1, 0.6), M(0, 0, -10.2));

  // mandibles (starboard built, mirrored)
  const mh = new PartBuilder();
  mh.add('hull', loft([
    { z: -19.6, pts: octAt(3.35, 1.6, 0.5, -0.6, 0.25) },
    { z: -17.0, pts: octAt(3.45, 1.85, 0.85, -0.9, 0.35) },
    { z: -7.5, pts: octAt(3.6, 2.0, 1.15, -1.2, 0.4) },
  ]));
  mh.add('hullDark', box(0.8, 0.16, 7.5), M(3.9, 1.0, -12.5));
  mh.add('hullDark', box(0.5, 0.5, 0.3), M(3.3, 0.0, -19.65));
  mh.add('dark', box(0.08, 0.5, 6.0), M(5.48, 0.0, -12.0));
  for (let i = 0; i < 6; i++) mh.add('hullDark', box(0.3, 0.25 + rng() * 0.3, 0.5 + rng() * 1.2), M(5.5, (rng() - 0.5) * 1.0, -17 + i * 1.6));
  b.addBuilder(mh, IDENT);
  b.addBuilder(mh, MX);

  // starboard cockpit: corridor + pod with conical canopy
  const cx = 11.8, cy = 0.3;
  b.rod('hull', [6.5, 0.1, -1.0], [cx - 0.2, cy, -6.4], 0.95, 0.95, 16);
  b.add('hull', new THREE.SphereGeometry(1.3, 20, 14), M(cx, cy, -6.3));
  b.add('hull', cylZ(1.3, 1.3, 2.6, 24), M(cx, cy, -7.6));
  b.add('hull', cylZ(1.22, 1.3, 0.6, 24), M(cx, cy, -9.2));
  b.add('glass', cylZ(0.85, 1.22, 1.5, 24), M(cx, cy, -10.25));
  b.add('hull', new THREE.TorusGeometry(1.24, 0.07, 8, 24), M(cx, cy, -9.5));
  b.add('hull', new THREE.TorusGeometry(0.85, 0.08, 8, 24), M(cx, cy, -11.0));
  b.add('glass', new THREE.CircleGeometry(0.85, 24).rotateY(Math.PI), M(cx, cy, -11.0));
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    b.beam('hull', [cx + 1.25 * Math.cos(a), cy + 1.25 * Math.sin(a), -9.5], [cx + 0.88 * Math.cos(a), cy + 0.88 * Math.sin(a), -11.0], 0.08, 0.08);
  }
  b.add('hullDark', box(0.6, 0.3, 2.0), M(cx, cy + 1.25, -7.5));

  // rectenna dish (port forward)
  const dx = -5.6, dz = -3.2;
  const dy = falTopY(Math.hypot(dx, dz - FAL_CZ));
  b.add('hullDark', cylY(0.3, 0.45, 0.9, 12), M(dx, dy + 0.35, dz));
  const dish = new THREE.LatheGeometry([[0, -0.05], [1.6, 0.4], [1.68, 0.46], [1.64, 0.52], [0, 0.08]].map(([r, y]) => new THREE.Vector2(r, y)), 32);
  b.add('hullDS', dish, M(dx, dy + 0.85, dz, -0.6, 0, 0));
  b.rod('metal', [dx, dy + 0.9, dz], [dx, dy + 0.9 + 0.65 * Math.cos(0.6), dz - 0.65 * Math.sin(0.6)], 0.05, 0.03, 6);

  // quad laser turrets (top built, mirrored to bottom)
  const t = new PartBuilder();
  t.add('hullDark', cylY(1.5, 1.7, 0.3, 24), M(0, 2.4, FAL_CZ));
  t.add('hull', new THREE.SphereGeometry(1.05, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 2.5, FAL_CZ));
  t.add('glass', new THREE.SphereGeometry(1.07, 16, 6, Math.PI * 1.5 - 0.5, 1.0, 0.45, 0.6), M(0, 2.5, FAL_CZ));
  for (const s of [-1, 1]) {
    t.add('hullDark', box(0.45, 0.5, 1.4), M(s * 1.15, 2.85, FAL_CZ - 0.2));
    for (const k of [-1, 1]) t.add('metal', cylZ(0.07, 0.08, 2.2, 8), M(s * 1.15, 2.85 + k * 0.14, FAL_CZ - 2.0));
  }
  b.addBuilder(t, IDENT);
  b.addBuilder(t, MY);

  // surface greebles (top + bottom)
  const greebles = (count: number): PartBuilder => {
    const g = new PartBuilder();
    for (let i = 0; i < count; i++) {
      const r = 3.8 + rng() * 8.0;
      const th = rng() * Math.PI * 2;
      const x = r * Math.sin(th), z = FAL_CZ + r * Math.cos(th);
      if (Math.hypot(x - dx, z - dz) < 2.6) continue;
      const w = 0.25 + rng() * 0.8, l = 0.3 + rng() * 1.3, hh = 0.08 + rng() * 0.25;
      const y = falTopY(r);
      const slope = (falTopY(r + 0.1) - falTopY(r - 0.1)) / 0.2;
      const m = new THREE.Matrix4().makeRotationY(th).multiply(new THREE.Matrix4().makeRotationX(Math.atan(-slope)));
      m.setPosition(x, y + hh / 2 - 0.08, z);
      g.add(rng() < 0.6 ? 'hullDark' : 'hull', box(w, hh, l), m);
    }
    return g;
  };
  b.addBuilder(greebles(90), IDENT);
  b.addBuilder(greebles(45), MY);
  // rear engine deck ribs
  for (let k = 0; k < 15; k++) {
    const th = -0.9 + (k * 1.8) / 14;
    const p = (r: number): V3 => [r * Math.sin(th), falTopY(r) + 0.06, FAL_CZ + r * Math.cos(th)];
    b.beam('hullDark', p(8.0), p(11.0), 0.22, 0.14);
    b.beam('hullDark', p(11.0), p(12.4), 0.22, 0.14);
  }
  return b.finish(8, { hull: 0xb5b1a7, hullDark: 0x6d6a64, metal: C_METAL, dark: C_DARK });
}

let falParts: Parts | null = null;

export function createFalcon(): GunShipModel {
  const parts = (falParts ??= buildFalcon());
  const mats: Record<string, THREE.Material> = {
    paint: paintMat('freighter', 0.7, 0.18, 1),
    hullDS: panelMat('fal_hull_ds', 0xb5b1a7, 'freighter', 0.7, 0.15, 1, THREE.DoubleSide),
    glass: glassMat(),
  };
  const root = new THREE.Group();
  root.name = 'MillenniumFalcon';
  addParts(root, parts, mats);
  const glow = new EngineGlow(0xa8d4ff, 1.7, 0);
  glow.addCoreMesh(root, falStripGeo(), 0, 0, FAL_CZ);
  const cannonMuzzles: THREE.Object3D[] = [];
  for (const s of [-1, 1]) for (const k of [-1, 1]) cannonMuzzles.push(empty(root, 'muzzle', s * 1.15, 2.85 + k * 0.14, FAL_CZ - 3.15));
  return {
    root,
    cannonMuzzles,
    setThrottle: (t) => glow.setThrottle(t),
    update: (dt) => glow.update(dt),
    dispose: () => glow.dispose(),
  };
}

// =====================================================================================
// Death Star structures
// =====================================================================================

const DS_PALETTE: Record<string, number> = { ds: 0x8e9195, dsDark: 0x595c60, metal: C_METAL, dark: C_DARK };

function deathStarMats(): Record<string, THREE.Material> {
  return {
    paint: paintMat('deathstar', 0.78, 0.22, 1),
    light: glowMat('ds_window', 0xffd9a0, 1.4),
  };
}

interface TowerParts {
  base: Parts;
  turret: Parts;
  barrels: Parts;
  turretY: number;
  pivot: V3;
  muzzles: V3[];
  height: number;
  radius: number;
}

function buildTower(variant: number): TowerParts {
  const rng = mulberry32(variant * 7919 + 101);
  const total = 25 + rng() * 20;
  const s = 0.85 + ((total - 25) / 20) * 0.35;
  const headH = 4.4 * s;
  const H = total - headH;
  const Rb = 6 + rng() * 2.5;
  const b = new PartBuilder();

  b.add('ds', oct8(Rb * 1.2, Rb * 1.3, 1.6), M(0, 0.8, 0));
  const tiers = 3 + Math.floor(rng() * 3);
  const weights: number[] = [];
  for (let i = 0; i < tiers; i++) weights.push(0.7 + rng() * 0.6);
  const wsum = weights.reduce((a, v) => a + v, 0);
  const avail = H - 1.6 - 0.8;
  const topR = Rb * (0.55 + rng() * 0.15);
  let y = 1.6;
  let r = Rb;
  const apo = Math.cos(Math.PI / 8);
  for (let i = 0; i < tiers; i++) {
    const h = (avail * weights[i]) / wsum;
    const r1 = Rb + (topR - Rb) * ((i + 1) / tiers);
    b.add('ds', oct8(r1, r, h), M(0, y + h / 2, 0));
    b.add('dsDark', oct8(r1 * 1.12, r1 * 1.12, 0.45), M(0, y + h - 0.1, 0));
    const ribs = rng() < 0.6;
    for (let k = 0; k < 8; k++) {
      // vertices of the rotated octagon sit at θ = π/8 + kπ/4 (x = r sinθ, z = r cosθ)
      const tv = Math.PI / 8 + (k * Math.PI) / 4;
      if (ribs) b.beam('dsDark', [r * Math.sin(tv), y, r * Math.cos(tv)], [r1 * Math.sin(tv), y + h - 0.2, r1 * Math.cos(tv)], 0.6, 0.6);
      // face centres sit at θ = kπ/4
      const tf = (k * Math.PI) / 4;
      const fw = 2 * ((r + r1) / 2) * Math.sin(Math.PI / 8);
      const lean = Math.atan2(r - r1, h);
      // matrix for a detail lying on this face at height fy, `off` metres along the face, `out` metres proud
      const onFace = (fy: number, off: number, out: number): THREE.Matrix4 => {
        const rr = (r + (r1 - r) * ((fy - y) / h)) * apo + out;
        return new THREE.Matrix4().makeRotationY(tf).multiply(new THREE.Matrix4().makeRotationX(-lean))
          .setPosition(rr * Math.sin(tf) + off * Math.cos(tf), fy, rr * Math.cos(tf) - off * Math.sin(tf));
      };
      if (rng() < 0.75) {
        const fy = y + h * 0.55;
        b.add('dark', box(fw * 0.7, 0.4, 0.12), onFace(fy, 0, 0));
        if (rng() < 0.5) b.add('dark', box(fw * 0.5, 0.3, 0.12), onFace(y + h * 0.3, 0, 0));
        for (let wv = 0; wv < 3; wv++) {
          if (rng() < 0.35) b.add('light', box(0.35, 0.22, 0.08), onFace(fy, (rng() - 0.5) * fw * 0.5, 0.04));
        }
      }
      if (rng() < 0.4) {
        const gw = 0.8 + rng() * 1.6, gh = 0.6 + rng() * 1.6;
        b.add('dsDark', box(gw, gh, 0.6), onFace(y + h * (0.15 + rng() * 0.6), 0, 0));
      }
    }
    y += h;
    r = r1;
  }
  b.add('dsDark', oct8(r * 1.05, r * 1.15, 0.8), M(0, H - 0.4, 0));

  // turret (yaw), origin at the top deck
  const t = new PartBuilder();
  t.add('ds', cylY(3.0 * s, 3.4 * s, 1.0 * s, 16), M(0, 0.5 * s, 0));
  t.add('ds', loft([
    { z: -2.8 * s, pts: oct(2.0 * s, 2.6 * s, 1.0 * s, 0.4 * s) },
    { z: -1.6 * s, pts: oct(2.6 * s, 4.2 * s, 0.9 * s, 0.6 * s) },
    { z: 2.6 * s, pts: oct(2.6 * s, 4.4 * s, 0.9 * s, 0.6 * s) },
    { z: 3.4 * s, pts: oct(2.0 * s, 3.4 * s, 1.0 * s, 0.4 * s) },
  ]));
  t.add('dsDark', box(1.6 * s, 0.4 * s, 2.4 * s), M(0, 4.5 * s, 0.8 * s));
  t.add('dsDark', box(0.6 * s, 0.9 * s, 0.6 * s), M(1.2 * s, 4.7 * s, 1.9 * s));
  for (const sx of [-1, 1]) {
    t.add('dsDark', box(0.3 * s, 1.6 * s, 3.0 * s), M(sx * 2.68 * s, 2.6 * s, 0.6 * s));
    t.add('dark', box(0.08 * s, 0.3 * s, 2.0 * s), M(sx * 2.62 * s, 3.6 * s, 0.6 * s));
  }

  // barrels (pitch), origin at the trunnion
  const pv: V3 = [0, 2.6 * s, -1.8 * s];
  const br = new PartBuilder();
  br.add('dsDark', cylX(1.0 * s, 3.4 * s, 16));
  const muzzles: V3[] = [];
  for (const sx of [-1.1 * s, 1.1 * s]) {
    br.add('ds', cylZ(0.55 * s, 0.6 * s, 2.4 * s, 16), M(sx, 0, -1.2 * s));
    br.add('metal', cylZ(0.28 * s, 0.32 * s, 6.0 * s, 14), M(sx, 0, -5.4 * s));
    br.add('dsDark', cylZ(0.42 * s, 0.42 * s, 0.9 * s, 14), M(sx, 0, -8.85 * s));
    for (const z of [-3.2, -4.6]) br.add('dsDark', cylZ(0.36 * s, 0.36 * s, 0.2 * s, 14), M(sx, 0, z * s));
    br.add('dark', new THREE.CircleGeometry(0.25 * s, 12).rotateY(Math.PI), M(sx, 0, -9.31 * s));
    muzzles.push([sx, 0, -9.35 * s]);
  }
  return {
    base: b.finish(10, DS_PALETTE),
    turret: t.finish(10, DS_PALETTE),
    barrels: br.finish(10, DS_PALETTE),
    turretY: H,
    pivot: pv,
    muzzles,
    height: total,
    radius: Rb * 1.3,
  };
}

const TOWER_VARIANTS = 32;
const towerCache = new Map<number, TowerParts>();

function assembleTower(tp: TowerParts, name: string): TowerModel {
  const mats = deathStarMats();
  const root = new THREE.Group();
  root.name = name;
  addParts(root, tp.base, mats);
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.position.y = tp.turretY;
  addParts(turret, tp.turret, mats);
  root.add(turret);
  const barrels = new THREE.Group();
  barrels.name = 'barrels';
  barrels.position.set(...tp.pivot);
  addParts(barrels, tp.barrels, mats);
  turret.add(barrels);
  const muzzles = tp.muzzles.map((p) => empty(barrels, 'muzzle', ...p));
  return { root, turret, barrels, muzzles, height: tp.height, radius: tp.radius };
}

export function createTurbolaserTower(seed: number): TowerModel {
  const v = ((Math.floor(seed) % TOWER_VARIANTS) + TOWER_VARIANTS) % TOWER_VARIANTS;
  let tp = towerCache.get(v);
  if (!tp) {
    tp = buildTower(v);
    towerCache.set(v, tp);
  }
  return assembleTower(tp, 'TurbolaserTower');
}

let wallTurretParts: TowerParts | null = null;

function buildWallTurret(): TowerParts {
  const b = new PartBuilder();
  b.add('ds', box(4.2, 0.8, 4.2), M(0, 0.4, 0));
  b.add('dsDark', box(3.4, 0.3, 3.4), M(0, 0.95, 0));
  b.add('dsDark', cylY(1.3, 1.6, 1.8, 12), M(0, 1.7, 0));
  for (const [x, z] of [[1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7]] as V2[]) b.add('dark', box(0.3, 0.15, 0.3), M(x, 0.85, z));

  const t = new PartBuilder();
  t.add('ds', cylY(1.6, 1.7, 0.4, 16), M(0, 0.2, 0));
  t.add('ds', loft([
    { z: -1.6, pts: oct(1.2, 1.9, 0.4, 0.3) },
    { z: -0.6, pts: oct(1.5, 2.9, 0.3, 0.4) },
    { z: 1.6, pts: oct(1.5, 3.1, 0.3, 0.4) },
    { z: 2.0, pts: oct(1.2, 2.4, 0.4, 0.3) },
  ]));
  t.add('dsDark', box(0.8, 0.3, 1.2), M(0, 3.2, 0.5));
  t.add('dark', box(1.0, 0.25, 0.06), M(0, 2.3, -1.45, -0.6, 0, 0));

  const pv: V3 = [0, 1.6, -1.0];
  const br = new PartBuilder();
  br.add('dsDark', cylX(0.5, 1.7, 12));
  const muzzles: V3[] = [];
  for (const sx of [-0.55, 0.55]) {
    br.add('ds', cylZ(0.25, 0.28, 1.0, 12), M(sx, 0, -0.5));
    br.add('metal', cylZ(0.12, 0.14, 2.6, 10), M(sx, 0, -2.3));
    br.add('dsDark', cylZ(0.18, 0.18, 0.35, 10), M(sx, 0, -3.75));
    br.add('dark', new THREE.CircleGeometry(0.1, 10).rotateY(Math.PI), M(sx, 0, -3.93));
    muzzles.push([sx, 0, -3.95]);
  }
  return { base: b.finish(6, DS_PALETTE), turret: t.finish(6, DS_PALETTE), barrels: br.finish(6, DS_PALETTE), turretY: 2.6, pivot: pv, muzzles, height: 6.0, radius: 3.0 };
}

export function createWallTurret(): TowerModel {
  return assembleTower((wallTurretParts ??= buildWallTurret()), 'WallTurret');
}

let exhaustParts: Parts | null = null;

function buildExhaustPort(): Parts {
  const b = new PartBuilder();
  // square housing frame (outer 12 m, raised rim)
  const half = 6, inner = 4.5, rimH = 0.8;
  const fw = half - inner;
  for (const s of [-1, 1]) {
    b.add('ds', box(half * 2, rimH, fw), M(0, 0, s * (inner + fw / 2)));
    b.add('ds', box(fw, rimH, inner * 2), M(s * (inner + fw / 2), 0, 0));
    b.add('dsDark', box(half * 2 + 0.2, 0.2, 0.3), M(0, rimH / 2 + 0.1, s * (half - 0.15)));
    b.add('dsDark', box(0.3, 0.2, half * 2), M(s * (half - 0.15), rimH / 2 + 0.1, 0));
  }
  // inner floor plate with a circular cut-out
  const shape = new THREE.Shape();
  shape.moveTo(-inner, -inner);
  shape.lineTo(inner, -inner);
  shape.lineTo(inner, inner);
  shape.lineTo(-inner, inner);
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 3.2, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  b.add('dsDS', new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false, curveSegments: 48 }).rotateX(-Math.PI / 2), M(0, -0.6, 0));
  // stepped concentric rings down to the 2 m port
  const steps: V2[] = [[3.2, -0.3], [2.6, -0.3], [2.6, -0.75], [2.0, -0.75], [2.0, -1.2], [1.0, -1.2], [1.0, -8.0]];
  b.add('dsDS', new THREE.LatheGeometry(steps.slice(0, 6).map(([r, y]) => new THREE.Vector2(r, y)), 64));
  b.add('darkDS', new THREE.LatheGeometry(steps.slice(5).map(([r, y]) => new THREE.Vector2(r, y)), 32));
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 + Math.PI / 8;
    b.add('dsDark', box(0.4, 0.25, 0.7), M(2.9 * Math.sin(a), -0.2, 2.9 * Math.cos(a), 0, a, 0));
  }
  for (const [x, z] of [[3.6, 3.6], [-3.6, 3.6], [3.6, -3.6], [-3.6, -3.6]] as V2[]) b.add('dsDark', cylY(0.35, 0.4, 0.4, 8), M(x, -0.15, z));
  b.add('glow', new THREE.CircleGeometry(1.0, 32).rotateX(-Math.PI / 2), M(0, -7.9, 0));
  return b.finish(6, DS_PALETTE);
}

export function createExhaustPort(): THREE.Group {
  const parts = (exhaustParts ??= buildExhaustPort());
  const mats: Record<string, THREE.Material> = {
    paint: paintMat('deathstar', 0.78, 0.22, 1),
    dsDS: panelMat('ds_ds', 0x8e9195, 'deathstar', 0.78, 0.2, 1, THREE.DoubleSide),
    darkDS: plainMat('dark_ds', 0x0b0b0d, 0.9, 0.2, THREE.DoubleSide),
    glow: glowMat('exhaust_core', 0xff6a30, 0.9),
  };
  const root = new THREE.Group();
  root.name = 'ExhaustPort';
  addParts(root, parts, mats);
  return root;
}

// =====================================================================================
// Imperial I-class Star Destroyer
// =====================================================================================

export interface CapitalSubsystem {
  kind: 'shieldGen' | 'bridge' | 'turbolaser' | 'hangar';
  /** Empty at the subsystem centre (child of root, so it moves with the ship). */
  anchor: THREE.Object3D;
  /** Hit-sphere radius (m). */
  radius: number;
  /** Turbolasers: barrel-tip empties (children of the anchor, barrels aim along anchor -Z). Empty otherwise. */
  muzzles: THREE.Object3D[];
  /** Swap to a scorched/destroyed look (idempotent). */
  setDestroyed(): void;
}

export interface StarDestroyerModel {
  root: THREE.Group;
  subsystems: CapitalSubsystem[];
  /** Coarse collision volumes in LOCAL space (wedge hull slices + superstructure). */
  colliders: THREE.Box3[];
  setThrottle(t01: number): void;
  update(dt: number): void;
}

const SD_HALF_L = 800;
/** Engine nozzle exit plane (all 7 nozzles end here so one merged plume mesh can scale in z). */
const SD_NOZZLE_Z = 880;
/** Ziggurat tiers: [zStart, halfWidth, topY]; every tier runs back to z = 790. */
const SD_TIERS: V3[] = [[-60, 165, 55], [60, 140, 82], [170, 115, 108], [280, 92, 132], [380, 72, 155]];
const SD_HANGAR_Z = 240;
const SD_DOME_Y = 298;
const SD_DOME_X = 100;
const SD_BRIDGE_Z = 626;
const SD_PALETTE: Record<string, number> = { hull: 0xb4b8bd, hullDark: 0x7c8187, dark: C_DARK, metal: C_METAL };

/**
 * Wedge dimensions at z. Every dimension is linear in s (0 at the nose tip, 1 at the stern), so the
 * hull is an exact pyramid: w half-beam, t trench half-height, d trench depth, hT dorsal ridge, hB keel.
 */
function sdDims(z: number): { w: number; t: number; d: number; hT: number; hB: number } {
  const s = (z + SD_HALF_L) / (2 * SD_HALF_L);
  return { w: 450 * s, t: 14 * s, d: 16 * s, hT: 95 * s, hB: 80 * s };
}

/** Dorsal surface height at |x| = ax. */
function sdTopY(ax: number, z: number): number {
  const { w, t, hT } = sdDims(z);
  return ax <= 0.05 * w ? hT : t + ((hT - t) * (w - ax)) / (0.95 * w);
}

/** Hull cross-section (CCW in XY) with the lateral trench notch on both sides. */
function sdRing(z: number): V2[] {
  const { w, t, d, hT, hB } = sdDims(z);
  return [
    [w, -t], [w - d, -t], [w - d, t], [w, t], [0.05 * w, hT], [-0.05 * w, hT],
    [-w, t], [-w + d, t], [-w + d, -t], [-w, -t], [-0.35 * w, -hB], [0.35 * w, -hB],
  ];
}

/** Half-width of the ziggurat covering the centreline at z (0 ahead of it). */
function sdCoverHW(z: number): number {
  let hw = 0;
  for (const [zs, w] of SD_TIERS) if (z >= zs) hw = Math.max(hw, w);
  return hw;
}

interface SDParts {
  hull: Parts;
  bridge: Parts;
  hangarLight: Parts;
  turret: THREE.BufferGeometry;
  dome: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
  plume: THREE.BufferGeometry;
  turrets: V3[];
  colliders: THREE.Box3[];
}

const SD_VARIANTS = 8;
const sdCache = new Map<number, SDParts>();

function buildStarDestroyer(variant: number): SDParts {
  const rng = mulberry32(variant * 104729 + 1977);
  const b = new PartBuilder();
  /** Starboard-side details, mirrored to port. */
  const h = new PartBuilder();
  const flatPlane = (w: number, ht: number): THREE.BufferGeometry => new THREE.PlaneGeometry(w, ht);

  // --- wedge hull ---------------------------------------------------------------------
  const zs = [-800, -400, 0, 400, 800];
  b.add('hull', loft(zs.map((z) => ({ z, pts: sdRing(z) })), false, false));
  const stern = new THREE.Shape(sdRing(SD_HALF_L).map(([x, y]) => new THREE.Vector2(x, y)));
  b.add('hullDark', new THREE.ShapeGeometry(stern), M(0, 0, SD_HALF_L));
  // central dorsal spine (nose → ziggurat)
  const spine = (z: number): V2[] => {
    const { w, hT } = sdDims(z);
    const s = w / 450;
    return [[0.035 * w, hT - 2 * s], [0.03 * w, hT + 8 * s], [-0.03 * w, hT + 8 * s], [-0.035 * w, hT - 2 * s]];
  };
  b.add('hull', loft([{ z: -800, pts: spine(-800) }, { z: -40, pts: spine(-40) }]));
  // longitudinal panel seams on the dorsal faces
  for (const f of [0.32, 0.58, 0.84]) {
    const p = (z: number): V3 => [f * sdDims(z).w, sdTopY(f * sdDims(z).w, z) + 0.3, z];
    h.beam('hullDark', p(-640), p(790), 2.5, 0.9);
  }

  // --- stepped superstructure ---------------------------------------------------------
  for (const [z0, hw, top] of SD_TIERS) {
    b.add('hull', box(hw * 2, top, 790 - z0), M(0, top / 2, (z0 + 790) / 2));
    b.add('hullDark', box(hw * 2 + 4, 3, 6), M(0, top - 1, z0 + 3));
    for (let x = 4; x < hw - 4; x += 7) {
      for (const y of [top - 4.5, top - 9]) if (rng() < 0.55) h.add('light', flatPlane(3.5, 1.4), M(x, y, z0 - 0.4, 0, Math.PI, 0));
    }
    for (let z = z0 + 6; z < 785; z += 9) if (rng() < 0.5) h.add('light', flatPlane(3.5, 1.4), M(hw + 0.4, top - 5, z, 0, Math.PI / 2, 0));
    for (let i = 0; i < 6; i++) {
      const gw = 6 + rng() * 22, gl = 8 + rng() * 40, gh = 2 + rng() * 7;
      h.add(rng() < 0.5 ? 'hullDark' : 'metal', box(gw, gh, gl), M(gw / 2 + rng() * (hw - gw), top + gh / 2 - 1, z0 + 20 + rng() * (760 - z0)));
    }
  }
  // bridge tower neck
  b.add('hull', box(84, 100, 100), M(0, 200, 635));
  b.add('hullDark', box(60, 60, 104), M(0, 210, 635));
  for (let y = 165; y < 245; y += 7) for (let x = -36; x <= 36; x += 6) if (rng() < 0.4) b.add('light', flatPlane(3, 1.2), M(x, y, 584.6, 0, Math.PI, 0));
  // dome pylons + masts
  for (const sx of [-1, 1]) b.add('metal', cylY(6, 7, 14, 12), M(sx * SD_DOME_X, 273, SD_BRIDGE_Z + 2));
  b.rod('metal', [0, 280, 632], [0, 312, 632], 1.6, 0.8, 6);
  b.rod('metal', [24, 280, 640], [24, 300, 640], 1.2, 0.6, 6);

  // --- command bridge (separate mesh so it can be scorched) ---------------------------
  const br = new PartBuilder();
  br.add('hull', box(250, 26, 52), M(0, 253, SD_BRIDGE_Z));
  br.add('hullDark', box(254, 4, 56), M(0, 241, SD_BRIDGE_Z));
  br.add('hull', box(130, 14, 44), M(0, 273, SD_BRIDGE_Z));
  br.add('dark', box(236, 4, 1), M(0, 251, SD_BRIDGE_Z - 26.2));
  for (let x = -116; x <= 116; x += 3.4) {
    br.add('bridgeLight', flatPlane(2.4, 1.6), M(x, 251, SD_BRIDGE_Z - 26.9, 0, Math.PI, 0));
    if (rng() < 0.7) br.add('bridgeLight', flatPlane(2.4, 1.4), M(x, 259, SD_BRIDGE_Z - 26.6, 0, Math.PI, 0));
  }
  for (let x = -60; x <= 60; x += 4) if (rng() < 0.6) br.add('bridgeLight', flatPlane(2.6, 1.4), M(x, 274, SD_BRIDGE_Z - 22.6, 0, Math.PI, 0));

  // --- trench windows + dorsal/ventral greebles (starboard, mirrored) ------------------
  const trenchYaw = Math.atan2(1, -(434 / 1600));
  for (let z = -700; z < 795; z += 6) {
    const { w, d, t } = sdDims(z);
    for (const row of t > 6 ? [-0.45, 0, 0.45] : [0]) {
      if (rng() < 0.5) h.add('light', flatPlane(3, 1.2), M(w - d + 0.4, row * t, z, 0, trenchYaw, 0));
    }
  }
  const topSlope = Math.atan(81 / 427.5);
  for (let i = 0; i < 170; i++) {
    const z = -720 + rng() * 1500;
    const { w } = sdDims(z);
    const ax = w * (0.1 + rng() * 0.82);
    if (ax < sdCoverHW(z) + 4) continue;
    const k = 0.35 + 0.65 * (w / 450);
    const gw = (3 + rng() * 16) * k, gl = (4 + rng() * 30) * k, gh = (1.5 + rng() * 7) * k;
    h.add(rng() < 0.55 ? 'hullDark' : 'hull', box(gw, gh + 3, gl), M(ax, sdTopY(ax, z) + (gh - 3) / 2, z, 0, 0, -topSlope));
  }
  const keelSlope = Math.atan(0.05);
  for (let i = 0; i < 70; i++) {
    const z = -600 + rng() * 1380;
    const { w, hB } = sdDims(z);
    const ax = rng() * w * 0.32;
    if (Math.abs(z - SD_HANGAR_Z) < 115 && ax < 80) continue;
    const gw = 4 + rng() * 18, gl = 6 + rng() * 34, gh = 1.5 + rng() * 6;
    h.add(rng() < 0.6 ? 'hullDark' : 'metal', box(gw, gh + 3, gl), M(ax, -hB - (gh - 3) / 2, z, keelSlope, 0, 0));
  }
  b.addBuilder(h, IDENT);
  b.addBuilder(h, MX);

  // --- ventral hangar ------------------------------------------------------------------
  const hy = -sdDims(SD_HANGAR_Z).hB;
  b.add('dark', box(120, 1.2, 180), M(0, hy - 0.2, SD_HANGAR_Z, keelSlope, 0, 0));
  for (const sx of [-1, 1]) b.add('hullDark', box(6, 3, 190), M(sx * 63, hy - 0.6, SD_HANGAR_Z, keelSlope, 0, 0));
  for (const sz of [-1, 1]) b.add('hullDark', box(132, 3, 6), M(0, hy - 0.6 + sz * 4.5, SD_HANGAR_Z + sz * 93, keelSlope, 0, 0));
  const hl = new PartBuilder();
  for (let z = SD_HANGAR_Z - 80; z <= SD_HANGAR_Z + 80; z += 20) {
    const y = hy - 0.9 - (z - SD_HANGAR_Z) * 0.05;
    hl.add('hangarLight', flatPlane(100, 2.2), M(0, y, z, Math.PI / 2 + keelSlope, 0, 0));
  }

  // --- engine block + nozzles ------------------------------------------------------------
  b.add('hullDark', prism([[250, -50], [250, 40], [150, 100], [-150, 100], [-250, 40], [-250, -50]], 60), M(0, 0, 820));
  const nozzles: [number, number, number, number][] = [
    [-150, 30, 58, 150], [0, 30, 58, 150], [150, 30, 58, 150],
    [-75, -28, 22, 70], [75, -28, 22, 70], [-215, -20, 22, 70], [215, -20, 22, 70],
  ];
  const cores: THREE.BufferGeometry[] = [];
  const plumes: THREE.BufferGeometry[] = [];
  for (const [x, y, r, len] of nozzles) {
    const hl0 = SD_NOZZLE_Z - 845;
    b.add('hull', cylZ(r + 4, r, hl0, 32), M(x, y, 845 + hl0 / 2));
    b.add('metal', cylZ(r + 5, r + 5, 4, 32), M(x, y, 860));
    b.add('dark', new THREE.TorusGeometry(r * 0.92, r * 0.07, 6, 32), M(x, y, SD_NOZZLE_Z + 0.4));
    cores.push(new THREE.CircleGeometry(r * 0.86, 32).translate(x, y, SD_NOZZLE_Z + 0.7));
    plumes.push(new THREE.ConeGeometry(r * 0.8, len, 24, 1, true).translate(0, len / 2, 0).rotateX(Math.PI / 2).translate(x, y, 0));
  }

  // --- turbolaser batteries --------------------------------------------------------------
  const perSide = 6 + Math.floor(rng() * 3);
  const turrets: V3[] = [];
  for (let i = 0; i < perSide; i++) {
    const z = -260 + (900 * i) / (perSide - 1) + (rng() - 0.5) * 40;
    const { w } = sdDims(z);
    const ax = Math.min(0.9 * w, Math.max(0.68 * w, sdCoverHW(z) + 24));
    const y = sdTopY(ax, z);
    turrets.push([ax, y, z], [-ax, y, z]);
  }
  const tb = new PartBuilder();
  tb.add('hullDark', cylY(8, 9, 9, 16), M(0, 0, 0));
  tb.add('hull', box(14, 6, 12), M(0, 6.5, 0));
  tb.add('hullDark', box(10, 2, 8), M(0, 10.2, 1));
  for (const sx of [-3, 3]) {
    tb.add('metal', cylZ(1.1, 1.4, 16, 10), M(sx, 6.5, -14));
    tb.add('hullDark', cylZ(1.7, 1.7, 1.6, 10), M(sx, 6.5, -21.2));
  }
  const db = new PartBuilder();
  db.add('hull', new THREE.IcosahedronGeometry(20, 3));
  db.add('hullDark', new THREE.TorusGeometry(19.6, 1.2, 6, 32).rotateX(Math.PI / 2), M(0, -6, 0));

  // --- coarse colliders ------------------------------------------------------------------
  const b3 = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.Box3 =>
    new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  const colliders: THREE.Box3[] = [];
  for (let z0 = -800; z0 < 800; z0 += 100) {
    const { w, t, hT, hB } = sdDims(z0 + 100);
    colliders.push(b3(-w, -(t + 0.3 * (hB - t)), z0, w, t + 0.3 * (hT - t), z0 + 100));
    colliders.push(b3(-0.5 * w, -hB, z0, 0.5 * w, hT, z0 + 100));
  }
  for (const [z0, hw, top] of SD_TIERS) colliders.push(b3(-hw, 0, z0, hw, top, 790));
  colliders.push(b3(-42, 150, 585, 42, 250, 685));
  colliders.push(b3(-127, 239, SD_BRIDGE_Z - 28, 127, 280, SD_BRIDGE_Z + 28));
  colliders.push(b3(-SD_DOME_X - 21, 266, SD_BRIDGE_Z - 21, SD_DOME_X + 21, SD_DOME_Y + 21, SD_BRIDGE_Z + 21));
  colliders.push(b3(-250, -50, 790, 250, 100, SD_NOZZLE_Z));

  const single = (parts: Parts): THREE.BufferGeometry => {
    const g = parts.get('paint');
    if (!g || parts.size !== 1) throw new Error('ships: expected a single painted geometry');
    return g;
  };
  return {
    hull: b.finish(40, SD_PALETTE),
    bridge: br.finish(20, SD_PALETTE),
    hangarLight: hl.finish(40),
    turret: single(tb.finish(12, SD_PALETTE)),
    dome: single(db.finish(12, SD_PALETTE)),
    core: mergeGeometries(cores),
    plume: mergeGeometries(plumes),
    turrets,
    colliders,
  };
}

export function createStarDestroyer(seed: number): StarDestroyerModel {
  const v = ((Math.floor(seed) % SD_VARIANTS) + SD_VARIANTS) % SD_VARIANTS;
  let parts = sdCache.get(v);
  if (!parts) {
    parts = buildStarDestroyer(v);
    sdCache.set(v, parts);
  }
  const paint = paintMat('imperial', 0.55, 0.3, 1);
  const scorch = cachedMat('sd_scorch', () => {
    const t = getPanelTextures('imperial');
    return new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x2b2522, map: t.map, bumpMap: t.bumpMap, roughness: 1, metalness: 0.1 });
  });
  const windowMat = glowMat('sd_window', 0xdfeaff, 1.4);
  const root = new THREE.Group();
  root.name = 'StarDestroyer';
  addParts(root, parts.hull, { paint, light: windowMat });

  const bridgeGroup = new THREE.Group();
  bridgeGroup.name = 'bridge';
  addParts(bridgeGroup, parts.bridge, { paint, bridgeLight: windowMat });
  root.add(bridgeGroup);
  const hangarGroup = new THREE.Group();
  hangarGroup.name = 'hangarLights';
  addParts(hangarGroup, parts.hangarLight, { hangarLight: glowMat('sd_hangar', 0xbcd6ff, 1.2) });
  root.add(hangarGroup);

  const glow = new EngineGlow(0xa8d4ff, 1.7, 0.3);
  glow.addCoreMesh(root, parts.core);
  glow.addMergedPlume(root, parts.plume, SD_NOZZLE_Z + 0.8);

  const white = new THREE.Color(1, 1, 1);
  const burnt = new THREE.Color(0.16, 0.13, 0.11);
  const mtx = new THREE.Matrix4();
  const instanced = (geo: THREE.BufferGeometry, positions: V3[], name: string): THREE.InstancedMesh => {
    const im = new THREE.InstancedMesh(geo, paint, positions.length);
    im.name = name;
    positions.forEach((p, i) => {
      im.setMatrixAt(i, mtx.makeTranslation(...p));
      im.setColorAt(i, white);
    });
    root.add(im);
    return im;
  };
  const wreck = (im: THREE.InstancedMesh, i: number, p: V3, sink: number, sy: number, sxz: number): void => {
    im.setMatrixAt(i, mtx.compose(_p.set(p[0], p[1] - sink, p[2]), _q.identity(), _s.set(sxz, sy, sxz)));
    im.setColorAt(i, burnt);
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  };

  const subsystems: CapitalSubsystem[] = [];
  const domePos: V3[] = [[-SD_DOME_X, SD_DOME_Y, SD_BRIDGE_Z + 2], [SD_DOME_X, SD_DOME_Y, SD_BRIDGE_Z + 2]];
  const domes = instanced(parts.dome, domePos, 'shieldDomes');
  domePos.forEach((p, i) => {
    let done = false;
    subsystems.push({
      kind: 'shieldGen', anchor: empty(root, 'shieldGen', ...p), radius: 22, muzzles: [],
      setDestroyed: () => {
        if (done) return;
        done = true;
        wreck(domes, i, p, 12, 0.35, 0.8);
      },
    });
  });

  let bridgeDone = false;
  subsystems.push({
    kind: 'bridge', anchor: empty(root, 'bridge', 0, 256, SD_BRIDGE_Z), radius: 45, muzzles: [],
    setDestroyed: () => {
      if (bridgeDone) return;
      bridgeDone = true;
      for (const m of bridgeGroup.children) {
        if (!(m instanceof THREE.Mesh)) continue;
        if (m.name === 'paint') m.material = scorch;
        else m.visible = false;
      }
    },
  });

  const turrets = instanced(parts.turret, parts.turrets, 'turbolasers');
  parts.turrets.forEach((p, i) => {
    const anchor = empty(root, 'turbolaser', ...p);
    const muzzles = [-3, 3].map((x) => empty(anchor, 'muzzle', x, 6.5, -22));
    let done = false;
    subsystems.push({
      kind: 'turbolaser', anchor, radius: 14, muzzles,
      setDestroyed: () => {
        if (done) return;
        done = true;
        wreck(turrets, i, p, 3, 0.55, 0.9);
      },
    });
  });

  let hangarDone = false;
  subsystems.push({
    kind: 'hangar', anchor: empty(root, 'hangar', 0, -sdDims(SD_HANGAR_Z).hB - 2, SD_HANGAR_Z), radius: 60, muzzles: [],
    setDestroyed: () => {
      if (hangarDone) return;
      hangarDone = true;
      for (const m of hangarGroup.children) if (m instanceof THREE.Mesh) m.material = glowMat('sd_ember', 0xff4a14, 0.9);
    },
  });

  return {
    root,
    subsystems,
    colliders: parts.colliders.map((c) => c.clone()),
    setThrottle: (t) => glow.setThrottle(t),
    update: (dt) => glow.update(dt),
  };
}
