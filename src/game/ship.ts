// Ships: specs, arcade flight model, damage (deflector shields + hull), cannons.
import * as THREE from 'three';
import { clamp, damp } from '../core/rng';
import type { StringKey } from '../i18n/i18n';
import {
  createFalcon,
  createTIEAdvanced,
  createTIEFighter,
  createXWing,
  createYWing,
  type GunShipModel,
  type XWingModel,
} from '../models/ships';
import { newId, segmentSphere, type Targetable, type Team } from './types';
import type { World } from './world';

export type ShipKind = 'xwing' | 'ywing' | 'tie' | 'tieadv' | 'falcon';

export interface ShipSpec {
  minSpeed: number;
  maxSpeed: number;
  accel: number;
  pitchRate: number; // rad/s
  yawRate: number;
  rollRate: number;
  hull: number;
  shields: number; // per arc (fore/aft); 0 = no deflector shields (TIE/ln)
  radius: number;
  fireInterval: number;
  boltSpeed: number;
  damage: number;
  bolt: 'red' | 'green';
  team: Team;
}

// T-65 X-wing: ~1050 km/h in atmosphere; TIE/ln faster and nimbler but unshielded.
export const SPECS: Record<ShipKind, ShipSpec> = {
  xwing: { minSpeed: 70, maxSpeed: 230, accel: 70, pitchRate: 1.2, yawRate: 0.7, rollRate: 2.3, hull: 100, shields: 60, radius: 6.5, fireInterval: 0.17, boltSpeed: 800, damage: 18, bolt: 'red', team: 'rebel' },
  ywing: { minSpeed: 60, maxSpeed: 190, accel: 50, pitchRate: 1.1, yawRate: 0.8, rollRate: 2.0, hull: 140, shields: 80, radius: 8, fireInterval: 0.3, boltSpeed: 750, damage: 18, bolt: 'red', team: 'rebel' },
  tie: { minSpeed: 80, maxSpeed: 255, accel: 90, pitchRate: 1.9, yawRate: 1.4, rollRate: 3.4, hull: 34, shields: 0, radius: 4.5, fireInterval: 0.26, boltSpeed: 750, damage: 9, bolt: 'green', team: 'empire' },
  tieadv: { minSpeed: 80, maxSpeed: 260, accel: 90, pitchRate: 1.9, yawRate: 1.4, rollRate: 3.2, hull: 300, shields: 120, radius: 5, fireInterval: 0.2, boltSpeed: 800, damage: 14, bolt: 'green', team: 'empire' },
  falcon: { minSpeed: 80, maxSpeed: 270, accel: 80, pitchRate: 1.0, yawRate: 0.8, rollRate: 1.6, hull: 600, shields: 300, radius: 18, fireInterval: 0.09, boltSpeed: 850, damage: 25, bolt: 'red', team: 'rebel' },
};

export type Deflectors = 'balanced' | 'front' | 'rear';

export interface ShipControls {
  pitch: number;
  yaw: number;
  roll: number;
  fire: boolean;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m = new THREE.Vector3();

export class Ship implements Targetable {
  readonly id = newId();
  readonly spec: ShipSpec;
  readonly team: Team;
  readonly model: GunShipModel | XWingModel;
  readonly vel = new THREE.Vector3();
  readonly ctrl: ShipControls = { pitch: 0, yaw: 0, roll: 0, fire: false };
  readonly angVel = new THREE.Vector3();
  alive = true;
  /** Plot armour: damage is visual only (scripted characters). */
  invulnerable = false;
  isPlayer = false;
  throttle = 0.7;
  speed: number;
  hull: number;
  shieldFore: number;
  shieldAft: number;
  deflectors: Deflectors = 'balanced';
  sfoils = 1; // X-wing only: 0 closed .. 1 attack position
  sfoilTarget = 1;
  fireCooldown = 0;
  private cannon = 0;
  sinceHit = 99;
  lastAttacker: Targetable | null = null;
  /** Free slot for AI brains. */
  brain: { update(ship: Ship, world: World, dt: number): void } | null = null;
  /** Called once when destroyed. */
  onDestroyed: ((s: Ship) => void) | null = null;
  /** Visual damage smoke-trail intensity 0..1 (also forced by scripts, e.g. Wedge hit). */
  damageSmoke = 0;
  /** Scripted ships positioned directly by their brain (trench run choreography). */
  kinematic = false;

  constructor(
    readonly kind: ShipKind,
    readonly nameKey: StringKey | null,
    opts: { stripeColor?: number } = {},
  ) {
    this.spec = SPECS[kind];
    this.team = this.spec.team;
    switch (kind) {
      case 'xwing':
        this.model = createXWing({ stripeColor: opts.stripeColor });
        break;
      case 'ywing':
        this.model = createYWing({ stripeColor: opts.stripeColor });
        break;
      case 'tie':
        this.model = createTIEFighter();
        break;
      case 'tieadv':
        this.model = createTIEAdvanced();
        break;
      case 'falcon':
        this.model = createFalcon();
        break;
    }
    this.speed = this.spec.minSpeed + (this.spec.maxSpeed - this.spec.minSpeed) * this.throttle;
    this.hull = this.spec.hull;
    this.shieldFore = this.spec.shields;
    this.shieldAft = this.spec.shields;
  }

