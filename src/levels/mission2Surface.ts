// Mission 2, Surface Attack. One continuous fight over the Death Star: knock out the turbolaser
// emplacements and the deflection tower (Porkins' last run), then the TIE fighters scramble:
// save Biggs while Gold Squadron and Red Leader make their trench runs over the radio.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { DogfightBrain, steerToward } from '../game/ai';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { Tower } from '../game/tower';
import type { World } from '../game/world';
import type { StringKey } from '../i18n/i18n';
import { RED, lookQuat, spawnPlayer, spawnShip, spawnTies } from './common';
import type { LevelContext, LevelDef } from './context';
import { buildSurfaceScene, placeTowers } from './surfaceScene';

/** Wingman strafing runs: climb, pick a tower, dive and fire, pull out. */
class StrafeBrain {
  private target: Tower | null = null;
  private phase: 'climb' | 'dive' = 'climb';
  private t = 0;
  constructor(
    private towers: () => Tower[],
    private seed: number,
  ) {}

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
      if (ship.forward().dot(dir) > 0.985 && d < 800) {
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

export const mission2: LevelDef = {
  id: 'surface',
  kind: 'mission',
  par: 3600,
  titleKey: 'm2.title',
  subKey: 'm2.sub',
  introKey: 'm2.intro',
  checkpoints: [
    { key: 'm2.cp.start', value: 0 },
    { key: 'm2.cp.fighters', value: 1 },
  ],
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

    const wingDefs: [StringKey, THREE.Vector3][] = [
      ['spk.redLeader', new THREE.Vector3(-60, 20, -80)],
      ['spk.biggs', new THREE.Vector3(40, 10, 40)],
      ['spk.wedge', new THREE.Vector3(-40, -10, 50)],
      ['spk.porkins', new THREE.Vector3(70, 0, 80)],
      ['spk.red10', new THREE.Vector3(-120, 30, 20)],
    ];
    const ships = wingDefs.map(([key, off], i) => {
      const s = spawnShip(ctx, 'xwing', key, start.clone().add(off), heading, RED);
      s.invulnerable = key !== 'spk.red10';
      s.brain = new StrafeBrain(() => towers, i + 1);
      return s;
    });
    const [lead, biggs, wedge, porkins] = ships;

    const tieGoal = Math.round(6 + 4 * ctx.difficulty);
    let destroyed = 0;
    let kills = 0;
    ctx.objectives = [
      { key: 'l2.obj.towers', params: { n: 0, total: need }, done: false },
      { key: 'l2.obj.deflection', done: false },
    ];
    ctx.markers = [{ pos: deflection.pos, key: 'l2.marker.deflection' }];
    ctx.music('combat');
    sc.flak = 1.4 * ctx.difficulty;

    let fireball: THREE.Vector3 | null = null;
    for (const t of towers) {
      t.onDestroyed = (tw) => {
        destroyed++;
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

    // ---- TIE phase state
    const ties: Ship[] = [];
    let tiePhase = false;
    const arena = new THREE.Vector3();
    const leash = { center: arena, radius: 2600 };
    const rng = new Rng(3);
    const trackTie = (t: Ship) => {
      ties.push(t);
      t.onDestroyed = () => {
        if (t.lastAttacker !== player) return;
        kills++;
        ctx.setObjective(2, { params: { n: Math.min(kills, tieGoal), total: tieGoal }, done: kills >= tieGoal });
      };
    };
    const wave = (n: number) => {
      const ang = rng.range(0, Math.PI * 2);
      const from = arena.clone().add(new THREE.Vector3(Math.cos(ang) * 2600, rng.range(150, 500), Math.sin(ang) * 2600));
      for (const s of spawnTies(ctx, n, from, player.pos, 0.6, 60, leash)) trackTie(s);
    };
    const screamed = new Set<Ship>();
    let refill = 0;

    ctx.onUpdate = (dt) => {
      sc.update(dt);
      if (!tiePhase) return;
      // The dogfight follows Red Five (never strand the TIEs over an empty sector), kept above the rooftops.
      arena.copy(player.pos).setY(Math.max(player.pos.y, 380));
      if (!ctx.markers.some((m) => m.key === 'spk.biggs')) {
        const near = ties.filter((t) => t.alive).sort((a, b) => a.pos.distanceToSquared(player.pos) - b.pos.distanceToSquared(player.pos));
        ctx.markers = kills < tieGoal ? near.slice(0, 3).map((t) => ({ pos: t.pos, key: 'tgt.tie' as StringKey })) : [];
      }
      // TIE scream on close pass-bys.
      for (const t of ties) {
        if (!t.alive) continue;
        const d = t.pos.distanceTo(player.pos);
        if (d < 90 && !screamed.has(t)) {
          screamed.add(t);
          ctx.audio.tieFlyby(t.pos);
        } else if (d > 300) screamed.delete(t);
      }
      refill -= dt;
      const alive = ties.filter((t) => t.alive).length;
      if (kills < tieGoal && alive < 2 + Math.round(ctx.difficulty) && refill <= 0) {
        refill = 6;
        wave(Math.min(4, tieGoal - kills + 1));
      }
    };

    const chaserTie = (target: Ship, from: THREE.Vector3, skill: number) => {
      const s = spawnShip(ctx, 'tie', null, from, target.quat.clone());
      s.throttle = 1;
      s.brain = new DogfightBrain({ skill, minAltitude: 50, forcedTarget: () => target });
      trackTie(s);
      return s;
    };

    function* lukeOnTail(): Script {
      const c = ctx.comms;
      const chaser = chaserTie(player, player.pos.clone().addScaledVector(player.forward(), -420).add(new THREE.Vector3(0, 30, 0)), 0.7 * ctx.difficulty);
      yield 3;
      if (!chaser.alive) return;
      yield c.say('luke', 'l3.luke.shake');
      yield c.say('wedge', 'l3.wedge.onHim');
      wedge.brain = new DogfightBrain({ skill: 1, minAltitude: 60, forcedTarget: () => chaser });
      wedge.damageScale = 1;
      const t0 = ctx.world.time;
      yield () => !chaser.alive || ctx.world.time - t0 > 12;
      if (chaser.alive) ctx.world.destroyShip(chaser, wedge);
      wedge.damageScale = 0.22;
      wedge.brain = new DogfightBrain({ skill: 0.5, minAltitude: 70, leash, fireScale: 0.35 });
      c.say('luke', 'l3.luke.thanksWedge');
    }

    function* biggsInTrouble(): Script {
      const c = ctx.comms;
      const chaser = chaserTie(biggs, biggs.pos.clone().addScaledVector(biggs.forward(), -350).add(new THREE.Vector3(0, 40, 0)), 0.9);
      biggs.brain = new DogfightBrain({ skill: 0.3, minAltitude: 80, leash: { center: player.pos, radius: 500 }, fireScale: 0 });
      ctx.objectives.push({ key: 'l3.obj.biggs', done: false });
      const idx = ctx.objectives.length - 1;
      ctx.markers = [{ pos: biggs.pos, key: 'spk.biggs' }];
      yield c.interrupt('biggs', 'l3.biggs.tail');
      c.say('luke', 'l3.luke.biggs');
      const t0 = ctx.world.time;
      const limit = 40 / ctx.difficulty;
      yield () => {
        if (biggs.sinceHit < 0.05) biggs.damageSmoke = Math.min(1, biggs.damageSmoke + 0.08);
        return !chaser.alive || ctx.world.time - t0 > limit;
      };
      ctx.markers = [];
      if (chaser.alive) {
        ctx.fail('fail.biggs');
        return;
      }
      biggs.damageSmoke = 0;
      biggs.brain = new DogfightBrain({ skill: 0.5, minAltitude: 70, leash, fireScale: 0.35 });
      ctx.setObjective(idx, { done: true });
      ctx.award(400, 'm2.award.biggs');
      c.say('biggs', 'l3.biggs.thanks');
    }

    function* tieFight(): Script {
      const c = ctx.comms;
      tiePhase = true;
      arena.copy(player.pos).setY(Math.max(player.pos.y, 380));
      sc.flak = 0.5 * ctx.difficulty;
      for (const t of towers) t.interval *= 1.8; // ground fire shifts to the fighters
      ctx.objectives.push({ key: 'ls.obj.ties', params: { n: 0, total: tieGoal }, done: false });
      for (const s of ships) {
        if (!s.alive) continue;
        s.brain = new DogfightBrain({ skill: 0.5, minAltitude: 70, leash, fireScale: 0.35 });
      }
      c.say('luke', 'l3.luke.scope');
      yield c.say('redLeader', 'l3.rl.visual');
      wave(4);
      yield 2;
      c.say('biggs', 'l3.biggs.coming');
      yield () => kills >= 2 || ctx.world.time > tStart + 40;
      ctx.run(lukeOnTail());
      yield () => kills >= 4 || ctx.world.time > tStart + 75;
      yield* biggsInTrouble();
      yield () => kills >= tieGoal;
      // The trench runs begin: Gold squadron, then Red Leader. (Over the radio.)
      c.say('goldLeader', 'l3.gold.attackRun');
      c.say('gold5', 'l3.gold5.stayOn');
      c.say('vader', 'l3.vader.formation');
      c.say('gold2', 'l3.gold2.tooClose');
      c.say('gold5', 'l3.gold5.stayOn2');
      yield c.say('goldLeader', 'l3.gold.loosen');
      ctx.audio.explosion('medium');
      yield c.say('gold5', 'l3.gold5.behind');
      ctx.audio.explosion('medium');
      c.say('redLeader', 'l3.rl.rendezvous');
      c.say('redLeader', 'l3.rl.away');
      yield c.say('red10', 'l3.red10.negative');
      yield c.say('redLeader', 'l3.rl.hit');
      ctx.audio.explosion('medium');
      if (lead.alive) ctx.world.removeShip(lead);
      c.say('luke', 'l3.luke.closeUp');
      yield c.say('wedge', 'l3.wedge.withYou');
      ctx.complete();
    }

    let tStart = 0;
    function* script(): Script {
      const c = ctx.comms;
      yield 1.5;
      c.say('luke', 'l2.luke.goingIn');
      c.say('porkins', 'l2.porkins.covered');
      yield 6;
      c.say('wedge', 'l2.wedge.deflection');
      c.say('luke', 'l2.luke.onIt');
      // Porkins' last run once the attack is under way.
      yield () => destroyed >= 3 || ctx.stats.time > 70;
      c.say('porkins', 'l2.porkins.problem');
      porkins.damageSmoke = 0.8;
      c.say('biggs', 'l2.biggs.eject');
      c.say('porkins', 'l2.porkins.hold');
      c.say('biggs', 'l2.biggs.pullUp');
      yield c.say('porkins', 'l2.porkins.alright');
      porkins.invulnerable = false;
      ctx.world.destroyShip(porkins, null);
      yield () => fireball !== null || destroyed >= need;
      if (fireball && player.alive && player.pos.distanceTo(fireball) < 400) {
        c.say('biggs', 'l2.biggs.luke');
        c.say('luke', 'l2.luke.toasted');
      } else if (fireball) c.say('wedge', 'l2.wedge.goodShot');
      yield () => destroyed >= need && fireball !== null;
      ctx.award(500, 'm2.award.towers');
      yield c.say('base', 'l2.base.signals');
      ctx.reachCheckpoint(1);
      tStart = ctx.world.time;
      yield* tieFight();
    }

    if (ctx.checkpoint >= 1) {
      // Checkpoint "Enemy fighters": surface defences already hit, Porkins already lost.
      ctx.objectives[0] = { ...ctx.objectives[0], params: { n: need, total: need }, done: true };
      ctx.objectives[1].done = true;
      ctx.markers = [];
      ctx.world.removeShip(porkins);
      // The deflection tower is already rubble (no second fireball/radio chatter when resuming here).
      deflection.onDestroyed = null;
      ctx.world.destroyTower(deflection, null);
      ctx.run(
        (function* (): Script {
          ctx.comms.say('base', 'l2.base.signals');
          tStart = ctx.world.time;
          yield* tieFight();
        })(),
      );
    } else ctx.run(script());
  },
};
