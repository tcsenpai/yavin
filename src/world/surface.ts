// Infinite, deterministic Death Star surface: chunked greeble city streamed around the camera.
// heightAt() and the rendered geometry come from the same cell function, so collisions match what you see.
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

interface Block {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  h: number;
}

const CELL = 24;
const CHUNK_CELLS = 16;
const CHUNK = CELL * CHUNK_CELLS;

export class DeathStarSurface {
  readonly group = new THREE.Group();
  private chunks = new Map<string, THREE.Mesh>();
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

  /**
   * Deterministic architecture of one cell (0–2 stacked blocks). Some 2×2 cell groups merge into one large
   * structure; `meshOnly` returns it only from the group's origin cell so it is built once.
   */
  private cellBlocks(cx: number, cz: number, out: Block[], meshOnly = true): number {
    const seed = this.opts.seed;
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
      out[0] = { x0: bx0, z0: bz0, x1: bx1, z1: bz1, h };
      const w = (bx1 - bx0) * (0.25 + hash2(sx, sz, seed + 27) * 0.2);
      out[1] = { x0: bx0 + w, z0: bz0 + w * 0.6, x1: bx1 - w * 0.4, z1: bz1 - w, h: h + 4 + hash2(sx, sz, seed + 28) * 12 };
      return 2;
    }
    if (this.clearAt(x0, z0, CELL)) return 0;
    const r = hash2(cx, cz, seed);
    // Squared district term: mostly open plating with occasional dense "city" sectors.
    const density = 0.08 + district * district * 0.6;
    if (r > density) return 0;
    const r2 = hash2(cx, cz, seed + 1);
    const r3 = hash2(cx, cz, seed + 2);
    const r4 = hash2(cx, cz, seed + 3);
    const pad = 1 + Math.floor(r2 * 5);
    const bx0 = x0 + pad;
    const bz0 = z0 + pad + Math.floor(r3 * 4);
    const bx1 = x0 + CELL - pad - Math.floor(r4 * 6);
    const bz1 = z0 + CELL - pad;
    let h: number;
    const tall = r4 < 0.04 + district * 0.05;
    if (tall) h = 22 + r3 * 40;
    else if (r2 < 0.5) h = 1.5 + r3 * 5;
    else h = 5 + r3 * 12 * (0.5 + district);
    let n = 0;
    out[n++] = { x0: bx0, z0: bz0, x1: bx1, z1: bz1, h };
    if (h > 6 && r2 > 0.35) {
      const ix = (bx1 - bx0) * 0.22;
      const iz = (bz1 - bz0) * 0.22;
      out[n++] = { x0: bx0 + ix, z0: bz0 + iz, x1: bx1 - ix * (0.5 + r3), z1: bz1 - iz, h: h + 3 + r4 * 10 };
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

  private buildChunk(ix: number, iz: number): THREE.Mesh {
    const R = this.opts.curvatureR;
    const mb = new MeshBuilder(R > 0 ? (x, _y, z) => this.curvature(x, z) : undefined);
    const x0 = ix * CHUNK;
    const z0 = iz * CHUNK;
    const t = this.opts.trench;
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
        const tint = 0.82 + hash2(cx, cz, this.opts.seed + 7) * 0.3;
        for (let k = 0; k < n; k++) {
          const b = blocks[k];
          mb.box(b.x0, 0, b.z0, b.x1, b.h, b.z1, tint * (k ? 1.06 : 1));
        }
        // Small rooftop details on some blocks: vents, antennae, domes approximated by boxes.
        if (n > 0 && hash2(cx, cz, this.opts.seed + 9) < 0.35) {
          const b = blocks[n - 1];
          const s = 1 + hash2(cx, cz, 5) * 2;
          const mx = (b.x0 + b.x1) / 2;
          const mz = (b.z0 + b.z1) / 2;
          mb.box(mx - s, b.h, mz - s, mx + s, b.h + 1 + hash2(cx, cz, 6) * 4, mz + s, 0.7);
        }
        // Flat cells sometimes get low plates/pipes for texture at grazing angles.
        if (n === 0 && !this.inTrenchBand(cx * CELL, cx * CELL + CELL) && hash2(cx, cz, this.opts.seed + 4) < 0.25) {
          const px = cx * CELL;
          const pz = cz * CELL;
          const along = hash2(cx, cz, 8) < 0.5;
          if (along) mb.box(px + 4, 0, pz, px + 6, 1.4, pz + CELL, 0.75);
          else mb.box(px, 0, pz + 9, px + CELL, 0.8, pz + 15, 0.9);
        }
      }
    }
    const mesh = new THREE.Mesh(mb.build(), this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
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
      const mesh = this.buildChunk(ix, iz);
      this.chunks.set(`${ix},${iz}`, mesh);
      this.group.add(mesh);
    }
    for (const [key, mesh] of this.chunks) {
      if (wanted.has(key)) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this.chunks.delete(key);
    }
  }

  /** Synchronously build everything in view (used while a level is loading). */
  prewarm(center: THREE.Vector3): void {
    this.update(center, 10000);
  }
}