  get pos(): THREE.Vector3 {
    return this.model.root.position;
  }
  get quat(): THREE.Quaternion {
    return this.model.root.quaternion;
  }
  get radius(): number {
    return this.spec.radius;
  }

  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }
  up(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 1, 0).applyQuaternion(this.quat);
  }
  right(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(1, 0, 0).applyQuaternion(this.quat);
  }

  shieldMax(arc: 'fore' | 'aft'): number {
    const s = this.spec.shields;
    if (this.deflectors === 'balanced') return s;
    const strong = (this.deflectors === 'front') === (arc === 'fore');
    return strong ? s * 2 : 0;
  }

  setDeflectors(d: Deflectors): void {
    this.deflectors = d;
    // Redistribute: double front shunts all power fore (as ordered on the approach).
    const total = this.shieldFore + this.shieldAft;
    this.shieldFore = Math.min(this.shieldMax('fore'), d === 'rear' ? 0 : d === 'front' ? total : total / 2);
    this.shieldAft = Math.min(this.shieldMax('aft'), total - this.shieldFore);
  }

  intersectSegment(a: THREE.Vector3, b: THREE.Vector3): number {
    return segmentSphere(a, b, this.pos, this.radius);
  }

  takeDamage(amount: number, from: THREE.Vector3, attacker: Targetable | null): void {
    if (!this.alive) return;
    this.sinceHit = 0;
    this.lastAttacker = attacker;
    if (this.invulnerable) return;
    const fore = this.forward(_v).dot(_m.copy(from).sub(this.pos)) >= 0;
    let rest = amount;
    if (fore) {
      const a = Math.min(this.shieldFore, rest);
      this.shieldFore -= a;
      rest -= a;
    } else {
      const a = Math.min(this.shieldAft, rest);
      this.shieldAft -= a;
      rest -= a;
    }
    this.hull -= rest;
  }

  /** Arcade flight model. */
  updateFlight(dt: number): void {
    if (this.kinematic) {
      if (this.kind === 'xwing') (this.model as XWingModel).setSFoils(this.sfoils);
      this.model.setThrottle(clamp(this.speed / this.spec.maxSpeed, 0, 1));
      this.model.update(dt);
      return;
    }
    const s = this.spec;
    const k = damp(this.isPlayer ? 3.8 : 5, dt);
    this.angVel.x += (this.ctrl.pitch * s.pitchRate - this.angVel.x) * k;
    this.angVel.y += (-this.ctrl.yaw * s.yawRate - this.angVel.y) * k;
    this.angVel.z += (-this.ctrl.roll * s.rollRate - this.angVel.z) * k;
    _e.set(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, 'YXZ');
    _q.setFromEuler(_e);
    this.quat.multiply(_q).normalize();

    // S-foils closed: cruise configuration — cannons offline, slightly faster.
    const target = s.minSpeed + (s.maxSpeed - s.minSpeed) * clamp(this.throttle, 0, 1) + (this.kind === 'xwing' ? (1 - this.sfoils) * 15 : 0);
    const ds = clamp(target - this.speed, -s.accel * dt, s.accel * dt);
    this.speed += ds;
    this.forward(_fwd).multiplyScalar(this.speed);
    this.vel.lerp(_fwd, damp(3.2, dt));
    this.pos.addScaledVector(this.vel, dt);

    if (this.kind === 'xwing') {
      this.sfoils += clamp(this.sfoilTarget - this.sfoils, -dt * 0.9, dt * 0.9);
      (this.model as XWingModel).setSFoils(this.sfoils);
    }
    this.model.setThrottle(clamp(this.speed / s.maxSpeed, 0, 1));
    this.model.update(dt);

    // Deflector regeneration after 2.5 s without hits.
    this.sinceHit += dt;
    if (s.shields > 0 && this.sinceHit > 2.5) {
      this.shieldFore = Math.min(this.shieldMax('fore'), this.shieldFore + s.shields * 0.12 * dt);
      this.shieldAft = Math.min(this.shieldMax('aft'), this.shieldAft + s.shields * 0.12 * dt);
    }
  }

  get canFire(): boolean {
    return this.kind !== 'xwing' || this.sfoils > 0.97;
  }

  /**
   * Fire cannons toward `aim` (world point). X-wings fire alternating diagonal pairs of wingtip cannons,
   * converging on the aim point.
   */
  fireCannons(world: World, aim: THREE.Vector3 | null): boolean {
    if (this.fireCooldown > 0 || !this.canFire) return false;
    this.fireCooldown = this.spec.fireInterval;
    const muzzles = this.model.cannonMuzzles;
    let group: THREE.Object3D[];
    if (this.kind === 'xwing' && muzzles.length === 4) {
      group = this.cannon % 2 === 0 ? [muzzles[0], muzzles[3]] : [muzzles[1], muzzles[2]];
    } else if (this.kind === 'falcon' || muzzles.length < 2) {
      group = [muzzles[this.cannon % Math.max(1, muzzles.length)]];
    } else {
      group = muzzles.slice(0, 2);
    }
    this.cannon++;
    this.model.root.updateMatrixWorld();
    const fwd = this.forward(_fwd);
    for (const m of group) {
      if (!m) continue;
      const origin = m.getWorldPosition(new THREE.Vector3());
      const dir = aim ? aim.clone().sub(origin).normalize() : fwd.clone();
      // Never fire backwards through the convergence point.
      if (dir.dot(fwd) < 0.9) dir.copy(fwd);
      world.weapons.fireBolt(this, origin, dir, this.spec.boltSpeed, this.spec.bolt, this.spec.damage);
      world.fx.muzzle(origin, this.vel);
    }
    world.audio.laser(this.kind === 'xwing' || this.kind === 'ywing' ? 'xwing' : this.kind === 'falcon' ? 'falcon' : 'tie', this.isPlayer ? undefined : this.pos);
    return true;
  }
}
