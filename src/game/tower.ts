// Imperial gun emplacements: surface turbolaser towers and trench wall turrets.
import * as THREE from 'three';
import { createTurbolaserTower, createWallTurret, type TowerModel } from '../models/ships';
import { newId, segmentSphere, type Targetable } from './types';
import type { World } from './world';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Vector3();
const _inv = new THREE.Quaternion();

export class Tower implements Targetable {
  readonly id = newId();
  readonly team = 'empire' as const;
  readonly vel = new THREE.Vector3();
  readonly model: TowerModel;
  readonly pos = new THREE.Vector3(); // aim/hit centre (turret head)
  alive = true;
  hp: number;
  readonly maxHp: number;
  /** Seconds between shots (scaled by difficulty). */
  interval: number;
  cooldown: number;
  range: number;
  /** Weapons hold (trench: "the guns... they've stopped"). */
  silenced = false;
  /** Aim error in radians. */
  spread: number;
  readonly radius: number;
  objective = false;
  onDestroyed: ((t: Tower) => void) | null = null;

  constructor(readonly kind: 'tower' | 'wall', seed: number, base: THREE.Vector3, normal: THREE.Vector3, difficulty: number) {
    this.model = kind === 'tower' ? createTurbolaserTower(seed) : createWallTurret();
    const root = this.model.root;
    root.position.copy(base);
    root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    root.updateMatrixWorld(true);
    this.model.turret.getWorldPosition(this.pos);
    this.radius = kind === 'tower' ? Math.max(this.model.radius, 7) : 4;
    this.maxHp = this.hp = kind === 'tower' ? 90 : 30;
    this.interval = (kind === 'tower' ? 1.6 : 4) / difficulty;
    this.cooldown = 1 + (seed % 7) * 0.3;
    this.range = kind === 'tower' ? 1600 : 650;
    this.spread = (kind === 'tower' ? 0.03 : 0.11) / difficulty;
  }

  /** Towers are tall: test a sphere at the turret head plus spheres down the shaft. */
  intersectSegment(a: THREE.Vector3, b: THREE.Vector3): number {
    let t = segmentSphere(a, b, this.pos, this.radius);
    if (t >= 0 || this.kind !== 'tower') return t;
    const base = this.model.root.position;
    const steps = Math.max(1, Math.floor(this.model.height / 10));
    for (let i = 0; i < steps; i++) {
      _a.copy(base).lerp(this.pos, i / steps);
      t = segmentSphere(a, b, _a, this.model.radius * 0.9);
      if (t >= 0) return t;
    }
    return -1;
  }

  takeDamage(amount: number): void {
    if (!this.alive) return;
    this.hp -= amount;
  }

  update(world: World, dt: number): void {
    if (!this.alive) return;
    this.cooldown -= dt;
    let target: Targetable | null = null;
    let best = this.range * this.range;
    for (const s of world.ships) {
      if (!s.alive || s.team !== 'rebel') continue;
      const d = s.pos.distanceToSquared(this.pos);
      // Strong preference for the player keeps the pressure where it matters.
      const w = s.isPlayer ? d * 0.45 : d;
      if (w < best) {
        best = w;
        target = s;
      }
    }
    if (!target) return;
    const dist = target.pos.distanceTo(this.pos);
    const speed = this.kind === 'tower' ? 520 : 650;
    // Lead the target (trench guns only partially: they are tracking a fighter at full throttle).
    _a.copy(target.pos).addScaledVector(target.vel, (dist / speed) * (this.kind === 'tower' ? 1 : 0.35));
    _b.copy(_a).sub(this.pos).normalize();
    // Aim turret (yaw) and barrels (pitch) in the root's local frame.
    _inv.copy(this.model.root.quaternion).invert();
    const local = _a.copy(_b).applyQuaternion(_inv);
    const yaw = Math.atan2(-local.x, -local.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, local.y)));
    this.model.turret.rotation.y += (yaw - this.model.turret.rotation.y) * Math.min(1, dt * 4);
    this.model.barrels.rotation.x += (Math.max(-0.2, pitch) - this.model.barrels.rotation.x) * Math.min(1, dt * 4);
    // Upward-facing turrets can't shoot into the hull; trench guns only engage fighters still closing on them.
    const receding = this.kind === 'wall' && target.vel.dot(_c.copy(this.pos).sub(target.pos)) < 0;
    if (this.silenced || this.cooldown > 0 || local.y < -0.15 || receding) return;
    this.cooldown = this.interval * (0.7 + Math.random() * 0.6);
    for (const m of this.model.muzzles) {
      m.getWorldPosition(_a);
      _q.setFromEuler(new THREE.Euler((Math.random() - 0.5) * this.spread * 2, (Math.random() - 0.5) * this.spread * 2, 0));
      const dir = _b.clone().applyQuaternion(_q);
      world.weapons.fireBolt(this, _a, dir, speed, 'green', this.kind === 'tower' ? 16 : 6, 'empire', this.kind === 'tower');
    }
    world.audio.laser('turbolaser', this.pos);
  }
}
