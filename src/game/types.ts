import type * as THREE from 'three';

export type Team = 'rebel' | 'empire';

/** Anything that can be shot: ships and ground structures. */
export interface Targetable {
  readonly id: number;
  readonly team: Team;
  readonly pos: THREE.Vector3;
  readonly radius: number;
  readonly vel: THREE.Vector3;
  alive: boolean;
  /** Parametric hit along segment a→b in [0,1], or -1. */
  intersectSegment(a: THREE.Vector3, b: THREE.Vector3): number;
  takeDamage(amount: number, from: THREE.Vector3, attacker: Targetable | null): void;
}

let nextId = 1;
export function newId(): number {
  return nextId++;
}

const _d = { x: 0, y: 0, z: 0 };
/** Segment–sphere intersection; returns entry parameter in [0,1] or -1. */
export function segmentSphere(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, r: number): number {
  _d.x = b.x - a.x;
  _d.y = b.y - a.y;
  _d.z = b.z - a.z;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const fz = a.z - c.z;
  const A = _d.x * _d.x + _d.y * _d.y + _d.z * _d.z;
  const B = 2 * (fx * _d.x + fy * _d.y + fz * _d.z);
  const C = fx * fx + fy * fy + fz * fz - r * r;
  if (C <= 0) return 0;
  if (A < 1e-9) return -1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return -1;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : -1;
}
