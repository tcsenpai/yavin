// The meridian trench leading to the thermal exhaust port. Runs along -Z from z = 0, centred on x = 0.
// Geometry is streamed in segments. Walls are built like the film miniature: continuous horizontal ledges (fixed per
// trench, so they run to the vanishing point) between dense bands of modules, openings to a dark, windowed back
// wall, recessed lit panels, flush plates, protruding boxes with nested relief, plus vertical ribs and conduits.
// The floor has wall gutters, conduit runs and equipment plates. Nothing protrudes more than TRENCH_WALL_RELIEF
// from the wall line or rises more than ~1 m from the floor, so collide() stays a simple box test.
import * as THREE from 'three';
import { Rng, hash2 } from '../core/rng';
import { FACE, MeshBuilder } from './meshBuilder';
import { getHullMaterial } from './surfaceTextures';

export const TRENCH_HALF_WIDTH = 25; // 50 m wide
export const TRENCH_DEPTH = 50; // 50 m deep
export const TRENCH_WALL_RELIEF = 2.6; // max greeble protrusion into the trench
const SEG = 96;
/** Depth of the recessed back plane behind the wall line. */
const BACK = 2.2;
/** Gutter along each wall foot: width and depth below the floor. */
const GUTTER_W = 2.5;
const GUTTER_D = 1.2;

export interface TurretSlot {
  pos: THREE.Vector3;
  /** Outward normal of the surface the turret sits on. */
  normal: THREE.Vector3;
  kind: 'wall' | 'rim';
}

/** Horizontal wall band (heights in metres above the trench floor). */
interface Band {
  y0: number;
  y1: number;
  /** Continuous ledge (protrusion `p`) rather than a band of modules. */
  ledge: boolean;
  p: number;
  /** Carries a conduit along its top. */
  pipe: number;
}

/** One rectangle of a wall module band: heights above the floor, depth `q` into the wall (negative = proud). */
interface Cell {
  ya: number;
  yb: number;
  q: number;
  tint: number;
  win: number;
}

/** A module column za..zb of a band, cells stacked bottom to top covering the band. */
interface Col {
  za: number;
  zb: number;
  cells: Cell[];
}

export class Trench {
  readonly group = new THREE.Group();
  private segs = new Map<number, THREE.Mesh>();
  private material = getHullMaterial();
  /** Band layouts for the left (-x) and right (+x) walls. */
  private bands: [Band[], Band[]];

  constructor(private seed: number, readonly length: number) {
    this.group.name = 'trench';
    this.bands = [this.layoutBands(seed * 13 + 1), this.layoutBands(seed * 13 + 2)];
  }

  private layoutBands(seed: number): Band[] {
    const rng = new Rng(seed);
    const d = TRENCH_DEPTH;
    const out: Band[] = [{ y0: -GUTTER_D, y1: 2.5 + rng.float() * 2, ledge: false, p: 0, pipe: 0 }];
    let y = out[0].y1;
    while (y < d - 7) {
      const lh = 0.8 + rng.float() * 1.1;
      out.push({ y0: y, y1: y + lh, ledge: true, p: 0.5 + rng.float() * 1.1, pipe: rng.chance(0.4) ? 0.3 + rng.float() * 0.25 : 0 });
      y += lh;
      const th = Math.min(4.5 + rng.float() * 4.5, d - 1.4 - y);
      out.push({ y0: y, y1: y + th, ledge: false, p: 0, pipe: 0 });
      y += th;
    }
    if (d - 1.4 - y > 1.5) out.push({ y0: y, y1: d - 1.4, ledge: false, p: 0, pipe: 0 });
    // Coping at the rim: a lip standing 0.4 m proud of the surrounding plating.
    out.push({ y0: Math.min(y, d - 1.4), y1: d + 0.4, ledge: true, p: 0.6, pipe: 0 });
    return out;
  }

