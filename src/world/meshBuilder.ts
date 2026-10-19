// Fast append-only geometry writer for procedural hull architecture (boxes / quads with world-space UVs).
import * as THREE from 'three';
import { HULL_UV_SCALE } from './surfaceTextures';

export type Warp = (x: number, y: number, z: number) => number; // returns y offset (e.g. planet curvature)

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  constructor(private warp?: Warp) {}

  get vertexCount(): number {
    return this.pos.length / 3;
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
    const base = this.vertexCount;
    const corners = [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz];
    // Planar world UVs on the face's dominant plane.
    const anx = Math.abs(nx);
    const any = Math.abs(ny);
    for (let i = 0; i < 4; i++) {
      const x = corners[i * 3];
      const y = corners[i * 3 + 1];
      const z = corners[i * 3 + 2];
      const wy = this.warp ? y + this.warp(x, y, z) : y;
      this.pos.push(x, wy, z);
      this.nor.push(nx, ny, nz);
      if (any > 0.5) this.uv.push(x * HULL_UV_SCALE, z * HULL_UV_SCALE);
      else if (anx > 0.5) this.uv.push(z * HULL_UV_SCALE, y * HULL_UV_SCALE);
      else this.uv.push(x * HULL_UV_SCALE, y * HULL_UV_SCALE);
      this.col.push(tint, tint, tint * 1.02);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box; `bottom` false omits the underside (sitting on hull). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tint: number, bottom = false): void {
    const sideTint = tint * 0.92;
    // top (+Y)
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, tint);
    // +Z
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, sideTint);
    // -Z
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, sideTint);
    // +X
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, sideTint);
    // -X
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, sideTint);
    if (bottom) this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, sideTint * 0.8);
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

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
