// Spawning helpers shared by levels.
import * as THREE from 'three';
import { clamp } from '../core/rng';
import { DogfightBrain } from '../game/ai';
import { Ship, type ShipKind } from '../game/ship';
import type { StringKey } from '../i18n/i18n';
import type { LevelContext } from './context';

export const RED = 0xb0282a;
export const GOLD = 0xc9a227;

export function spawnPlayer(ctx: LevelContext, pos: THREE.Vector3, heading = new THREE.Quaternion()): Ship {
  const s = new Ship('xwing', 'spk.luke', { stripeColor: RED });
  s.isPlayer = true;
  s.pos.copy(pos);
  s.quat.copy(heading);
  s.vel.set(0, 0, -1).applyQuaternion(heading).multiplyScalar(s.speed);
  ctx.world.addShip(s);
  ctx.world.player = s;
  ctx.player = s;
  s.damageTakenScale = ctx.difficulty ** 1.5;
  return s;
}

export function spawnShip(ctx: LevelContext, kind: ShipKind, nameKey: StringKey | null, pos: THREE.Vector3, heading?: THREE.Quaternion, stripe?: number): Ship {
  // Below Pilot difficulty TIE fighters lose their edge over the X-wing (top speed under ours, slower turns),
  // so the player can turn the tables and chase them down. Cadet (0.5) gets the full reduction.
  const easy = kind === 'tie' ? clamp((1 - ctx.difficulty) * 2, 0, 1) : 0;
  const s = new Ship(kind, nameKey, { stripeColor: stripe, agility: easy > 0 ? { speed: 1 - 0.15 * easy, turn: 1 - 0.4 * easy } : undefined });
  s.pos.copy(pos);
  if (heading) s.quat.copy(heading);
  s.vel.set(0, 0, -1).applyQuaternion(s.quat).multiplyScalar(s.speed);
  // Rebel AI pilots soften targets but the player should score most kills.
  if (s.team === 'rebel') s.damageScale = 0.22;
  ctx.world.addShip(s);
  return s;
}

/** Quaternion looking from `from` toward `to` (object forward = -Z). */
export function lookQuat(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  const m = new THREE.Matrix4().lookAt(from, to, new THREE.Vector3(0, 1, 0));
  // Matrix4.lookAt makes +Z point from `to` to `from`, i.e. -Z faces `to`.
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** Spawn a TIE group arriving from `from`, heading toward `toward`. */
export function spawnTies(ctx: LevelContext, count: number, from: THREE.Vector3, toward: THREE.Vector3, skill: number, minAlt: number, leash?: { center: THREE.Vector3; radius: number }): Ship[] {
  const out: Ship[] = [];
  const q = lookQuat(from, toward);
  for (let i = 0; i < count; i++) {
    const off = new THREE.Vector3((i % 3) * 30 - 30, Math.floor(i / 3) * 20 + (i % 2) * 10, Math.floor(i / 3) * 40).applyQuaternion(q);
    const s = spawnShip(ctx, 'tie', null, from.clone().add(off), q);
    s.throttle = 1;
    s.brain = new DogfightBrain({ skill: skill * ctx.difficulty, minAltitude: minAlt, leash });
    out.push(s);
  }
  return out;
}