  /**
   * Wall box on side `s` (−1 left, +1 right) spanning za..zb and heights ya..yb above the floor, from depth
   * `qf` (front, metres into the wall; negative = proud of the wall line) back to `qb`. Only `faces` are emitted
   * (FACE.top/bottom/pz/nz; the front is always drawn, the back never is).
   */
  private wallBox(mb: MeshBuilder, s: number, za: number, zb: number, ya: number, yb: number, qf: number, qb: number, tint: number, faces: number): void {
    const hw = TRENCH_HALF_WIDTH;
    const y0 = ya - TRENCH_DEPTH;
    const y1 = yb - TRENCH_DEPTH;
    const xf = s * (hw + qf);
    const xk = s * (hw + qb);
    const x0 = Math.min(xf, xk);
    const x1 = Math.max(xf, xk);
    mb.rectX(xf, y0, y1, za, zb, -s, tint);
    if (faces & FACE.top) mb.rectY(y1, x0, x1, za, zb, 1, tint);
    if (faces & FACE.bottom) mb.rectY(y0, x0, x1, za, zb, -1, tint * 0.75);
    if (faces & FACE.pz) mb.rectZ(zb, x0, x1, y0, y1, 1, tint * 0.92);
    if (faces & FACE.nz) mb.rectZ(za, x0, x1, y0, y1, -1, tint * 0.92);
  }

  /**
   * One wall of segment i. The wall is a relief "height field": every module cell contributes its front face and
   * only the step faces where it stands proud of its neighbours. The log depth buffer disables early-z, so hidden
   * surfaces (a full back plane, box sides buried in neighbours) would cost full shading, they are never emitted.
   */
  private buildWall(mb: MeshBuilder, i: number, side: number): void {
    const hw = TRENCH_HALF_WIDTH;
    const d = TRENCH_DEPTH;
    const z1 = -i * SEG;
    const z0 = z1 - SEG;
    const s = this.seed + (side > 0 ? 500 : 0);
    const bands = this.bands[side > 0 ? 1 : 0];
    const X = (q: number) => side * (hw + q);
    mb.ground = -d;
    mb.ao = 0.45;

    for (let b = 0; b < bands.length; b++) {
      const band = bands[b];
      if (band.ledge) {
        mb.win = 0;
        if (b === bands.length - 1) {
          // Coping: closed box so the lip reads from the plating outside the trench too.
          const xi = X(-band.p);
          const xo = X(BACK + 0.6);
          mb.boxFaces(Math.min(xi, xo), band.y0 - d, z0, Math.max(xi, xo), band.y1 - d, z1, 1.02, FACE.top | FACE.sides | FACE.bottom);
          continue;
        }
        // Continuous ledge; its full-depth top/bottom close off recesses in the bands above and below.
        this.wallBox(mb, side, z0, z1, band.y0, band.y1, -band.p, BACK, 0.98, FACE.top | FACE.bottom);
        if (band.pipe) {
          const r = band.pipe;
          mb.cylinder('z', X(-band.p * 0.5), band.y1 - d + r, z0, SEG, r, 8, 0.78, 0);
        }
        continue;
      }

      // Module band: columns along z (high z first), each 1–2 cells stacked in y with their own depth.
      const cols: Col[] = [];
      const nested: [number, number, number, number, number, number, number][] = [];
      let z = z1;
      let m = 0;
      while (z > z0 + 0.5) {
        const key = i * 97 + m;
        const len = Math.min(3 + Math.floor(hash2(key, b, s) * 9), z - z0);
        const za = z - len;
        // Seam: a narrow slot down to the back wall between modules.
        const gap = hash2(key, b, s + 1) < 0.3 && len > 2 ? 0.3 : 0;
        if (gap) cols.push({ za: z - gap, zb: z, cells: [{ ya: band.y0, yb: band.y1, q: BACK, tint: 0.5, win: 0 }] });
        const zb = z - gap;
        const tone = hash2(key, b, s + 3);
        const tint = 0.62 + tone * tone * 0.45;
        const rows = band.y1 - band.y0 > 5 && hash2(key, b, s + 4) < 0.35 ? 2 : 1;
        const cells: Cell[] = [];
        for (let r = 0; r < rows; r++) {
          const ya = band.y0 + ((band.y1 - band.y0) * r) / rows;
          const yb = band.y0 + ((band.y1 - band.y0) * (r + 1)) / rows;
          const cr = hash2(key, b, s + 2 + r * 3);
          if (cr < 0.1) {
            cells.push({ ya, yb, q: 1.3, tint: tint * 0.75, win: 0.45 }); // recessed windowed panel
          } else if (cr < 0.22) {
            cells.push({ ya, yb, q: BACK, tint: 0.55, win: 0.55 }); // open to the dark back wall
          } else if (cr < 0.58) {
            cells.push({ ya, yb, q: 0.3 - hash2(key, b + r, s + 6) * 0.6, tint, win: 0.1 }); // flush plate
          } else {
            const p = 0.5 + hash2(key, b + r, s + 7) * 1.1;
            cells.push({ ya, yb, q: -p, tint, win: 0.06 });
            // Nested relief: a smaller box standing proud of the module face.
            if (hash2(key, b + r, s + 8) < 0.45 && zb - za > 2.5 && yb - ya > 2) {
              const iy = 0.4 + hash2(key, b + r, s + 9) * (yb - ya) * 0.25;
              const iz = 0.5 + hash2(key, b + r, s + 10) * (zb - za) * 0.25;
              const pn = Math.min(p + 0.4 + hash2(key, b, s + 11) * 0.5, 2.4);
              nested.push([za + iz, zb - iz, ya + iy, yb - iy, -pn, -p, tint * 1.06]);
            }
          }
        }
        cols.push({ za, zb, cells });
        z = za;
        m++;
      }

      const qAbove = bands[b + 1]?.ledge ? -bands[b + 1].p : BACK;
      const qBelow = b === 0 ? -Infinity : bands[b - 1].ledge ? -bands[b - 1].p : BACK; // plinth: floor below
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const cells = col.cells;
        for (let k = 0; k < cells.length; k++) {
          const cell = cells[k];
          mb.win = cell.win;
          mb.rectX(X(cell.q), cell.ya - d, cell.yb - d, col.za, col.zb, -side, cell.tint);
          // Horizontal step to the cell / band above.
          const qUp = k + 1 < cells.length ? cells[k + 1].q : qAbove;
          if (cell.q < qUp) {
            mb.rectY(cell.yb - d, Math.min(X(cell.q), X(qUp)), Math.max(X(cell.q), X(qUp)), col.za, col.zb, 1, cell.tint);
          } else if (qUp < cell.q && k + 1 < cells.length) {
            mb.rectY(cell.yb - d, Math.min(X(cell.q), X(qUp)), Math.max(X(cell.q), X(qUp)), col.za, col.zb, -1, cells[k + 1].tint * 0.75);
          }
          if (k === 0 && cell.q < qBelow) {
            mb.rectY(cell.ya - d, Math.min(X(cell.q), X(qBelow)), Math.max(X(cell.q), X(qBelow)), col.za, col.zb, -1, cell.tint * 0.75);
          }
        }
        // End faces against the next column (lower z), per overlapping y interval; segment ends close to BACK.
        const next = cols[c + 1];
        if (c === 0) this.endFaces(mb, side, col.zb, cells, null, 1);
        if (next) this.endFaces(mb, side, col.za, cells, next.cells, -1);
        else this.endFaces(mb, side, col.za, cells, null, -1);
      }
      for (const [za, zb, ya, yb, qf, qb, tint] of nested) {
        mb.win = 0.15;
        this.wallBox(mb, side, za, zb, ya, yb, qf, qb, tint, FACE.top | FACE.bottom | FACE.pz | FACE.nz);
      }
    }

