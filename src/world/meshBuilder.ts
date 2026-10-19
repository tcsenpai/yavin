// Fast append-only geometry writer for procedural hull architecture: boxes, chamfered blocks, pipes and domes with
// world-space UVs and the per-vertex `aHullDet` data the hull shader uses (window grid, lit-window probability, AO).
import * as THREE from 'three';
import { HULL_UV_SCALE } from './surfaceTextures';

export type Warp = (x: number, y: number, z: number) => number; // returns y offset (e.g. planet curvature)

/** Box face flags for `boxFaces`. */
export const FACE = { top: 1, bottom: 2, px: 4, nx: 8, pz: 16, nz: 32, sides: 4 | 8 | 16 | 32 } as const;

export class MeshBuilder {
  /** Lit-window probability for vertical faces emitted next (0 = plain hull). */
  win = 0;
  /** Strength of the height-based ambient occlusion on vertical faces emitted next. */
  ao = 0;
  /** Local ground level (pre-warp y) that window rows and AO are measured from. */
  ground = 0;

  private pos = new Float32Array(3 * 4096);
  private nor = new Float32Array(3 * 4096);
  private uv = new Float32Array(2 * 4096);
  private col = new Float32Array(3 * 4096);
  private det = new Float32Array(4 * 4096);
  private idx = new Uint32Array(6 * 4096);
  private nv = 0;
  private ni = 0;

  constructor(private warp?: Warp) {}

  get vertexCount(): number {
    return this.nv;
  }

  get triangleCount(): number {
    return this.ni / 3;
  }

  private grow(verts: number, indices: number): void {
    if (this.nv + verts > this.pos.length / 3) {
      const cap = Math.max(this.pos.length / 3, this.nv + verts) * 2;
      const re = (a: Float32Array, k: number) => {
        const b = new Float32Array(cap * k);
        b.set(a);
        return b;
      };
      this.pos = re(this.pos, 3);
      this.nor = re(this.nor, 3);
      this.uv = re(this.uv, 2);
      this.col = re(this.col, 3);
      this.det = re(this.det, 4);
    }
    if (this.ni + indices > this.idx.length) {
      const b = new Uint32Array(Math.max(this.idx.length, this.ni + indices) * 2);
      b.set(this.idx);
      this.idx = b;
    }
  }

