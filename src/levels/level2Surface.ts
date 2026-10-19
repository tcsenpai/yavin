// Level 2 — Surface attack: knock out turbolaser emplacements, the deflection tower, Porkins' last run.
import * as THREE from 'three';
import { steerToward } from '../game/ai';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { Tower } from '../game/tower';
import type { World } from '../game/world';
import type { StringKey } from '../i18n/i18n';
import { RED, lookQuat, spawnPlayer, spawnShip } from './common';
import type { LevelContext, LevelDef } from './context';
import { buildSurfaceScene, placeTowers } from './surfaceScene';

/** Wingman strafing runs: climb, pick a tower, dive and fire, pull out. */
class StrafeBrain {
  private target: Tower | null = null;
  private phase: 'climb' | 'dive' = 'climb';
  private t = 0;
  constructor(private towers: () => Tower[], private seed: number) {}

  update(ship: Ship, world: World, dt: number): void {
    this.t -= dt;
    ship.ctrl.fire = false;
    ship.throttle = 0.85;
    const alive = this.towers().filter((x) => x.alive);
    if (!this.target?.alive) this.target = alive.length ? alive[(this.seed + Math.floor(world.time / 9)) % alive.length] : null;
    const dir = new THREE.Vector3();
    const tgt = this.target;
    if (!tgt) {
      dir.set(Math.sin(world.time * 0.2 + this.seed), 0.05, Math.cos(world.time * 0.2 + this.seed)).normalize();
    } else if (this.phase === 'climb') {
      // Get distance and altitude, then roll in.
      const away = ship.pos.clone().sub(tgt.pos).setY(0);
      const want = tgt.pos.clone().add(away.setLength(1400)).setY(tgt.pos.y + 320);
      dir.copy(want).sub(ship.pos).normalize();
      if (ship.pos.distanceTo(want) < 250 || this.t < -14) {
        this.phase = 'dive';
        this.t = 9;
      }
    } else {
      dir.copy(tgt.pos).sub(ship.pos);
      const d = dir.length();
      dir.normalize();
      const fwd = ship.forward();
      if (fwd.dot(dir) > 0.985 && d < 800) {
        ship.ctrl.fire = true;
        ship.fireCannons(world, tgt.pos);
      }
      if (d < 220 || this.t < 0) {
        this.phase = 'climb';
        this.t = 0;
      }
    }
    const ground = world.groundHeight(ship.pos.x + ship.vel.x * 1.5, ship.pos.z + ship.vel.z * 1.5);
    if (ship.pos.y + ship.vel.y * 1.5 < ground + 45) dir.y += 1.5;
    steerToward(ship, dir.normalize(), 2.4);
  }
}

export const level2: LevelDef = {
  id: 'surface',
  titleKey: 'l2.title',
  subKey: 'l2.sub',
  introKey: 'l2.intro',
  setup(ctx: LevelContext) {
    const sc = buildSurfaceScene(ctx, 11);
    const need = ctx.difficulty > 1.1 ? 7 : 6;
    const towers = placeTowers(ctx, sc.surface, 77, 9, new THREE.Vector3(0, 0, -2600), 1500);
    // The deflection tower: biggest emplacement, flagged as a special objective.
    const deflection = towers.reduce((a, b) => (b.model.height > a.model.height ? b : a));
    deflection.objective = true;
    sc.surface.prewarm(new THREE.Vector3(0, 0, 600));

    const start = new THREE.Vector3(0, 520, 900);
    const heading = lookQuat(start, new THREE.Vector3(0, 120, -1500));
    const player = spawnPlayer(ctx, start, heading);
    player.throttle = 0.8;
    player.setDeflectors('front');

    const wingmen: [StringKey, THREE.Vector3][] = [
      ['spk.redLeader', new THREE.Vector3(-60, 20, -80)],
      ['spk.biggs', new THREE.Vector3(40, 10, 40)],
      ['spk.wedge', new THREE.Vector3(-40, -10, 50)],
      ['spk.porkins', new THREE.Vector3(70, 0, 80)],
      ['spk.red10', new THREE.Vector3(-120, 30, 20)],
    ];
    const ships = wingmen.map(([key, off], i) => {
      const s = spawnShip(ctx, 'xwing', key, start.clone().add(off), heading, RED);
      s.invulnerable = key !== 'spk.red10';
      s.brain = new StrafeBrain(() => towers, i + 1);
      return s;
    });
    const porkins = ships[3];

    let destroyed = 0;
    ctx.objectives = [
      { key: 'l2.obj.towers', params: { n: 0, total: need }, done: false },
      { key: 'l2.obj.deflection', done: false },
      { key: 'l2.obj.survive', done: false },
    ];
    ctx.markers = [{ pos: deflection.pos, key: 'l2.marker.deflection' }];
    ctx.music('combat');
    sc.flak = 1.4 * ctx.difficulty;

    let fireball: THREE.Vector3 | null = null;
    for (const t of towers) {
      t.onDestroyed = (tw) => {
        destroyed++;
        ctx.stats.towers++;
        ctx.setObjective(0, { params: { n: Math.min(destroyed, need), total: need }, done: destroyed >= need });
        if (tw === deflection) {
          ctx.setObjective(1, { done: true });
          ctx.markers = [];
          // Secondary detonation: the fireball Luke flies through in the film.
          fireball = tw.pos.clone().add(new THREE.Vector3(0, 30, 0));
          ctx.world.fx.explosion(fireball, 40);
          ctx.world.fx.explosion(fireball.clone().add(new THREE.Vector3(20, 40, -10)), 30);
          ctx.audio.explosion('large', fireball);
          ctx.shake = 0.9;
        }
      };
    }

    ctx.onUpdate = (dt) => {
      sc.update(dt);
    };

    function* script(): Script {
      const c = ctx.comms;
      yield 1.5;
      yield c.say('luke', 'l2.luke.goingIn');
      yield c.say('porkins', 'l2.porkins.covered');
      yield 4;
      yield c.say('wedge', 'l2.wedge.deflection');
      yield c.say('luke', 'l2.luke.onIt');
      // Porkins' last run once the attack is under way.
      yield () => destroyed >= 3 || ctx.stats.time > 70;
      yield c.say('porkins', 'l2.porkins.problem');
      porkins.damageSmoke = 0.8;
      yield c.say('biggs', 'l2.biggs.eject');
      yield c.say('porkins', 'l2.porkins.hold');
      yield c.say('biggs', 'l2.biggs.pullUp');
      yield c.say('porkins', 'l2.porkins.alright');
      porkins.invulnerable = false;
      ctx.world.destroyShip(porkins, null);
      yield 1;
      yield () => fireball !== null;
      if (fireball && player.alive && player.pos.distanceTo(fireball) < 400) {
        yield c.say('biggs', 'l2.biggs.luke');
        yield c.say('luke', 'l2.luke.toasted');
      } else {
        yield c.say('wedge', 'l2.wedge.goodShot');
      }
      yield () => destroyed >= need;
      ctx.setObjective(2, { done: true });
      yield c.say('base', 'l2.base.signals');
      yield c.say('biggs', 'l2.biggs.scope');
      ctx.complete();
    }
    ctx.run(script());
  },
};
