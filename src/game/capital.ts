// Capital ships (Imperial Star Destroyers): destructible subsystems, turbolaser batteries, TIE hangar, hull collision.
import * as THREE from 'three';
import { createStarDestroyer, type CapitalSubsystem, type StarDestroyerModel } from '../models/ships';
import { DogfightBrain } from './ai';
import { Ship } from './ship';
import { newId, segmentSphere, type Targetable } from './types';
import type { World } from './world';

const HP: Record<CapitalSubsystem['kind'], number> = { shieldGen: 260, bridge: 700, turbolaser: 110, hangar: 450 };

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _box = new THREE.Box3();

export class Subsystem implements Targetable {
  readonly id = newId();
  readonly team = 'empire' as const;
  readonly pos = new THREE.Vector3();
  alive = true;
  hp: number;
  readonly maxHp: number;
  cooldown = Math.random() * 3;

  constructor(
    readonly capital: CapitalShip,
    readonly part: CapitalSubsystem,
    difficulty: number,
  ) {
    this.maxHp = this.hp = HP[part.kind] * (0.75 + difficulty * 0.25);
  }

  get kind(): CapitalSubsystem['kind'] {
    return this.part.kind;
  }
  get radius(): number {
    return this.part.radius;
  }
  get vel(): THREE.Vector3 {
    return this.capital.vel;
  }

  /** The bridge is protected by the deflector field while any shield generator stands. */
  get shielded(): boolean {
    return this.kind === 'bridge' && this.capital.shieldsUp;
  }

  intersectSegment(a: THREE.Vector3, b: THREE.Vector3): number {
    return segmentSphere(a, b, this.pos, this.radius);
  }

  takeDamage(amount: number): void {
    if (!this.alive || this.shielded) return;
    this.hp -= amount;
  }
}

export class CapitalShip {
  readonly model: StarDestroyerModel;
  readonly vel = new THREE.Vector3();
  readonly subsystems: Subsystem[];
  disabled = false;
  /** Weapons and hangar idle until the level engages (approach phase). */
  active = true;
  /** TIEs launched from the hangar (level code wires their kill events). */
  onLaunch: ((tie: Ship) => void) | null = null;
  onSubsystemDestroyed: ((s: Subsystem, killer: Targetable | null) => void) | null = null;
  hangarInterval = 28;
  private hangarT = 12;
  private listT = 0;
  private burnT = 0;
  private spin = new THREE.Vector3();

  constructor(seed: number, pos: THREE.Vector3, heading: THREE.Quaternion, speed: number, readonly difficulty: number, readonly nameIndex: number) {
    this.model = createStarDestroyer(seed);
    this.model.root.position.copy(pos);
    this.model.root.quaternion.copy(heading);
    this.vel.set(0, 0, -speed).applyQuaternion(heading);
    this.subsystems = this.model.subsystems.map((p) => new Subsystem(this, p, difficulty));
    this.model.setThrottle(0.6);
    this.model.root.updateMatrixWorld(true);
    for (const s of this.subsystems) s.part.anchor.getWorldPosition(s.pos);
  }

  get root(): THREE.Group {
    return this.model.root;
  }

  get shieldsUp(): boolean {
    return this.subsystems.some((s) => s.kind === 'shieldGen' && s.alive);
  }

  /** Is world point `p` (with margin) inside the hull? Writes push-out normal (world). */
  collide(p: THREE.Vector3, margin: number, outNormal: THREE.Vector3): number {
    _inv.copy(this.model.root.matrixWorld).invert();
    _a.copy(p).applyMatrix4(_inv);
    let best = 0;
    for (const c of this.model.colliders) {
      _box.copy(c).expandByScalar(margin);
      if (!_box.containsPoint(_a)) continue;
      // Smallest-axis push out.
      const dx0 = _a.x - _box.min.x;
      const dx1 = _box.max.x - _a.x;
      const dy0 = _a.y - _box.min.y;
      const dy1 = _box.max.y - _a.y;
      const dz0 = _a.z - _box.min.z;
      const dz1 = _box.max.z - _a.z;
      const m = Math.min(dx0, dx1, dy0, dy1, dz0, dz1);
      if (m <= best && best > 0) continue;
      best = m;
      if (m === dx0) _b.set(-1, 0, 0);
      else if (m === dx1) _b.set(1, 0, 0);
      else if (m === dy0) _b.set(0, -1, 0);
      else if (m === dy1) _b.set(0, 1, 0);
      else if (m === dz0) _b.set(0, 0, -1);
      else _b.set(0, 0, 1);
      outNormal.copy(_b).transformDirection(this.model.root.matrixWorld);
    }
    return best;
  }

