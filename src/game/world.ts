// Simulation container for one level: ships, structures, weapons, effects, terrain collisions.
import * as THREE from 'three';
import type { AudioSystem } from '../audio/audio';
import { DeathStarSurface } from '../world/surface';
import { Trench } from '../world/trench';
import { FX } from './fx';
import { Ship } from './ship';
import { Tower } from './tower';
import { CapitalShip, Subsystem } from './capital';
import type { Targetable } from './types';
import { Weapons } from './weapons';

export interface WorldEvents {
  onDestroyed?(target: Targetable, killer: Targetable | null): void;
  onTargetHit?(target: Targetable, attacker: Targetable | null): void;
  onPlayerHit?(amount: number): void;
  onPlayerCrash?(): void;
}

const _n = new THREE.Vector3();
const _p = new THREE.Vector3();

export class World {
  readonly scene: THREE.Scene;
  readonly ships: Ship[] = [];
  readonly towers: Tower[] = [];
  readonly capitals: CapitalShip[] = [];
  readonly weapons = new Weapons();
  readonly fx = new FX();
  surface: DeathStarSurface | null = null;
  trench: Trench | null = null;
  player: Ship | null = null;
  time = 0;
  difficulty = 1;
  events: WorldEvents = {};
  /** Merged list rebuilt each frame. */
  targetables: Targetable[] = [];

  constructor(scene: THREE.Scene, readonly audio: AudioSystem) {
    this.scene = scene;
    scene.add(this.weapons.group, this.fx.group);
  }

  addShip(s: Ship): Ship {
    this.ships.push(s);
    this.scene.add(s.model.root);
    return s;
  }

  addTower(t: Tower): Tower {
    this.towers.push(t);
    this.scene.add(t.model.root);
    return t;
  }

  /** Remove a ship silently (scripted exits: Wedge pulling out, Vader spinning away). */
  removeShip(s: Ship): void {
    s.alive = false;
    this.scene.remove(s.model.root);
    const i = this.ships.indexOf(s);
    if (i >= 0) this.ships.splice(i, 1);
  }

  setSurface(s: DeathStarSurface): void {
    this.surface = s;
    this.scene.add(s.group);
  }

  setTrench(t: Trench): void {
    this.trench = t;
    this.scene.add(t.group);
  }

  groundHeight(x: number, z: number): number {
    return this.surface ? this.surface.heightAt(x, z) : -Infinity;
  }

  /** Segment vs hull/trench. Writes impact point and normal. */
  staticHit(a: THREE.Vector3, b: THREE.Vector3, outP: THREE.Vector3, outN: THREE.Vector3): boolean {
    for (const c of this.capitals) {
      if (c.collide(b, 0, outN) > 0) {
        outP.copy(b);
        return true;
      }
    }
    if (this.trench && b.y < 0 && b.z < 0 && this.trench.collide(b, 0, outN) > 0) {
      outP.copy(b);
      return true;
    }
    if (!this.surface) return false;
    const h = this.surface.heightAt(b.x, b.z);
    if (b.y < h) {
      // Inside the trench volume the surface function reports the floor; walls handled above.
      outP.copy(b);
      outP.y = Math.max(b.y, h - 0.01);
      outN.set(0, 1, 0);
      if (a.y >= this.surface.heightAt(a.x, a.z) && Math.abs(a.y - b.y) > 1e-3) {
        // Interpolate to the surface level for nicer impact placement.
        const t = (a.y - h) / (a.y - b.y);
        outP.lerpVectors(a, b, Math.min(Math.max(t, 0), 1));
      }
      return true;
    }
    return false;
  }

  /** A ship got hit by a bolt/torpedo. */
  onBoltHit(target: Targetable, point: THREE.Vector3, attacker: Targetable | null): void {
    this.fx.sparks(point);
    this.events.onTargetHit?.(target, attacker);
    if (target === this.player) {
      this.audio.playerHit();
      this.events.onPlayerHit?.(1);
    }
    if (target instanceof Ship && target.hull <= 0 && target.alive) this.destroyShip(target, attacker);
    if (target instanceof Tower && target.hp <= 0 && target.alive) this.destroyTower(target, attacker);
    if (target instanceof Subsystem && target.hp <= 0 && target.alive) target.capital.destroySubsystem(target, this, attacker);
    if (target instanceof Subsystem && target.shielded) this.fx.flak(point);
  }