  /** One vertex; UVs are planar on the normal's dominant axis, windows only on (near-)vertical surfaces. */
  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, tint: number): void {
    const v = this.nv++;
    const p = v * 3;
    this.pos[p] = x;
    this.pos[p + 1] = this.warp ? y + this.warp(x, y, z) : y;
    this.pos[p + 2] = z;
    this.nor[p] = nx;
    this.nor[p + 1] = ny;
    this.nor[p + 2] = nz;
    this.col[p] = tint;
    this.col[p + 1] = tint;
    this.col[p + 2] = tint * 1.02;
    const anx = Math.abs(nx);
    const any = Math.abs(ny);
    const anz = Math.abs(nz);
    const t = v * 2;
    if (any >= anx && any >= anz) {
      this.uv[t] = x * HULL_UV_SCALE;
      this.uv[t + 1] = z * HULL_UV_SCALE;
    } else if (anx >= anz) {
      this.uv[t] = z * HULL_UV_SCALE;
      this.uv[t + 1] = y * HULL_UV_SCALE;
    } else {
      this.uv[t] = x * HULL_UV_SCALE;
      this.uv[t + 1] = y * HULL_UV_SCALE;
    }
    const d = v * 4;
    const vertical = any < 0.5;
    this.det[d] = anx >= anz ? z : x;
    this.det[d + 1] = y - this.ground;
    this.det[d + 2] = vertical ? this.win : 0;
    this.det[d + 3] = vertical ? this.ao : 0;
  }

  /** Quad from 4 corners (counter-clockwise seen from the normal side). */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    tint: number,
  ): void {
    this.grow(4, 6);
    const base = this.nv;
    this.vert(ax, ay, az, nx, ny, nz, tint);
    this.vert(bx, by, bz, nx, ny, nz, tint);
    this.vert(cx, cy, cz, nx, ny, nz, tint);
    this.vert(dx, dy, dz, nx, ny, nz, tint);
    const i = this.ni;
    this.idx[i] = base;
    this.idx[i + 1] = base + 1;
    this.idx[i + 2] = base + 2;
    this.idx[i + 3] = base;
    this.idx[i + 4] = base + 2;
    this.idx[i + 5] = base + 3;
    this.ni += 6;
  }

  /** Axis-aligned box; `bottom` false omits the underside (sitting on hull). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tint: number, bottom = false): void {
    this.boxFaces(x0, y0, z0, x1, y1, z1, tint, bottom ? 63 : 63 & ~FACE.bottom);
  }

  /** Axis-aligned box emitting only the faces in `faces` (FACE flags). */
  boxFaces(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tint: number, faces: number): void {
    const side = tint * 0.92;
    if (faces & FACE.top) this.rectY(y1, x0, x1, z0, z1, 1, tint);
    if (faces & FACE.pz) this.rectZ(z1, x0, x1, y0, y1, 1, side);
    if (faces & FACE.nz) this.rectZ(z0, x0, x1, y0, y1, -1, side);
    if (faces & FACE.px) this.rectX(x1, y0, y1, z0, z1, 1, side);
    if (faces & FACE.nx) this.rectX(x0, y0, y1, z0, z1, -1, side);
    if (faces & FACE.bottom) this.rectY(y0, x0, x1, z0, z1, -1, side * 0.8);
  }

  /** Rectangle in the plane x = const facing +X (dir > 0) or −X; requires y0 < y1, z0 < z1. */
  rectX(x: number, y0: number, y1: number, z0: number, z1: number, dir: number, tint: number): void {
    if (dir > 0) this.quad(x, y0, z1, x, y0, z0, x, y1, z0, x, y1, z1, 1, 0, 0, tint);
    else this.quad(x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0, -1, 0, 0, tint);
  }

  /** Rectangle in the plane y = const facing +Y (dir > 0) or −Y; requires x0 < x1, z0 < z1. */
  rectY(y: number, x0: number, x1: number, z0: number, z1: number, dir: number, tint: number): void {
    if (dir > 0) this.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, 0, 1, 0, tint);
    else this.quad(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, 0, -1, 0, tint);
  }

  /** Rectangle in the plane z = const facing +Z (dir > 0) or −Z; requires x0 < x1, y0 < y1. */
  rectZ(z: number, x0: number, x1: number, y0: number, y1: number, dir: number, tint: number): void {
    if (dir > 0) this.quad(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z, 0, 0, 1, tint);
    else this.quad(x1, y0, z, x0, y0, z, x0, y1, z, x1, y1, z, 0, 0, -1, tint);
  }

  /**
   * Box whose top edges are chamfered by `c` (45° bevels catch the light like the miniature's worn edges).
   * Footprint and height are exactly the box's, so collision against the box stays valid.
   */
  cbox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tint: number, c: number): void {
    c = Math.min(c, (x1 - x0) * 0.3, (z1 - z0) * 0.3, (y1 - y0) * 0.5);
    if (c < 0.05) {
      this.box(x0, y0, z0, x1, y1, z1, tint);
      return;
    }
    const yc = y1 - c;
    const side = tint * 0.92;
    const bevel = Math.min(1.25, tint * 1.12); // worn, lighter edges
    const s = Math.SQRT1_2;
    // top
    this.quad(x0 + c, y1, z1 - c, x1 - c, y1, z1 - c, x1 - c, y1, z0 + c, x0 + c, y1, z0 + c, 0, 1, 0, tint);
    // bevels
    this.quad(x0, yc, z1, x1, yc, z1, x1 - c, y1, z1 - c, x0 + c, y1, z1 - c, 0, s, s, bevel);
    this.quad(x1, yc, z0, x0, yc, z0, x0 + c, y1, z0 + c, x1 - c, y1, z0 + c, 0, s, -s, bevel);
    this.quad(x1, yc, z1, x1, yc, z0, x1 - c, y1, z0 + c, x1 - c, y1, z1 - c, s, s, 0, bevel);
    this.quad(x0, yc, z0, x0, yc, z1, x0 + c, y1, z1 - c, x0 + c, y1, z0 + c, -s, s, 0, bevel);
    // sides
    this.quad(x0, y0, z1, x1, y0, z1, x1, yc, z1, x0, yc, z1, 0, 0, 1, side);
    this.quad(x1, y0, z0, x0, y0, z0, x0, yc, z0, x1, yc, z0, 0, 0, -1, side);
    this.quad(x1, y0, z1, x1, y0, z0, x1, yc, z0, x1, yc, z1, 1, 0, 0, side);
    this.quad(x0, y0, z0, x0, y0, z1, x0, yc, z1, x0, yc, z0, -1, 0, 0, side);
  }

  /** Subdivided horizontal plane (so warp/curvature bends it smoothly). */
  plane(x0: number, z0: number, x1: number, z1: number, y: number, seg: number, tint: number): void {
    const sx = (x1 - x0) / seg;
    const sz = (z1 - z0) / seg;
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < seg; j++) {
        const ax = x0 + i * sx;
        const az = z0 + j * sz;
        this.quad(ax, y, az + sz, ax + sx, y, az + sz, ax + sx, y, az, ax, y, az, 0, 1, 0, tint);
      }
    }
  }

  /**
   * Smooth-shaded cylinder (pipe / tank / mast) from (ax,ay,az) along `axis` for `len` metres.
   * `caps` closes the far end (and the near end when `caps` is 2).
   */
  cylinder(axis: 'x' | 'y' | 'z', ax: number, ay: number, az: number, len: number, r: number, sides: number, tint: number, caps = 0): void {
    this.grow(sides * 2 + 2 * (sides + 1), sides * 6 + caps * sides * 3);
    // Local frame: a = axis, (u, w) = cross-section plane.
    const P = (t: number, cu: number, cw: number, out: number[]) => {
      if (axis === 'x') { out[0] = ax + t; out[1] = ay + cu; out[2] = az + cw; }
      else if (axis === 'y') { out[0] = ax + cu; out[1] = ay + t; out[2] = az + cw; }
      else { out[0] = ax + cu; out[1] = ay + cw; out[2] = az + t; }
    };
    const p: number[] = [0, 0, 0];
    const n: number[] = [0, 0, 0];
    const base = this.nv;
    for (let k = 0; k < sides; k++) {
      const a = ((k + 0.5) / sides) * Math.PI * 2;
      const cu = Math.cos(a);
      const cw = Math.sin(a);
      // normal = P(0, cu, cw) - P(0, 0, 0)
      if (axis === 'x') { n[0] = 0; n[1] = cu; n[2] = cw; }
      else if (axis === 'y') { n[0] = cu; n[1] = 0; n[2] = cw; }
      else { n[0] = cu; n[1] = cw; n[2] = 0; }
      // Upward-facing pipe flanks are lit like hull; underside slightly darker.
      const shade = tint * (0.86 + 0.14 * Math.max(0, n[1]));
      P(0, cu * r, cw * r, p);
      this.vert(p[0], p[1], p[2], n[0], n[1], n[2], shade);
      P(len, cu * r, cw * r, p);
      this.vert(p[0], p[1], p[2], n[0], n[1], n[2], shade);
    }
    // Winding: outward faces CCW. For axis y with (u,w)=(x,z) the handedness flips relative to x/z axes.
    const flip = axis === 'y';
    for (let k = 0; k < sides; k++) {
      const a0 = base + k * 2;
      const a1 = base + ((k + 1) % sides) * 2;
      const i = this.ni;
      if (!flip) {
        this.idx[i] = a0; this.idx[i + 1] = a1; this.idx[i + 2] = a1 + 1;
        this.idx[i + 3] = a0; this.idx[i + 4] = a1 + 1; this.idx[i + 5] = a0 + 1;
      } else {
        this.idx[i] = a0; this.idx[i + 1] = a1 + 1; this.idx[i + 2] = a1;
        this.idx[i + 3] = a0; this.idx[i + 4] = a0 + 1; this.idx[i + 5] = a1 + 1;
      }
      this.ni += 6;
    }
    for (let e = 0; e < caps; e++) {
      const t = e === 0 ? len : 0;
      const sgn = (e === 0 ? 1 : -1) * Math.sign(len || 1);
      const nxv = axis === 'x' ? sgn : 0;
      const nyv = axis === 'y' ? sgn : 0;
      const nzv = axis === 'z' ? sgn : 0;
      const c0 = this.nv;
      P(t, 0, 0, p);
      this.vert(p[0], p[1], p[2], nxv, nyv, nzv, tint * 1.05);
      for (let k = 0; k < sides; k++) {
        const a = ((k + 0.5) / sides) * Math.PI * 2;
        P(t, Math.cos(a) * r, Math.sin(a) * r, p);
        this.vert(p[0], p[1], p[2], nxv, nyv, nzv, tint * 1.05);
      }
      // Cap winding depends on which way it faces relative to the ring order.
      const ccw = (sgn > 0) !== flip;
      for (let k = 0; k < sides; k++) {
        const i = this.ni;
        const b0 = c0 + 1 + k;
        const b1 = c0 + 1 + ((k + 1) % sides);
        this.idx[i] = c0;
        this.idx[i + 1] = ccw ? b0 : b1;
        this.idx[i + 2] = ccw ? b1 : b0;
        this.ni += 3;
      }
    }
  }

  /** Smooth hemisphere of radius r sitting on y (optionally squashed vertically by `sy`). */
  dome(cx: number, y: number, cz: number, r: number, tint: number, sy = 1, sides = 12, rings = 4): void {
    this.grow((rings + 1) * sides, rings * sides * 6);
    const base = this.nv;
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI * 0.5; // 0 = equator, pi/2 = pole
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const nx = cp * Math.cos(a);
        const nz = cp * Math.sin(a);
        // Normal of the squashed ellipsoid.
        const ny = sp / sy;
        const inv = 1 / Math.hypot(nx, ny, nz);
        this.vert(cx + nx * r, y + sp * r * sy, cz + nz * r, nx * inv, ny * inv, nz * inv, tint * (0.9 + 0.15 * sp));
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let k = 0; k < sides; k++) {
        const a = base + j * sides + k;
        const b = base + j * sides + ((k + 1) % sides);
        const c = b + sides;
        const d = a + sides;
        const i = this.ni;
        this.idx[i] = a; this.idx[i + 1] = d; this.idx[i + 2] = c;
        this.idx[i + 3] = a; this.idx[i + 4] = c; this.idx[i + 5] = b;
        this.ni += 6;
      }
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.nv;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    g.setAttribute('aHullDet', new THREE.BufferAttribute(this.det.slice(0, n * 4), 4));
    const idx = n > 65535 ? this.idx.slice(0, this.ni) : Uint16Array.from(this.idx.subarray(0, this.ni));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