  destroySubsystem(s: Subsystem, world: World, killer: Targetable | null): void {
    if (!s.alive) return;
    s.alive = false;
    s.part.setDestroyed();
    const big = s.kind === 'bridge' || s.kind === 'hangar';
    world.fx.explosion(s.pos, big ? 40 : s.kind === 'shieldGen' ? 26 : 12, this.vel);
    world.audio.explosion(big || s.kind === 'shieldGen' ? 'large' : 'medium', s.pos);
    if (s.kind === 'bridge') {
      // Command lost: guns fall silent, the ship slowly lists out of formation.
      this.disabled = true;
      this.model.setThrottle(0);
      this.spin.set((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.01, (Math.random() < 0.5 ? -1 : 1) * 0.025);
    }
    this.onSubsystemDestroyed?.(s, killer);
    world.events.onDestroyed?.(s, killer);
  }

  update(world: World, dt: number): void {
    const root = this.model.root;
    root.position.addScaledVector(this.vel, dt);
    if (this.disabled) {
      this.vel.multiplyScalar(Math.exp(-0.05 * dt));
      this.listT += dt;
      root.rotateX(this.spin.x * dt);
      root.rotateY(this.spin.y * dt);
      root.rotateZ(this.spin.z * dt);
      // Secondary explosions rippling along the hull.
      this.burnT -= dt;
      if (this.burnT <= 0 && this.listT < 40) {
        this.burnT = 0.4 + Math.random() * 1.2;
        const c = this.model.colliders[Math.floor(Math.random() * this.model.colliders.length)];
        _a.set(THREE.MathUtils.lerp(c.min.x, c.max.x, Math.random()), c.max.y, THREE.MathUtils.lerp(c.min.z, c.max.z, Math.random())).applyMatrix4(root.matrixWorld);
        world.fx.explosion(_a, 10 + Math.random() * 14, this.vel);
        world.audio.explosion('medium', _a);
      }
    }
    this.model.update(dt);
    root.updateMatrixWorld(true);
    for (const s of this.subsystems) s.part.anchor.getWorldPosition(s.pos);
    if (this.disabled || !this.active) return;

    // Turbolaser batteries.
    for (const s of this.subsystems) {
      if (!s.alive || s.kind !== 'turbolaser') continue;
      s.cooldown -= dt;
      if (s.cooldown > 0) continue;
      let target: Ship | null = null;
      let best = 2600 * 2600;
      for (const sh of world.ships) {
        if (!sh.alive || sh.team !== 'rebel') continue;
        const d = sh.pos.distanceToSquared(s.pos) * (sh.isPlayer ? 0.6 : 1);
        if (d < best) {
          best = d;
          target = sh;
        }
      }
      if (!target) {
        s.cooldown = 1;
        continue;
      }
      s.cooldown = (2.2 + Math.random() * 1.4) / this.difficulty;
      const dist = target.pos.distanceTo(s.pos);
      _a.copy(target.pos).addScaledVector(target.vel, dist / 600);
      const spread = 0.045 / this.difficulty;
      _a.x += (Math.random() - 0.5) * dist * spread;
      _a.y += (Math.random() - 0.5) * dist * spread;
      _a.z += (Math.random() - 0.5) * dist * spread;
      const muzzles = s.part.muzzles.length ? s.part.muzzles : [s.part.anchor];
      for (const m of muzzles) {
        m.getWorldPosition(_b);
        world.weapons.fireBolt(s, _b, _a.clone().sub(_b), 600, 'green', 16, 'empire', true);
      }
      world.audio.laser('turbolaser', s.pos);
    }

    // Hangar launches.
    const hangar = this.subsystems.find((s) => s.kind === 'hangar');
    if (hangar?.alive) {
      this.hangarT -= dt;
      if (this.hangarT <= 0) {
        this.hangarT = this.hangarInterval / this.difficulty;
        const down = new THREE.Vector3(0, -1, 0).transformDirection(root.matrixWorld);
        for (let i = 0; i < 3; i++) {
          const tie = new Ship('tie', null);
          tie.pos.copy(hangar.pos).addScaledVector(down, 90 + i * 16);
          tie.quat.copy(root.quaternion);
          tie.vel.copy(this.vel);
          tie.throttle = 1;
          tie.brain = new DogfightBrain({ skill: 0.55 * this.difficulty, minAltitude: 0 });
          world.addShip(tie);
          this.onLaunch?.(tie);
        }
      }
    }
  }
}
