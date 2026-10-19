// Infinite, deterministic Death Star surface: chunked greeble city streamed around the camera.
// heightAt() and the rendered geometry come from the same cell function, so collisions match what you see.
// Each chunk has a base mesh (architecture, always drawn) and a detail mesh (roof kit, pipes, plates; drawn
// only near the camera), the detail parts are all low (≲2 m) so leaving them out of heightAt() is invisible.
import * as THREE from 'three';
import { hash2 } from '../core/rng';
import { MeshBuilder } from './meshBuilder';
import { getHullMaterial } from './surfaceTextures';

export interface SurfaceOptions {
  seed: number;
  /** Planet radius for curvature (0 = flat world). DS-I ≈ 60 km. */
  curvatureR: number;
  /** Optional trench along the Z axis centred on x = 0. */
  trench?: { halfWidth: number; depth: number };
  viewChunks?: number;
}

/** Block kinds: chamfered tier, plain box, dome (collides as its bounding box), antenna mast. */
const TIER = 0;
const PLAIN = 1;
const DOME = 2;
const MAST = 3;

interface Block {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Base (mesh only; collision treats every block as solid down to the hull). */
  y0: number;
  h: number;
  kind: number;
  /** Lit-window probability for the block's walls. */
  win: number;
}

interface Chunk {
  base: THREE.Mesh;
  /** Near-only kit (null when the chunk has none). */
  detail: THREE.Mesh | null;
  cx: number;
  cz: number;
}

const CELL = 24;
const CHUNK_CELLS = 16;
const CHUNK = CELL * CHUNK_CELLS;
/** Detail meshes are shown for chunks closer than this (m, horizontal, to the nearest chunk edge). */
const DETAIL_DIST = 900;

export class DeathStarSurface {
  readonly group = new THREE.Group();
  private chunks = new Map<string, Chunk>();
  private clearings: { x: number; z: number; r: number }[] = [];
  private viewChunks: number;
  private material = getHullMaterial();

  constructor(private opts: SurfaceOptions) {
    this.viewChunks = opts.viewChunks ?? 7;
    this.group.name = 'surface';
  }

  /** Keep a circular area free of architecture (tower pads etc.). Call before the first update(). */
  addClearing(x: number, z: number, r: number): void {
    this.clearings.push({ x, z, r });
  }

  /** Vertical drop of the curved hull at (x,z) relative to the flat tangent plane at the origin. */
  curvature(x: number, z: number): number {
    const R = this.opts.curvatureR;
    return R > 0 ? -(x * x + z * z) / (2 * R) : 0;
  }

  get trench(): { halfWidth: number; depth: number } | undefined {
    return this.opts.trench;
  }

  private inTrenchBand(x0: number, x1: number): boolean {
    const t = this.opts.trench;
    return !!t && x1 > -t.halfWidth - 2 && x0 < t.halfWidth + 2;
  }

  private clearAt(x0: number, z0: number, size: number): boolean {
    for (const c of this.clearings) {
      const dx = Math.max(Math.abs(x0 + size / 2 - c.x) - size / 2, 0);
      const dz = Math.max(Math.abs(z0 + size / 2 - c.z) - size / 2, 0);
      if (dx * dx + dz * dz < c.r * c.r) return true;
    }
    return false;
  }

  private static put(out: Block[], n: number, x0: number, z0: number, x1: number, z1: number, y0: number, h: number, kind: number, win: number): number {
    const b = (out[n] ??= { x0: 0, z0: 0, x1: 0, z1: 0, y0: 0, h: 0, kind: 0, win: 0 });
    b.x0 = x0;
    b.z0 = z0;
    b.x1 = x1;
    b.z1 = z1;
    b.y0 = y0;
    b.h = h;
    b.kind = kind;
    b.win = win;
    return n + 1;
  }

