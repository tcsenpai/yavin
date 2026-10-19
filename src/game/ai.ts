// AI pilots: dogfighting, formation flying and kinematic choreography for scripted moments.
import * as THREE from 'three';
import { clamp, damp } from '../core/rng';
import type { Ship } from './ship';
import type { Targetable } from './types';
import type { World } from './world';

const _l = new THREE.Vector3();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _aim = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _zero = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);

/**
 * Turn a desired world direction into stick inputs: yaw/pitch toward it, and bank into the turn
 * relative to the world up (fighter-style coordinated turn).
 */
export function steerToward(ship: Ship, dir: THREE.Vector3, gain = 2.2, maxBank = 1.1): void {
  _inv.copy(ship.quat).invert();
  _l.copy(dir).normalize().applyQuaternion(_inv);
  const yawErr = Math.atan2(_l.x, -_l.z);
  const pitchErr = Math.atan2(_l.y, Math.hypot(_l.x, _l.z) * Math.sign(-_l.z || 1));
  ship.ctrl.yaw = clamp(yawErr * gain, -1, 1);
  ship.ctrl.pitch = clamp(pitchErr * gain, -1, 1);
  // Bank: right-vector elevation tells the current roll.
  ship.right(_r);
  const bank = -Math.asin(clamp(_r.y, -1, 1));
  const wantBank = clamp(yawErr * 1.4, -maxBank, maxBank);
  ship.ctrl.roll = clamp((wantBank - bank) * 2.2, -1, 1);
}

/** Pull up if the hull (or trench floor) is close ahead. Returns true while avoiding. */
function avoidGround(ship: Ship, world: World, dir: THREE.Vector3, minAlt: number): boolean {
  if (!world.surface) return false;
  const look = 1.6;
  const px = ship.pos.x + ship.vel.x * look;
  const pz = ship.pos.z + ship.vel.z * look;
  const py = ship.pos.y + ship.vel.y * look;
  const h = Math.max(world.surface.heightAt(px, pz), world.surface.heightAt(ship.pos.x, ship.pos.z));
  const margin = py - (h + minAlt);
  if (margin < 0) {
    dir.y += clamp(-margin / minAlt, 0.4, 3);
    dir.normalize();
    return true;
  }
  return false;
}

export interface DogfightOptions {
  /** 0..1, scales accuracy and willingness to fire. */
  skill: number;
  minAltitude: number;
  /** Optional target override (e.g. TIEs ordered to hunt the player, a TIE chasing Biggs). */
  forcedTarget?: () => Targetable | null;
  /** Keep the fight near a point. */
  leash?: { center: THREE.Vector3; radius: number };
  /** Rebel wingmen only shoot what's in front and don't hog the player's kills. */
  fireScale?: number;
}

export class DogfightBrain {
  target: Targetable | null = null;
  private retarget = 0;
  private mode: 'attack' | 'extend' | 'evade' = 'attack';
  private modeT = 0;
  private jink = new THREE.Vector3();
  constructor(public opts: DogfightOptions) {}