  destroyShip(s: Ship, killer: Targetable | null): void {
    if (!s.alive) return;
    s.alive = false;
    this.fx.explosion(s.pos, s.radius * (s.kind === 'falcon' ? 2 : 1.4), s.vel);
    this.audio.explosion(s.kind === 'tie' || s.kind === 'tieadv' ? 'small' : 'medium', s.isPlayer ? undefined : s.pos);
    this.scene.remove(s.model.root);
    s.onDestroyed?.(s);
    this.events.onDestroyed?.(s, killer);
    if (!s.isPlayer) {
      const i = this.ships.indexOf(s);
      if (i >= 0) this.ships.splice(i, 1);
    }
  }

  addCapital(c: CapitalShip): CapitalShip {
    this.capitals.push(c);
    this.scene.add(c.root);
    return c;
  }

  destroyTower(t: Tower, killer: Targetable | null): void {
    if (!t.alive) return;
    t.alive = false;
    const big = t.kind === 'tower';
    this.fx.explosion(t.pos, big ? 14 : 6);
    if (big) this.fx.explosion(t.model.root.position.clone().lerp(t.pos, 0.5), 10);
    this.audio.explosion(big ? 'large' : 'medium', t.pos);
    // Leave a scorched stump.
    t.model.turret.visible = false;
    t.model.root.scale.y = 0.35;
    t.onDestroyed?.(t);
    this.events.onDestroyed?.(t, killer);
  }

  private collideTerrain(s: Ship, dt: number): void {
    let pen = 0;
    for (const c of this.capitals) {
      pen = c.collide(s.pos, s.radius * 0.6, _n);
      if (pen > 0) break;
    }
    if (pen <= 0 && this.trench) {
      pen = this.trench.collide(s.pos, s.radius * 0.75, _n);
    }
    if (pen <= 0 && this.surface) {
      const h = this.surface.heightAt(s.pos.x, s.pos.z);
      // Probe a little ahead too, so fast ships don't tunnel into tall blocks.
      _p.copy(s.pos).addScaledVector(s.vel, dt);
      const h2 = this.surface.heightAt(_p.x, _p.z);
      const floor = Math.max(h, h2) + s.radius * 0.4;
      const hw = this.surface.trench?.halfWidth ?? 0;
      if (s.pos.y < floor && !(s.pos.y < 0 && Math.abs(s.pos.x) < hw)) {
        pen = floor - s.pos.y;
        _n.set(0, 1, 0);
      }
    }
    if (pen <= 0) return;
    if (s.isPlayer) {
      // Scrape: push out, reflect the inward velocity component, damage by impact speed.
      s.pos.addScaledVector(_n, pen + 0.05);
      const into = -s.vel.dot(_n);
      if (into > 0) s.vel.addScaledVector(_n, into * 1.6);
      const dmg = 6 + into * 0.35 + s.speed * 0.02;
      s.sinceHit = 0;
      s.hull -= dmg * dt * 10;
      this.fx.sparks(_p.copy(s.pos).addScaledVector(_n, -s.radius * 0.5), _n);
      this.events.onPlayerCrash?.();
      if (s.hull <= 0) this.destroyShip(s, null);
    } else if (s.invulnerable) {
      s.pos.addScaledVector(_n, pen + 0.05);
      const into = -s.vel.dot(_n);
      if (into > 0) s.vel.addScaledVector(_n, into);
    } else {
      this.destroyShip(s, null);
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.targetables.length = 0;
    for (const s of this.ships) if (s.alive) this.targetables.push(s);
    for (const t of this.towers) if (t.alive) this.targetables.push(t);
    for (const c of this.capitals) for (const s of c.subsystems) if (s.alive) this.targetables.push(s);
    for (const c of this.capitals) c.update(this, dt);

    for (const s of [...this.ships]) {
      if (!s.alive) continue;
      s.fireCooldown -= dt;
      s.brain?.update(s, this, dt);
      s.updateFlight(dt);
      this.collideTerrain(s, dt);
      if (s.alive && s.hull <= 0) this.destroyShip(s, s.lastAttacker);
      const smoke = Math.max(s.damageSmoke, s.spec.hull > 0 ? 1 - s.hull / s.spec.hull - 0.45 : 0);
      if (s.alive && smoke > 0) this.fx.trail(s.pos, s.vel, Math.min(smoke * 1.5, 1));
    }
    for (const t of this.towers) t.update(this, dt);
    this.weapons.update(this, dt);
    this.fx.update(dt);
  }
}