  /**
   * Deterministic architecture of one cell: a stack of blocks, each resting on the one below and inside the cell.
   * Some 2×2 cell groups merge into one large complex; `meshOnly` returns it only from the group's origin cell so
   * it is built once. heightAt() is the max top of the blocks containing a point, so the stack must only ever
   * add material (tiers sit inside or on top of their supports).
   */
  private cellBlocks(cx: number, cz: number, out: Block[], meshOnly = true): number {
    const seed = this.opts.seed;
    const put = DeathStarSurface.put;
    const x0 = cx * CELL;
    const z0 = cz * CELL;
    if (this.inTrenchBand(x0, x0 + CELL)) return 0;
    // District density: low-frequency hash blend gives zones of dense "city" and open plating.
    const district = hash2(Math.floor(cx / 12), Math.floor(cz / 12), seed + 11);
    const sx = Math.floor(cx / 2);
    const sz = Math.floor(cz / 2);
    const hs = hash2(sx, sz, seed + 21);
    if (hs < 0.05 + district * 0.12 && !this.inTrenchBand(sx * 2 * CELL, (sx * 2 + 2) * CELL) && !this.clearAt(sx * 2 * CELL, sz * 2 * CELL, CELL * 2)) {
      if (meshOnly && (cx !== sx * 2 || cz !== sz * 2)) return 0;
      const bx0 = sx * 2 * CELL + 3 + hash2(sx, sz, seed + 22) * 6;
      const bz0 = sz * 2 * CELL + 3 + hash2(sx, sz, seed + 23) * 6;
      const bx1 = (sx * 2 + 2) * CELL - 3 - hash2(sx, sz, seed + 24) * 6;
      const bz1 = (sz * 2 + 2) * CELL - 3 - hash2(sx, sz, seed + 25) * 6;
      const h = 6 + hash2(sx, sz, seed + 26) * 18;
      const style = hash2(sx, sz, seed + 29);
      const win = 0.06 + hash2(sx, sz, seed + 30) * 0.16;
      let n = 0;
      if (style < 0.4) {
        // Terraced ziggurat with asymmetric setbacks.
        n = put(out, n, bx0, bz0, bx1, bz1, 0, h, TIER, 0.06);
        let ax0 = bx0, az0 = bz0, ax1 = bx1, az1 = bz1, top = h;
        const tiers = 2 + Math.floor(hash2(sx, sz, seed + 31) * 2);
        for (let t = 0; t < tiers; t++) {
          const w = ax1 - ax0;
          const d = az1 - az0;
          const nx0 = ax0 + 1.5 + hash2(sx, sz, seed + 32 + t * 4) * w * 0.2;
          const nx1 = ax1 - 1.5 - hash2(sx, sz, seed + 33 + t * 4) * w * 0.2;
          const nz0 = az0 + 1.5 + hash2(sx, sz, seed + 34 + t * 4) * d * 0.2;
          const nz1 = az1 - 1.5 - hash2(sx, sz, seed + 35 + t * 4) * d * 0.2;
          if (nx1 - nx0 < 7 || nz1 - nz0 < 7) break;
          const ny = top + 3 + hash2(sx, sz, seed + 50 + t) * 8;
          n = put(out, n, nx0, nz0, nx1, nz1, top, ny, TIER, win);
          ax0 = nx0; ax1 = nx1; az0 = nz0; az1 = nz1; top = ny;
        }
      } else if (style < 0.7) {
        // Recessed bay: low base, raised rim walls around a sunken court holding a dome.
        const hb = 3 + hash2(sx, sz, seed + 31) * 6;
        const rim = hb + 3 + hash2(sx, sz, seed + 32) * 7;
        const t = 2.5 + hash2(sx, sz, seed + 33) * 2;
        n = put(out, n, bx0, bz0, bx1, bz1, 0, hb, TIER, 0.05);
        n = put(out, n, bx0, bz0, bx1, bz0 + t, hb, rim, PLAIN, win);
        n = put(out, n, bx0, bz1 - t, bx1, bz1, hb, rim, PLAIN, win);
        n = put(out, n, bx0, bz0 + t, bx0 + t, bz1 - t, hb, rim, PLAIN, win);
        n = put(out, n, bx1 - t, bz0 + t, bx1, bz1 - t, hb, rim, PLAIN, win);
        const court = Math.min(bx1 - bx0, bz1 - bz0) - 2 * t;
        const r = court * (0.5 - hash2(sx, sz, seed + 34) * 0.15) - 1.5;
        if (r > 2) {
          const mx = (bx0 + bx1) / 2;
          const mz = (bz0 + bz1) / 2;
          const sy = 0.55 + hash2(sx, sz, seed + 35) * 0.45;
          n = put(out, n, mx - r, mz - r, mx + r, mz + r, hb, hb + r * sy, DOME, 0);
        }
      } else {
        // Domed complex: base, offset upper block, dome on the free strip of roof.
        n = put(out, n, bx0, bz0, bx1, bz1, 0, h, TIER, 0.1);
        const w = (bx1 - bx0) * (0.25 + hash2(sx, sz, seed + 27) * 0.2);
        const h2 = h + 4 + hash2(sx, sz, seed + 28) * 12;
        n = put(out, n, bx0 + w, bz0 + w * 0.6, bx1 - w * 0.4, bz1 - w, h, h2, TIER, win);
        const r = w / 2 - 1;
        if (r > 2) {
          const mx = bx0 + w / 2;
          const mz = bz0 + r + 1 + hash2(sx, sz, seed + 36) * Math.max(0, bz1 - bz0 - 2 * r - 2);
          const sy = 0.6 + hash2(sx, sz, seed + 37) * 0.4;
          n = put(out, n, mx - r, mz - r, mx + r, mz + r, h, h + r * sy, DOME, 0);
        }
        if (hash2(sx, sz, seed + 38) < 0.5) {
          const mx = (bx0 + w + bx1 - w * 0.4) / 2;
          const mz = (bz0 + w * 0.6 + bz1 - w) / 2;
          n = put(out, n, mx - 1.4, mz - 1.4, mx + 1.4, mz + 1.4, h2, h2 + 8 + hash2(sx, sz, seed + 39) * 12, MAST, 0);
        }
      }
      return n;
    }
    if (this.clearAt(x0, z0, CELL)) return 0;
    const r = hash2(cx, cz, seed);
    // Squared district term: mostly open plating with occasional dense "city" sectors.
    const density = 0.08 + district * district * 0.6;
    if (r > density) return 0;
    const r2 = hash2(cx, cz, seed + 1);
    const r3 = hash2(cx, cz, seed + 2);
    const r4 = hash2(cx, cz, seed + 3);
    const r5 = hash2(cx, cz, seed + 5);
    const pad = 1 + Math.floor(r2 * 5);
    const bx0 = x0 + pad;
    const bz0 = z0 + pad + Math.floor(r3 * 4);
    const bx1 = x0 + CELL - pad - Math.floor(r4 * 6);
    const bz1 = z0 + CELL - pad;
    let n = 0;
    const tall = r4 < 0.04 + district * 0.05;
    if (tall) {
      // Tower: podium, windowed shaft, setback crown, antenna.
      const hp = 2.5 + r2 * 4;
      n = put(out, n, bx0, bz0, bx1, bz1, 0, hp, TIER, 0.05);
      const ix = 1.5 + r3 * 2;
      const iz = 1.5 + r5 * 2;
      const hs2 = 22 + r3 * 40;
      n = put(out, n, bx0 + ix, bz0 + iz, bx1 - ix, bz1 - iz, hp, hs2, TIER, 0.1 + 0.2 * district);
      let top = hs2;
      const cw = Math.min(bx1 - bx0 - 2 * ix, bz1 - bz0 - 2 * iz);
      if (cw > 7) {
        const c = 1.5 + r5 * cw * 0.15;
        top = hs2 + 2.5 + r2 * 5;
        n = put(out, n, bx0 + ix + c, bz0 + iz + c, bx1 - ix - c, bz1 - iz - c, hs2, top, TIER, 0.1);
      }
      if (r5 < 0.7) {
        const mx = (bx0 + bx1) / 2;
        const mz = (bz0 + bz1) / 2;
        n = put(out, n, mx - 1.4, mz - 1.4, mx + 1.4, mz + 1.4, top, top + 6 + r2 * 12, MAST, 0);
      }
      return n;
    }
    if (r2 < 0.5) {
      // Low slab, sometimes a pair of different heights with a service gap.
      const h = 1.5 + r3 * 5;
      if (r5 < 0.4 && bx1 - bx0 > 10) {
        const mid = (bx0 + bx1) / 2;
        n = put(out, n, bx0, bz0, mid - 0.6, bz1, 0, h, TIER, 0);
        n = put(out, n, mid + 0.6, bz0, bx1, bz1, 0, h * 0.55 + 1, TIER, 0);
      } else {
        n = put(out, n, bx0, bz0, bx1, bz1, 0, h, TIER, r5 > 0.8 ? 0.15 : 0);
      }
      return n;
    }
    // Stepped block: 2–3 tiers with one- or two-sided setbacks.
    let top = 3 + r3 * 9 * (0.5 + district);
    const win = 0.04 + district * 0.16;
    n = put(out, n, bx0, bz0, bx1, bz1, 0, top, TIER, win * 0.5);
    let ax0 = bx0, az0 = bz0, ax1 = bx1, az1 = bz1;
    const tiers = 1 + Math.floor(r5 * 2.5);
    for (let t = 0; t < tiers; t++) {
      const a = hash2(cx, cz, seed + 60 + t);
      const step = 2 + a * 3;
      // Pick which sides step in (asymmetric terraces read as architecture rather than wedding cakes).
      if (a < 0.25) ax0 += step;
      else if (a < 0.5) ax1 -= step;
      else if (a < 0.75) az0 += step;
      else az1 -= step;
      if (hash2(cx, cz, seed + 70 + t) < 0.5) {
        ax0 += 1.2;
        ax1 -= 1.2;
        az0 += 1.2;
        az1 -= 1.2;
      }
      if (ax1 - ax0 < 5 || az1 - az0 < 5) break;
      const ny = top + 2.5 + hash2(cx, cz, seed + 80 + t) * 7;
      n = put(out, n, ax0, az0, ax1, az1, top, ny, TIER, win);
      top = ny;
    }
    return n;
  }