  private pickTarget(ship: Ship, world: World): Targetable | null {
    const forced = this.opts.forcedTarget?.();
    if (forced?.alive) return forced;
    let best: Targetable | null = null;
    let bestScore = Infinity;
    ship.forward(_d);
    for (const s of world.ships) {
      if (!s.alive || s.team === ship.team) continue;
      _l.copy(s.pos).sub(ship.pos);
      const dist = _l.length();
      const ahead = _l.dot(_d) / Math.max(dist, 1);
      const score = dist * (1.6 - ahead) * (s.isPlayer ? 0.7 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  update(ship: Ship, world: World, dt: number): void {
    this.retarget -= dt;
    this.modeT -= dt;
    if (this.retarget <= 0 || !this.target?.alive) {
      this.target = this.pickTarget(ship, world);
      this.retarget = 1.5 + Math.random();
    }
    const dir = _d;
    ship.ctrl.fire = false;
    if (ship.sinceHit < 0.05 && this.mode === 'attack' && Math.random() < 0.5) {
      this.mode = 'evade';
      this.modeT = 1.2 + Math.random();
      this.jink.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
    }
    if (this.mode !== 'attack' && this.modeT <= 0) this.mode = 'attack';

    const t = this.target;
    if (this.mode === 'evade') {
      ship.forward(dir).addScaledVector(this.jink, 1.5).normalize();
      ship.throttle = 1;
    } else if (this.mode === 'extend' || !t) {
      ship.forward(dir);
      dir.y += 0.15;
      if (this.opts.leash) {
        _l.copy(this.opts.leash.center).sub(ship.pos);
        if (_l.length() > this.opts.leash.radius * 0.6) dir.addScaledVector(_l.normalize(), 1.2);
      }
      dir.normalize();
      ship.throttle = 1;
    } else {
      const dist = t.pos.distanceTo(ship.pos);
      const lead = dist / ship.spec.boltSpeed;
      _aim.copy(t.pos).addScaledVector(t.vel, lead * clamp(this.opts.skill * 1.2, 0, 1));
      // Imperfect gunnery: a slowly wandering aim error that shrinks with skill. Chasing the player from
      // directly behind is the deadliest geometry, so tail shots get extra error (the player must get time to break).
      const tp = t as Ship; // isPlayer is only set on ships; other Targetables read undefined
      const onTail = tp.isPlayer === true && tp.forward(_l).dot(_r.copy(t.pos).sub(ship.pos).normalize()) > 0.7;
      const err = dist * 0.035 * clamp(1.25 - this.opts.skill, 0.15, 1.2) * (onTail ? 1.8 : 1);
      const ph = ship.id * 1.7 + world.time * 0.9;
      _aim.x += Math.sin(ph) * err;
      _aim.y += Math.cos(ph * 1.3) * err;
      _aim.z += Math.sin(ph * 0.7 + 1) * err;
      dir.copy(_aim).sub(ship.pos).normalize();
      ship.forward(_r);
      const cos = _r.dot(dir);
      ship.throttle = dist < 260 && cos > 0.5 ? clamp(t.vel.length() / ship.spec.maxSpeed, 0.4, 1) : 1;
      const cone = 0.995 - (1 - this.opts.skill) * 0.012;
      const fireScale = this.opts.fireScale ?? 1;
      // Fire in bursts (about 40 % duty cycle), never a continuous stream.
      const burst = (world.time * 0.4 + ship.id * 0.37) % 1 < 0.3 + 0.15 * this.opts.skill;
      if (burst && cos > cone && dist < 850 && Math.random() < 0.75 * fireScale) ship.ctrl.fire = true;
      if (dist < 70 + ship.radius * 4 && cos > 0) {
        this.mode = 'extend';
        this.modeT = 2 + Math.random() * 1.5;
      }
    }
    if (this.opts.leash) {
      _l.copy(this.opts.leash.center).sub(ship.pos);
      const over = _l.length() - this.opts.leash.radius;
      if (over > 0) dir.addScaledVector(_l.normalize(), clamp(over / 400, 0.2, 2)).normalize();
    }
    avoidGround(ship, world, dir, this.opts.minAltitude);
    steerToward(ship, dir);
    if (ship.ctrl.fire) ship.fireCannons(world, t ? _aim : null);
  }
}

/** Keep station on a leader at a local-space offset. */
export class FormationBrain {
  constructor(
    public leader: Ship,
    public offset: THREE.Vector3,
  ) {}

  update(ship: Ship, world: World, dt: number): void {
    const L = this.leader;
    ship.ctrl.fire = false;
    _aim.copy(this.offset).applyQuaternion(L.quat).add(L.pos);
    _l.copy(_aim).sub(ship.pos);
    const fwd = L.forward(_r);
    const along = _l.dot(fwd);
    _d.copy(_aim).addScaledVector(fwd, 120).sub(ship.pos).normalize();
    avoidGround(ship, world, _d, 25);
    steerToward(ship, _d, 2.4);
    // Throttle to close the along-track gap.
    const want = (L.speed + clamp(along * 0.8, -60, 60) - ship.spec.minSpeed) / (ship.spec.maxSpeed - ship.spec.minSpeed);
    ship.throttle += (clamp(want, 0, 1) - ship.throttle) * damp(4, dt);
    // Match the leader's bank once settled.
    if (_l.length() < 30) {
      L.right(_r);
      const lb = -Math.asin(clamp(_r.y, -1, 1));
      ship.right(_r);
      const b = -Math.asin(clamp(_r.y, -1, 1));
      ship.ctrl.roll = clamp(ship.ctrl.roll * 0.4 + (lb - b) * 1.5, -1, 1);
    }
  }
}

/** Follow a moving rabbit point (scripted fly-bys, attack runs). */
export class RabbitBrain {
  constructor(
    public point: () => THREE.Vector3,
    public speedThrottle = 1,
    public fireAt: (() => Targetable | null) | null = null,
  ) {}

  update(ship: Ship, world: World): void {
    _d.copy(this.point()).sub(ship.pos).normalize();
    avoidGround(ship, world, _d, 20);
    steerToward(ship, _d, 2.6);
    ship.throttle = this.speedThrottle;
    ship.ctrl.fire = false;
    const t = this.fireAt?.();
    if (t?.alive) {
      ship.forward(_r);
      _l.copy(t.pos).sub(ship.pos);
      const dist = _l.length();
      if (_r.dot(_l.normalize()) > 0.97 && dist < 900) {
        ship.ctrl.fire = true;
        ship.fireCannons(world, t.pos);
      }
    }
  }
}

/**
 * Kinematic follower: glides toward `target()` with critically-damped smoothing and
 * orients along its velocity with bank from lateral acceleration (trench choreography).
 */
export class KinematicBrain {
  private prevVel = new THREE.Vector3();
  roll = 0;
  constructor(
    public target: () => THREE.Vector3,
    public stiffness = 3,
    public spin = 0,
  ) {}

  update(ship: Ship, _world: World, dt: number): void {
    ship.kinematic = true;
    const goal = this.target();
    _l.copy(goal).sub(ship.pos);
    ship.pos.lerp(goal, damp(this.stiffness, dt));
    // Derive velocity for lead calculations and bolts.
    _d.copy(_l).multiplyScalar(damp(this.stiffness, dt) / Math.max(dt, 1e-4));
    ship.vel.copy(_d);
    ship.speed = ship.vel.length();
    const lat = (ship.vel.x - this.prevVel.x) / Math.max(dt, 1e-4);
    this.prevVel.copy(ship.vel);
    this.roll += (clamp(-lat * 0.02, -0.9, 0.9) - this.roll) * damp(3, dt);
    if (this.spin) this.roll += this.spin * dt;
    if (ship.speed > 1) {
      _r.copy(ship.vel).normalize();
      _mat.lookAt(_zero, _r, _up);
      ship.quat.setFromRotationMatrix(_mat);
      ship.quat.multiply(_inv.setFromAxisAngle(_zAxis, this.roll));
    }
  }
}
