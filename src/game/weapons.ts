// Laser bolts (instanced, two colours) and proton torpedoes.
import * as THREE from 'three';
import type { Targetable, Team } from './types';
import type { World } from './world';

interface Bolt {
  active: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  life: number;
  team: Team;
  owner: Targetable | null;
  damage: number;
  color: 0 | 1;
  heavy: boolean;
}

export interface Torpedo {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: Targetable | null;
  /** Fixed homing point (exhaust port) when not chasing a Targetable. */
  point: THREE.Vector3 | null;
  owner: Targetable;
  life: number;
  mesh: THREE.Mesh;
  /** Set by script to decide the outcome on arrival at `point`. */
  onArrive: ((t: Torpedo) => void) | null;
  guidance: number;
}

const MAX_BOLTS = 600;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();

export class Weapons {
  readonly group = new THREE.Group();
  private bolts: Bolt[] = [];
  private meshes: THREE.InstancedMesh[];
  readonly torpedoes: Torpedo[] = [];
  private torpGeo = new THREE.SphereGeometry(0.7, 12, 8);
  private torpMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.2, 1.6) });

  constructor() {
    // Unit bolt along +Z; scaled per instance (length, thickness).
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
    geo.rotateX(Math.PI / 2);
    const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 0.9, 0.6), toneMapped: false });
    const green = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 9, 1.4), toneMapped: false });
    this.meshes = [red, green].map((mat) => {
      const im = new THREE.InstancedMesh(geo, mat, MAX_BOLTS);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      this.group.add(im);
      return im;
    });
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.bolts.push({
        active: false,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        speed: 0,
        life: 0,
        team: 'rebel',
        owner: null,
        damage: 0,
        color: 0,
        heavy: false,
      });
    }
  }

  fireBolt(owner: Targetable | null, origin: THREE.Vector3, dir: THREE.Vector3, speed: number, color: 'red' | 'green', damage: number, team?: Team, heavy = false): void {
    const b = this.bolts.find((x) => !x.active);
    if (!b) return;
    b.active = true;
    b.pos.copy(origin);
    b.prev.copy(origin);
    b.dir.copy(dir).normalize();
    b.speed = speed + (owner ? Math.max(0, owner.vel.dot(b.dir)) : 0);
    b.life = 2.6;
    b.team = team ?? owner?.team ?? 'empire';
    b.owner = owner;
    b.damage = damage;
    b.color = color === 'red' ? 0 : 1;
    b.heavy = heavy;
  }

  fireTorpedo(owner: Targetable, origin: THREE.Vector3, vel: THREE.Vector3, target: Targetable | null, point: THREE.Vector3 | null): Torpedo {
    let t = this.torpedoes.find((x) => !x.active);
    if (!t) {
      const mesh = new THREE.Mesh(this.torpGeo, this.torpMat);
      t = { active: false, pos: mesh.position, vel: new THREE.Vector3(), target: null, point: null, owner, life: 0, mesh, onArrive: null, guidance: 2.5 };
      this.torpedoes.push(t);
      this.group.add(mesh);
    }
    t.active = true;
    t.mesh.visible = true;
    t.pos.copy(origin);
    t.vel.copy(vel);
    t.target = target;
    t.point = point;
    t.owner = owner;
    t.life = 6;
    t.onArrive = null;
    t.guidance = 2.5;
    return t;
  }

  /** Remove every bolt (level resets / cinematic cuts). */
  clear(): void {
    for (const b of this.bolts) b.active = false;
    for (const t of this.torpedoes) {
      t.active = false;
      t.mesh.visible = false;
    }
  }

  update(world: World, dt: number): void {
    const counts = [0, 0];
    const targets = world.targetables;
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        continue;
      }
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.dir, b.speed * dt);
      // Hit hostile targets.
      let hit: Targetable | null = null;
      let best = 2;
      for (const t of targets) {
        if (!t.alive || t.team === b.team || t === b.owner) continue;
        const dx = t.pos.x - b.pos.x;
        const dz = t.pos.z - b.pos.z;
        const reach = b.speed * dt + t.radius + 60;
        if (dx * dx + dz * dz > reach * reach) continue;
        const tt = t.intersectSegment(b.prev, b.pos);
        if (tt >= 0 && tt < best) {
          best = tt;
          hit = t;
        }
      }
      if (hit) {
        _v.lerpVectors(b.prev, b.pos, best);
        hit.takeDamage(b.damage, b.prev, b.owner);
        world.onBoltHit(hit, _v, b.owner);
        b.active = false;
        continue;
      }
      // Hit the Death Star hull/trench.
      if (world.staticHit(b.prev, b.pos, _v, _n)) {
        world.fx.sparks(_v, _n);
        if (b.heavy) world.fx.flak(_v);
        b.active = false;
        continue;
      }
      const im = this.meshes[b.color];
      const i = counts[b.color]++;
      const len = b.heavy ? 14 : 9;
      const thick = b.heavy ? 0.55 : 0.22;
      _q.setFromUnitVectors(_z, b.dir);
      _s.set(thick, thick, len);
      _m.compose(_v.copy(b.pos).addScaledVector(b.dir, -len / 2), _q, _s);
      im.setMatrixAt(i, _m);
    }
    for (let c = 0; c < 2; c++) {
      this.meshes[c].count = counts[c];
      this.meshes[c].instanceMatrix.needsUpdate = true;
    }

    for (const t of this.torpedoes) {
      if (!t.active) continue;
      t.life -= dt;
      const goal = t.target?.alive ? t.target.pos : t.point;
      if (goal) {
        _v.copy(goal).sub(t.pos);
        const dist = _v.length();
        const speed = Math.max(t.vel.length(), 260);
        _v.multiplyScalar(speed / Math.max(dist, 1e-3));
        t.vel.lerp(_v, Math.min(1, t.guidance * dt));
        t.vel.setLength(Math.min(speed + 120 * dt, 420));
        if (dist < Math.max(4, t.vel.length() * dt * 1.2)) {
          t.active = false;
          t.mesh.visible = false;
          if (t.onArrive) t.onArrive(t);
          else if (t.target?.alive) {
            t.target.takeDamage(400, t.pos, t.owner);
            world.onBoltHit(t.target, t.pos, t.owner);
            world.fx.explosion(t.pos, 6);
          }
          continue;
        }
      }
      t.pos.addScaledVector(t.vel, dt);
      world.fx.trail(t.pos, t.vel, 1);
      if (!t.onArrive && world.staticHit(_v.copy(t.pos).addScaledVector(t.vel, -dt), t.pos, _s, _n)) {
        world.fx.explosion(t.pos, 5);
        world.audio.explosion('medium', t.pos);
        t.active = false;
        t.mesh.visible = false;
        continue;
      }
      if (t.life <= 0) {
        world.fx.explosion(t.pos, 4);
        t.active = false;
        t.mesh.visible = false;
      }
    }
  }
}