  private scratch: Block[] = [];

  /** Hull top (including architecture) under (x,z), in world Y. */
  heightAt(x: number, z: number): number {
    const t = this.opts.trench;
    const curve = this.curvature(x, z);
    if (t && Math.abs(x) < t.halfWidth) return -t.depth + curve;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const n = this.cellBlocks(cx, cz, this.scratch, false);
    let top = 0;
    for (let i = 0; i < n; i++) {
      const b = this.scratch[i];
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.h > top) top = b.h;
    }
    return top + curve;
  }

  /** Architecture blocks → base mesh. */
  private emitBlock(mb: MeshBuilder, b: Block, tint: number): void {
    mb.ground = b.y0;
    mb.win = b.win;
    mb.ao = b.y0 > 0 ? 0.3 : 0.5;
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    if (b.kind === TIER) {
      const c = Math.min(1.3, 0.25 + Math.min(w, d) * 0.05);
      if (b.h - b.y0 > 14) {
        // Tall shafts: the wall is set 0.3 m into the footprint and storey bands stand out to its edge, breaking
        // the walls (and the windows) into strips while staying inside what heightAt() reports.
        const s = 0.3;
        mb.cbox(b.x0 + s, b.y0, b.z0 + s, b.x1 - s, b.h, b.z1 - s, tint, c);
        mb.win = 0;
        const step = 5 + hash2(b.x0 | 0, b.z0 | 0, 77) * 4;
        for (let y = b.y0 + step; y < b.h - 3; y += step) {
          mb.box(b.x0, y, b.z0, b.x1, y + 0.55, b.z1, tint * 0.88, true);
        }
      } else {
        mb.cbox(b.x0, b.y0, b.z0, b.x1, b.h, b.z1, tint, c);
      }
    } else if (b.kind === PLAIN) {
      mb.cbox(b.x0, b.y0, b.z0, b.x1, b.h, b.z1, tint * 0.96, 0.35);
    } else if (b.kind === DOME) {
      const r = w / 2;
      mb.ao = 0.35;
      // Low drum ring under the dome, then the cap.
      mb.cylinder('y', b.x0 + r, b.y0, b.z0 + r, 0.8, r * 1.04, 16, tint * 0.85, 1);
      mb.dome(b.x0 + r, b.y0 + 0.8, b.z0 + r, r, tint * 1.05, ((b.h - b.y0) - 0.8) / r, 16, 5);
    } else {
      // Antenna mast: tapered lattice look from a thin pole, collars and cross arms.
      const mx = (b.x0 + b.x1) / 2;
      const mz = (b.z0 + b.z1) / 2;
      const len = b.h - b.y0;
      mb.ao = 0;
      mb.box(mx - 0.9, b.y0, mz - 0.9, mx + 0.9, b.y0 + 1.2, mz + 0.9, tint * 0.8);
      mb.cylinder('y', mx, b.y0, mz, len, 0.22, 6, tint * 0.9, 1);
      for (let k = 1; k <= 2; k++) {
        const y = b.y0 + len * (0.45 + k * 0.18);
        const a = 1.4 - k * 0.35;
        mb.box(mx - a, y, mz - 0.08, mx + a, y + 0.16, mz + 0.08, tint * 0.9);
      }
    }
  }

  /** Small kit on the roof of a top block → detail mesh. */
  private emitRoof(mb: MeshBuilder, b: Block, tint: number, cx: number, cz: number): void {
    const s = this.opts.seed + 100;
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    if (w < 5 || d < 5) return;
    mb.ground = b.h;
    mb.win = 0;
    mb.ao = 0.25;
    const inset = Math.min(1.3, 0.25 + Math.min(w, d) * 0.05) + 0.6;
    const vents = Math.floor(hash2(cx, cz, s) * 4);
    for (let k = 0; k < vents; k++) {
      const vw = 1.2 + hash2(cx, cz, s + 1 + k) * Math.min(4, w * 0.3);
      const vd = 1.2 + hash2(cx, cz, s + 5 + k) * Math.min(4, d * 0.3);
      const vx = b.x0 + inset + hash2(cx, cz, s + 9 + k) * Math.max(0, w - vw - 2 * inset);
      const vz = b.z0 + inset + hash2(cx, cz, s + 13 + k) * Math.max(0, d - vd - 2 * inset);
      const vh = 0.5 + hash2(cx, cz, s + 17 + k) * 1.4;
      mb.cbox(vx, b.h, vz, vx + vw, b.h + vh, vz + vd, tint * (0.85 + hash2(cx, cz, s + 21 + k) * 0.3), 0.15);
    }
    const r = hash2(cx, cz, s + 25);
    if (r < 0.3 && w > 8 && d > 8) {
      const rr = 0.9 + r * 3;
      mb.dome(b.x1 - inset - rr, b.h, b.z1 - inset - rr, rr, tint, 0.7, 10, 3);
    } else if (r < 0.6) {
      // Roof conduit along the long edge.
      if (w > d) mb.cylinder('x', b.x0 + inset, b.h + 0.35, b.z0 + inset + 0.3, w - 2 * inset, 0.3, 6, tint * 0.8, 2);
      else mb.cylinder('z', b.x0 + inset + 0.3, b.h + 0.35, b.z0 + inset, d - 2 * inset, 0.3, 6, tint * 0.8, 2);
    }
  }

  /** Detail for open plating: plates, curbs/channels, pipe runs → detail mesh. */
  private emitGround(mb: MeshBuilder, cx: number, cz: number): void {
    const s = this.opts.seed;
    const px = cx * CELL;
    const pz = cz * CELL;
    mb.ground = 0;
    mb.win = 0;
    mb.ao = 0.3;
    // Long pipe runs: whole columns/rows of cells carry conduits, so they read as continuous lines.
    const col = hash2(cx, 0, s + 40);
    const row = hash2(0, cz, s + 41);
    let piped = false;
    if (col < 0.12) {
      const x = px + 3 + hash2(cx, 1, s + 42) * 14;
      const r = 0.45 + hash2(cx, 2, s + 43) * 0.45;
      mb.cylinder('z', x, r + 0.2, pz, CELL, r, 8, 0.8, 0);
      if (hash2(cx, 3, s + 44) < 0.5) mb.cylinder('z', x + r * 2 + 0.5, r * 0.7 + 0.2, pz, CELL, r * 0.7, 8, 0.72, 0);
      mb.box(x - r - 0.3, 0, pz + 6, x + r * 3 + 1.2, 0.35, pz + 7.2, 0.7);
      piped = true;
    }
    if (row < 0.08) {
      const z = pz + 3 + hash2(1, cz, s + 45) * 14;
      const r = 0.4 + hash2(2, cz, s + 46) * 0.4;
      mb.cylinder('x', px, r + 0.25, z, CELL, r, 8, 0.82, 0);
      mb.box(px + 9, 0, z - r - 0.3, px + 10.2, 0.4, z + r + 0.3, 0.7);
      piped = true;
    }
    const k = hash2(cx, cz, s + 4);
    if (k < 0.12 && !piped) {
      // Floor channel: two curbs with a dark service floor and a conduit between them.
      const along = hash2(cx, cz, s + 8) < 0.5;
      const o = 6 + hash2(cx, cz, s + 47) * 8;
      if (along) {
        mb.cbox(px + o, 0, pz, px + o + 1, 0.9, pz + CELL, 0.86, 0.2);
        mb.cbox(px + o + 5, 0, pz, px + o + 6, 0.9, pz + CELL, 0.86, 0.2);
        mb.box(px + o + 1, 0, pz, px + o + 5, 0.08, pz + CELL, 0.5);
        mb.cylinder('z', px + o + 3, 0.45, pz, CELL, 0.35, 6, 0.7, 0);
      } else {
        mb.cbox(px, 0, pz + o, px + CELL, 0.9, pz + o + 1, 0.86, 0.2);
        mb.cbox(px, 0, pz + o + 5, px + CELL, 0.9, pz + o + 6, 0.86, 0.2);
        mb.box(px, 0, pz + o + 1, px + CELL, 0.08, pz + o + 5, 0.5);
        mb.cylinder('x', px, 0.45, pz + o + 3, CELL, 0.35, 6, 0.7, 0);
      }
    } else if (k < 0.55) {
      // Low hull plates of slightly different tone/height.
      const plates = 1 + Math.floor(hash2(cx, cz, s + 48) * 3);
      for (let i = 0; i < plates; i++) {
        const a = hash2(cx, cz, s + 50 + i);
        const b = hash2(cx, cz, s + 54 + i);
        const w = 4 + a * 12;
        const d = 4 + b * 12;
        const x = px + 1 + hash2(cx, cz, s + 58 + i) * (CELL - w - 2);
        const z = pz + 1 + hash2(cx, cz, s + 62 + i) * (CELL - d - 2);
        mb.cbox(x, 0, z, x + w, 0.25 + a * 0.5, z + d, 0.8 + b * 0.3, 0.12);
      }
    }
  }

  private buildChunk(ix: number, iz: number): Chunk {
    const R = this.opts.curvatureR;
    const warp = R > 0 ? (x: number, _y: number, z: number) => this.curvature(x, z) : undefined;
    const mb = new MeshBuilder(warp);
    const md = new MeshBuilder(warp);
    const x0 = ix * CHUNK;
    const z0 = iz * CHUNK;
    const t = this.opts.trench;
    const seed = this.opts.seed;
    // Base hull plating (split around the trench opening).
    if (t && x0 < t.halfWidth && x0 + CHUNK > -t.halfWidth) {
      if (x0 < -t.halfWidth) mb.plane(x0, z0, -t.halfWidth, z0 + CHUNK, 0, 4, 1);
      if (x0 + CHUNK > t.halfWidth) mb.plane(t.halfWidth, z0, x0 + CHUNK, z0 + CHUNK, 0, 4, 1);
    } else {
      mb.plane(x0, z0, x0 + CHUNK, z0 + CHUNK, 0, R > 0 ? 8 : 2, 1);
    }
    const blocks = this.scratch;
    for (let i = 0; i < CHUNK_CELLS; i++) {
      for (let j = 0; j < CHUNK_CELLS; j++) {
        const cx = ix * CHUNK_CELLS + i;
        const cz = iz * CHUNK_CELLS + j;
        const n = this.cellBlocks(cx, cz, blocks);
        const tint = 0.8 + hash2(cx, cz, seed + 7) * 0.32;
        let topTier = -1;
        for (let k = 0; k < n; k++) {
          const b = blocks[k];
          this.emitBlock(mb, b, tint * (1 + (k & 1) * 0.06 - (b.kind === PLAIN ? 0.05 : 0)));
          if (b.kind === TIER) topTier = k;
        }
        if (topTier >= 0) this.emitRoof(md, blocks[topTier], tint, cx, cz);
        if (n === 0 && !this.inTrenchBand(cx * CELL, cx * CELL + CELL) && !this.clearAt(cx * CELL, cz * CELL, CELL)) {
          this.emitGround(md, cx, cz);
        }
      }
    }
    const make = (b: MeshBuilder) => {
      const mesh = new THREE.Mesh(b.build(), this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      return mesh;
    };
    return { base: make(mb), detail: md.vertexCount ? make(md) : null, cx: x0 + CHUNK / 2, cz: z0 + CHUNK / 2 };
  }

  /** Stream chunks around `center`. Builds at most `budget` chunks per call to avoid hitches. */
  update(center: THREE.Vector3, budget = 3): void {
    const cix = Math.floor(center.x / CHUNK);
    const ciz = Math.floor(center.z / CHUNK);
    const v = this.viewChunks;
    const wanted = new Set<string>();
    const todo: [number, number, number][] = [];
    for (let i = -v; i <= v; i++) {
      for (let j = -v; j <= v; j++) {
        if (i * i + j * j > v * v + 1) continue;
        const key = `${cix + i},${ciz + j}`;
        wanted.add(key);
        if (!this.chunks.has(key)) todo.push([cix + i, ciz + j, i * i + j * j]);
      }
    }
    todo.sort((a, b) => a[2] - b[2]);
    for (let k = 0; k < Math.min(budget, todo.length); k++) {
      const [ix, iz] = todo[k];
      const chunk = this.buildChunk(ix, iz);
      this.chunks.set(`${ix},${iz}`, chunk);
      this.group.add(chunk.base);
      if (chunk.detail) this.group.add(chunk.detail);
    }
    const half = CHUNK / 2;
    for (const [key, chunk] of this.chunks) {
      if (!wanted.has(key)) {
        this.group.remove(chunk.base);
        chunk.base.geometry.dispose();
        if (chunk.detail) {
          this.group.remove(chunk.detail);
          chunk.detail.geometry.dispose();
        }
        this.chunks.delete(key);
        continue;
      }
      if (!chunk.detail) continue;
      const dx = Math.max(Math.abs(center.x - chunk.cx) - half, 0);
      const dz = Math.max(Math.abs(center.z - chunk.cz) - half, 0);
      chunk.detail.visible = dx * dx + dz * dz < DETAIL_DIST * DETAIL_DIST;
    }
  }

  /** Synchronously build everything in view (used while a level is loading). */
  prewarm(center: THREE.Vector3): void {
    this.update(center, 10000);
  }
}
