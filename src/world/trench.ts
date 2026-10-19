// The meridian trench leading to the thermal exhaust port. Runs along -Z from z = 0, centred on x = 0.
// Geometry is streamed in segments; walls carry deterministic ledges, recesses, pipes and gun slots.
import * as THREE from 'three';
import { hash2 } from '../core/rng';
import { MeshBuilder } from './meshBuilder';
import { getHullMaterial } from './surfaceTextures';

export const TRENCH_HALF_WIDTH = 25; // 50 m wide
export const TRENCH_DEPTH = 50; // 50 m deep
export const TRENCH_WALL_RELIEF = 2.6; // max greeble protrusion into the trench
const SEG = 96;

export interface TurretSlot {
  pos: THREE.Vector3;
  /** Outward normal of the surface the turret sits on. */
  normal: THREE.Vector3;
  kind: 'wall' | 'rim';
}

export class Trench {
  readonly group = new THREE.Group();
  private segs = new Map<number, THREE.Mesh>();
  private material = getHullMaterial();

  constructor(private seed: number, readonly length: number) {
    this.group.name = 'trench';
  }

  private buildSegment(i: number): THREE.Mesh {
    const mb = new MeshBuilder();
    const hw = TRENCH_HALF_WIDTH;
    const d = TRENCH_DEPTH;
    const z1 = -i * SEG; // near end (higher z)
    const z0 = z1 - SEG;
    const s = this.seed;
    // Floor and walls (base surfaces).
    mb.quad(-hw, -d, z1, hw, -d, z1, hw, -d, z0, -hw, -d, z0, 0, 1, 0, 0.78);
    mb.quad(-hw, -d, z1, -hw, -d, z0, -hw, 0, z0, -hw, 0, z1, 1, 0, 0, 0.9);
    mb.quad(hw, -d, z0, hw, -d, z1, hw, 0, z1, hw, 0, z0, -1, 0, 0, 0.9);

    // Wall architecture: horizontal ledges and blocks in bands, varying every 6–16 m.
    for (const side of [-1, 1]) {
      let z = z1;
      let k = 0;
      while (z > z0) {
        const len = 6 + Math.floor(hash2(i * 31 + k, side, s) * 11);
        const za = Math.max(z - len, z0);
        const r = hash2(i * 31 + k, side + 7, s);
        const bands = 2 + Math.floor(r * 4);
        for (let b = 0; b < bands; b++) {
          const hb = hash2(i * 31 + k, b + side * 10, s + 3);
          const yA = -d + (b / bands) * d + hb * 3;
          const yB = yA + 2 + hb * (d / bands - 3);
          const relief = 0.4 + hash2(i * 31 + k, b, s + 5) * (TRENCH_WALL_RELIEF - 0.4);
          const wx = side * hw;
          const inner = wx - side * relief;
          mb.box(Math.min(wx, inner), yA, za + 0.4, Math.max(wx, inner), Math.min(yB, -0.5), z - 0.4, 0.75 + hb * 0.3);
        }
        // Long horizontal pipe / ledge running along the wall.
        if (r > 0.6) {
          const y = -d * (0.3 + hash2(i, k + side, s + 9) * 0.5);
          const wx = side * hw;
          mb.box(Math.min(wx, wx - side * 1.2), y, za, Math.max(wx, wx - side * 1.2), y + 0.8, z, 0.62);
        }
        z = za;
        k++;
      }
    }
    // Floor detail: centre conduits and plates.
    for (let k = 0; k < 6; k++) {
      const r = hash2(i, k, s + 21);
      const zz = z1 - (k + r) * (SEG / 6);
      const w = 2 + r * 8;
      const x = (hash2(i, k, s + 22) - 0.5) * (2 * hw - w - 6);
      mb.box(x - w / 2, -d, zz - 4 - r * 6, x + w / 2, -d + 0.3 + r * 1.2, zz, 0.68 + r * 0.25);
    }
    mb.box(-hw + 3, -d, z0, -hw + 4.2, -d + 0.9, z1, 0.6);
    mb.box(hw - 4.2, -d, z0, hw - 3, -d + 0.9, z1, 0.6);

    const mesh = new THREE.Mesh(mb.build(), this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /** Deterministic gun emplacements for segment i (level code decides which to activate). */
  turretSlots(i: number): TurretSlot[] {
    const out: TurretSlot[] = [];
    const zc = -i * SEG - SEG / 2;
    const r = hash2(i, 99, this.seed);
    if (r < 0.55) {
      const side = hash2(i, 98, this.seed) < 0.5 ? -1 : 1;
      const y = -TRENCH_DEPTH * (0.25 + hash2(i, 97, this.seed) * 0.5);
      out.push({
        pos: new THREE.Vector3(side * (TRENCH_HALF_WIDTH - TRENCH_WALL_RELIEF), y, zc),
        normal: new THREE.Vector3(-side, 0, 0),
        kind: 'wall',
      });
    }
    if (hash2(i, 96, this.seed) < 0.45) {
      const side = hash2(i, 95, this.seed) < 0.5 ? -1 : 1;
      out.push({
        pos: new THREE.Vector3(side * (TRENCH_HALF_WIDTH + 8 + hash2(i, 94, this.seed) * 20), 0, zc + 20),
        normal: new THREE.Vector3(0, 1, 0),
        kind: 'rim',
      });
    }
    return out;
  }

  segmentIndexAt(z: number): number {
    return Math.floor(-z / SEG);
  }

  update(center: THREE.Vector3, ahead = 30, behind = 4): void {
    const ci = this.segmentIndexAt(center.z);
    const maxSeg = Math.ceil(this.length / SEG) + 6;
    for (let i = Math.max(0, ci - behind); i <= Math.min(maxSeg, ci + ahead); i++) {
      if (this.segs.has(i)) continue;
      const m = this.buildSegment(i);
      this.segs.set(i, m);
      this.group.add(m);
    }
    for (const [i, m] of this.segs) {
      if (i >= ci - behind && i <= ci + ahead) continue;
      this.group.remove(m);
      m.geometry.dispose();
      this.segs.delete(i);
    }
  }

  /**
   * Collision against trench walls/floor. Returns penetration depth (>0 = touching) and the push-out normal.
   * Only valid below the rim (y < 0).
   */
  collide(p: THREE.Vector3, radius: number, outNormal: THREE.Vector3): number {
    if (p.y > 0 || p.z > 0) return 0;
    const lim = TRENCH_HALF_WIDTH - TRENCH_WALL_RELIEF * 0.6 - radius;
    if (p.x > lim) {
      outNormal.set(-1, 0, 0);
      return p.x - lim;
    }
    if (p.x < -lim) {
      outNormal.set(1, 0, 0);
      return -lim - p.x;
    }
    const floor = -TRENCH_DEPTH + 1.2 + radius;
    if (p.y < floor) {
      outNormal.set(0, 1, 0);
      return floor - p.y;
    }
    return 0;
  }

  static readonly SEGMENT = SEG;
}