    // Vertical ribs: a wide pilaster with a narrower spine, spanning most of the wall height. They stop just
    // behind the wall line: deeper parts would be buried in the modules.
    mb.win = 0;
    let z = z1 - 4 - hash2(i, 0, s + 20) * 8;
    let k = 0;
    const ribFaces = FACE.top | FACE.pz | FACE.nz;
    while (z > z0 + 2) {
      const w = 0.8 + hash2(i, k, s + 21) * 0.8;
      const top = hash2(i, k, s + 22) < 0.6 ? d - 1.2 : bands[Math.min(bands.length - 2, 3 + Math.floor(hash2(i, k, s + 23) * (bands.length - 4)))].y1;
      this.wallBox(mb, side, z - w, z + w, -GUTTER_D, top, -1.3, 0.3, 0.9, ribFaces);
      this.wallBox(mb, side, z - w * 0.45, z + w * 0.45, 0, top - 0.6, -2.2, -1.3, 0.95, ribFaces);
      z -= 10 + hash2(i, k, s + 24) * 10;
      k++;
    }
  }

  /**
   * Step faces at the z = `zc` boundary of a column (`cells`) facing `dir` (+1 = towards +z). Against `other`
   * (the neighbouring column) only the part where this column stands prouder is emitted; against nothing (segment
   * end) the face runs back to the back wall.
   */
  private endFaces(mb: MeshBuilder, side: number, zc: number, cells: Cell[], other: Cell[] | null, dir: number): void {
    const hw = TRENCH_HALF_WIDTH;
    const d = TRENCH_DEPTH;
    for (const cell of cells) {
      mb.win = cell.win;
      if (!other) {
        if (cell.q < BACK) {
          const xa = side * (hw + cell.q);
          const xb = side * (hw + BACK);
          mb.rectZ(zc, Math.min(xa, xb), Math.max(xa, xb), cell.ya - d, cell.yb - d, dir, cell.tint * 0.92);
        }
        continue;
      }
      for (const o of other) {
        const ya = Math.max(cell.ya, o.ya);
        const yb = Math.min(cell.yb, o.yb);
        if (yb <= ya) continue;
        // Emitted by whichever side is prouder; each column runs this against its next neighbour, so the
        // neighbour's prouder faces (facing back towards this column) are emitted here too.
        if (cell.q < o.q) {
          const xa = side * (hw + cell.q);
          const xb = side * (hw + o.q);
          mb.rectZ(zc, Math.min(xa, xb), Math.max(xa, xb), ya - d, yb - d, dir, cell.tint * 0.92);
        } else if (o.q < cell.q) {
          mb.win = o.win;
          const xa = side * (hw + o.q);
          const xb = side * (hw + cell.q);
          mb.rectZ(zc, Math.min(xa, xb), Math.max(xa, xb), ya - d, yb - d, -dir, o.tint * 0.92);
          mb.win = cell.win;
        }
      }
    }
  }

  private buildSegment(i: number): THREE.Mesh {
    const mb = new MeshBuilder();
    const hw = TRENCH_HALF_WIDTH;
    const d = TRENCH_DEPTH;
    const z1 = -i * SEG; // near end (higher z)
    const z0 = z1 - SEG;
    const s = this.seed;
    for (const side of [-1, 1]) this.buildWall(mb, i, side);

    // Floor: main deck, gutters along both wall feet (bottom + inner lip).
    const fx = hw - GUTTER_W;
    const gy = -d - GUTTER_D;
    mb.ground = -d;
    mb.win = 0;
    mb.ao = 0.4;
    mb.quad(-fx, -d, z1, fx, -d, z1, fx, -d, z0, -fx, -d, z0, 0, 1, 0, 0.8);
    mb.quad(-hw - BACK, gy, z1, -fx, gy, z1, -fx, gy, z0, -hw - BACK, gy, z0, 0, 1, 0, 0.5);
    mb.quad(fx, gy, z1, hw + BACK, gy, z1, hw + BACK, gy, z0, fx, gy, z0, 0, 1, 0, 0.5);
    mb.quad(-fx, gy, z0, -fx, gy, z1, -fx, -d, z1, -fx, -d, z0, -1, 0, 0, 0.6);
    mb.quad(fx, gy, z1, fx, gy, z0, fx, -d, z0, fx, -d, z1, 1, 0, 0, 0.6);
    // Conduits in the gutters and along the deck, continuous between segments.
    mb.ao = 0.3;
    for (const side of [-1, 1]) {
      mb.cylinder('z', side * (hw - 1.1), gy + 0.5, z0, SEG, 0.45, 8, 0.75, 0);
      mb.cylinder('z', side * 10.5, -d + 0.4, z0, SEG, 0.4, 8, 0.8, 0);
      mb.cylinder('z', side * 11.6, -d + 0.3, z0, SEG, 0.3, 6, 0.72, 0);
      mb.box(side * 6.2 - 0.15, -d, z0, side * 6.2 + 0.15, -d + 0.2, z1, 0.95);
    }
    // Deck plates and equipment boxes outside the centre lane (kept clear for the exhaust port).
    for (let k = 0; k < 14; k++) {
      const r = hash2(i, k, s + 21);
      const side = hash2(i, k, s + 25) < 0.5 ? -1 : 1;
      const zz = z1 - hash2(i, k, s + 26) * SEG;
      if (r < 0.5) {
        // Cross plate spanning from the centre lane to the gutter.
        const w = 2 + r * 6;
        const xa = 7 + hash2(i, k, s + 22) * 2;
        mb.cbox(Math.min(side * xa, side * fx), -d, zz - w, Math.max(side * xa, side * fx), -d + 0.15 + r * 0.4, zz, 0.7 + r * 0.3, 0.08);
      } else {
        const w = 1 + hash2(i, k, s + 22) * 3;
        const l = 1.5 + hash2(i, k, s + 23) * 5;
        const x = side * (8 + hash2(i, k, s + 24) * (fx - 10 - w));
        mb.cbox(x - w / 2, -d, zz - l, x + w / 2, -d + 0.4 + (r - 0.5) * 1.2, zz, 0.75 + r * 0.25, 0.12);
      }
    }

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
