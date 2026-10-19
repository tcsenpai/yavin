// Mission 1 — The Assault. One continuous flight: the strike force closes on the Death Star, Red Leader's
// orders come over the radio while two Star Destroyers move up to screen the station. Break their shields
// and bridges, cut down the TIE waves, then follow Red Leader in toward the surface.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { DogfightBrain, FormationBrain, steerToward } from '../game/ai';
import { CapitalShip, type Subsystem } from '../game/capital';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { World } from '../game/world';
import type { StringKey } from '../i18n/i18n';
import { GOLD, RED, lookQuat, spawnPlayer, spawnShip, spawnTies } from './common';
import type { LevelContext, LevelDef } from './context';
import { DEATH_STAR_RADIUS, buildEnvironment } from './environment';

/** Y-wing / wingman attack runs on a capital ship's turbolaser batteries. */
class BatteryRunBrain {
  private target: Subsystem | null = null;
  private phase: 'run' | 'extend' = 'run';
  private t = 0;
  constructor(
    private caps: CapitalShip[],
    private seed: number,
  ) {}

  update(ship: Ship, world: World, dt: number): void {
    this.t -= dt;
    ship.ctrl.fire = false;
    ship.throttle = 0.9;
    if (!this.target?.alive) {
      const all = this.caps.filter((c) => !c.disabled).flatMap((c) => c.subsystems.filter((s) => s.alive && s.kind === 'turbolaser'));
      this.target = all.length ? all[(this.seed + Math.floor(world.time / 11)) % all.length] : null;
    }
    const dir = new THREE.Vector3();
    const tg = this.target;
    if (!tg) {
      ship.forward(dir);
    } else if (this.phase === 'run') {
      dir.copy(tg.pos).sub(ship.pos);
      const d = dir.length();
      dir.normalize();
      if (ship.forward().dot(dir) > 0.985 && d < 900) {
        ship.ctrl.fire = true;
        ship.fireCannons(world, tg.pos);
      }
      if (d < 260) {
        this.phase = 'extend';
        this.t = 6;
      }
    } else {
      dir.copy(ship.pos).sub(tg.pos).normalize().add(new THREE.Vector3(0, 0.6, 0)).normalize();
      if (this.t < 0) this.phase = 'run';
    }
    steerToward(ship, dir, 2.2);
  }
}

const R = DEATH_STAR_RADIUS;

export const mission1: LevelDef = {
  id: 'assault',
  kind: 'mission',
  par: 4200,
  titleKey: 'm1.title',
  subKey: 'm1.sub',
  introKey: 'm1.intro',
  controlsKey: 'm1.controls',
  setup(ctx: LevelContext) {
    // The station sits ahead and slightly below; its apparent distance is scripted (time-compressed approach).
    const dsDir = new THREE.Vector3(0.08, -0.2, -1).normalize();
    const battleCentre = new THREE.Vector3(0, 0, -7500);
    const env = buildEnvironment(ctx.scene, {
      deathStarCenter: dsDir.clone().multiplyScalar(R + 90000),
      dishFacing: dsDir.clone().negate(),
      shadows: false,
      viewFill: 0.9,
      ambient: 0.7,
      // Behind the strike force: Yavin 4 (where they launched); Yavin itself off to the side.
      yavin4Pos: new THREE.Vector3(-0.6e7, 0.2e7, 2.2e7),
      yavinPos: new THREE.Vector3(2.2e8, -0.5e8, -1.4e8),
    });
    const ds = env.deathStar!;

    const player = spawnPlayer(ctx, new THREE.Vector3(52, -4, 48));
    player.sfoils = player.sfoilTarget = 0;
    player.throttle = 0.55;

    // Strike force in formation behind Red Leader.
    const lead = spawnShip(ctx, 'xwing', 'spk.redLeader', new THREE.Vector3(0, 0, 0), undefined, RED);
    lead.throttle = 0.5;
    lead.invulnerable = true;
    lead.sfoils = lead.sfoilTarget = 0;
    lead.brain = {
      update(s: Ship) {
        s.ctrl.pitch = s.ctrl.yaw = s.ctrl.roll = 0;
        s.ctrl.fire = false;
      },
    };
    const wingDefs: [StringKey, THREE.Vector3, boolean][] = [
      ['spk.wedge', new THREE.Vector3(-26, 2, 22), true],
      ['spk.biggs', new THREE.Vector3(26, -2, 24), true],
      ['spk.porkins', new THREE.Vector3(-52, 5, 46), true],
      ['spk.red10', new THREE.Vector3(80, 10, 70), false],
      ['spk.red7', new THREE.Vector3(-80, 10, 70), false],
      ['spk.red9', new THREE.Vector3(106, -6, 92), false],
    ];
    const wing = wingDefs.map(([key, off, armour]) => {
      const s = spawnShip(ctx, 'xwing', key, off.clone(), undefined, RED);
      s.invulnerable = armour;
      s.sfoils = s.sfoilTarget = 0;
      s.brain = new FormationBrain(lead, off);
      return s;
    });
    const golds = [0, 1, 2, 3].map((i) => {
      const off = new THREE.Vector3(-300 - (i % 2) * 34, 40 + Math.floor(i / 2) * 18, 60 + i * 26);
      const s = spawnShip(ctx, 'ywing', i === 0 ? 'spk.goldLeader' : null, off.clone(), undefined, GOLD);
      s.invulnerable = i === 0;
      s.brain = new FormationBrain(lead, off);
      return s;
    });

    // Two Imperial-class Star Destroyers steam in from the station to screen the approach.
    const isdPos = [new THREE.Vector3(-1500, 260, -9500), new THREE.Vector3(1700, -340, -11000)];
    const caps = isdPos.map((p, i) => {
      const aim = new THREE.Vector3(i ? -300 : 300, p.y, 1500);
      const c = ctx.world.addCapital(new CapitalShip(i + 1, p, lookQuat(p, aim), 45, ctx.difficulty, i));
      c.hangarInterval = i ? 34 : 28;
      c.active = false;
      return c;
    });

    const tieGoal = Math.round(6 + 4 * ctx.difficulty);
    let ties = 0; // player kills only: the wingmen fight, but the score is yours
    let gens = 0;
    let bridges = 0;
    ctx.objectives = [
      { key: 'm1.obj.report', done: false },
      { key: 'm1.obj.sfoils', done: false },
      { key: 'm1.obj.deflectors', done: false },
      { key: 'ls.obj.shields', params: { n: 0, total: 4 }, done: false },
      { key: 'ls.obj.bridges', params: { n: 0, total: 2 }, done: false },
      { key: 'ls.obj.ties', params: { n: 0, total: tieGoal }, done: false },
    ];
    ctx.music('approach');

    const tieList: Ship[] = [];
    const trackTie = (t: Ship) => {
      tieList.push(t);
      t.onDestroyed = () => {
        if (t.lastAttacker !== player) return;
        ties++;
        ctx.setObjective(5, { params: { n: Math.min(ties, tieGoal), total: tieGoal }, done: ties >= tieGoal });
      };
    };
    for (const c of caps) {
      c.onLaunch = trackTie;
      c.onSubsystemDestroyed = (s) => {
        if (s.kind === 'shieldGen') {
          gens++;
          ctx.setObjective(3, { params: { n: gens, total: 4 }, done: gens >= 4 });
          if (!c.shieldsUp) ctx.comms.say('redLeader', 'ls.rl.shieldsDown');
          else if (gens === 1) ctx.comms.say('wedge', 'ls.wedge.gen');
        }
        if (s.kind === 'bridge') {
          bridges++;
          ctx.setObjective(4, { params: { n: bridges, total: 2 }, done: bridges >= 2 });
          ctx.comms.say('biggs', 'ls.biggs.bridge');
        }
      };
    }

    let battle = false;
    let dist = 90000;
    let closing = 350; // m/s of scripted closure
    let finishing = false;
    let farTime = 0;
    let tieRefill = 20;
    const rng = new Rng(9);
    const leash = { center: battleCentre, radius: 4500 };

    ctx.onUpdate = (dt) => {
      dist = Math.max(2500, dist - closing * dt);
      ds.mesh.position.copy(battleCentre).addScaledVector(dsDir, R + dist);
      env.update(dt, ctx.camera, player.pos);
      if (!battle) {
        // The capital ships keep station relative to the station until the fight starts.
        ctx.markers = player.pos.distanceTo(lead.pos) > 500 ? [{ pos: lead.pos, key: 'spk.redLeader' }] : [];
        return;
      }
      // Objective markers: shield domes first, then the exposed bridge.
      ctx.markers = caps.flatMap((c) => {
        if (c.disabled) return [];
        const gensAlive = c.subsystems.filter((s) => s.kind === 'shieldGen' && s.alive);
        if (gensAlive.length) return gensAlive.map((s) => ({ pos: s.pos, key: 'ls.marker.gen' as StringKey }));
        const br = c.subsystems.find((s) => s.kind === 'bridge' && s.alive);
        return br ? [{ pos: br.pos, key: 'ls.marker.bridge' as StringKey }] : [];
      });
      // Capital ships slow to a standstill once they are in position.
      for (const c of caps) if (!c.disabled && c.root.position.z > -6500) c.vel.multiplyScalar(Math.exp(-0.4 * dt));
      tieRefill -= dt;
      const alive = tieList.filter((t) => t.alive).length;
      if (tieRefill <= 0 && alive < 3 + Math.round(ctx.difficulty) && ties < tieGoal) {
        tieRefill = 16 / ctx.difficulty;
        const ang = rng.range(-0.8, 0.8);
        const from = new THREE.Vector3(Math.sin(ang) * 4500, rng.range(-500, 600), battleCentre.z - Math.cos(ang) * 3500);
        for (const t of spawnTies(ctx, 3, from, player.pos, 0.6, 0, leash)) trackTie(t);
      }
      if (player.alive && player.pos.distanceTo(battleCentre) > 8000) {
        farTime += dt;
        ctx.hint = 'hint.returnBattle';
        if (farTime > 20) ctx.fail('fail.deserted');
      } else if (ctx.hint === 'hint.returnBattle') {
        ctx.hint = null;
        farTime = 0;
      }
      if (gens >= 4 && bridges >= 2 && ties >= tieGoal && !finishing) {
        finishing = true;
        ctx.run(diveIn());
      }
    };

    function startBattle(): void {
      battle = true;
      closing = 60;
      ctx.music('combat');
      for (const c of caps) {
        c.vel.setLength(25);
        c.active = true;
      }
      wing.forEach((s, i) => {
        s.sfoilTarget = 1;
        s.brain = i % 3 === 2 ? new BatteryRunBrain(caps, i) : new DogfightBrain({ skill: 0.5, minAltitude: 0, leash, fireScale: 0.35 });
      });
      lead.sfoilTarget = 1;
      lead.brain = new DogfightBrain({ skill: 0.5, minAltitude: 0, leash, fireScale: 0.35 });
      golds.forEach((s, i) => (s.brain = new BatteryRunBrain(caps, i * 3 + 1)));
      for (const t of spawnTies(ctx, 5, battleCentre.clone().add(new THREE.Vector3(0, 300, -1500)), player.pos, 0.55, 0, leash)) trackTie(t);
    }

    function* diveIn(): Script {
      const c = ctx.comms;
      yield 1;
      yield c.say('redLeader', 'ls.rl.regroup');
      c.say('goldLeader', 'ls.gold.trench');
      ctx.hint = 'hint.throttle';
      ctx.music('approach');
      closing = 2400;
      yield () => dist < 20000;
      yield c.say('redLeader', 'l1.rl.position');
      yield () => dist <= 2600;
      ctx.hint = null;
      ctx.award(500, 'm1.award.complete');
      ctx.complete();
    }

    function* script(): Script {
      const c = ctx.comms;
      yield 1.5;
      c.say('redLeader', 'l1.rl.reportIn');
      c.say('red10', 'l1.red10');
      c.say('biggs', 'l1.red3');
      yield c.say('wedge', 'l1.red2');
      yield ctx.waitAction('confirm', 'hint.reportIn', 10);
      c.say('luke', 'l1.red5');
      ctx.setObjective(0, { done: true });
      yield c.say('redLeader', 'l1.rl.sfoils');
      for (const s of [lead, ...wing, ...golds]) s.sfoilTarget = 1;
      yield ctx.waitAction('sfoils', 'hint.sfoils', 15);
      if (player.sfoilTarget < 1) {
        player.sfoilTarget = 1;
        ctx.audio.sfoils();
      }
      ctx.setObjective(1, { done: true });
      closing = 900;
      yield c.say('redLeader', 'l1.rl.field');
      ctx.shake = 0.7;
      ctx.flash = 0.2;
      c.say('redLeader', 'l1.rl.doubleFront');
      yield ctx.waitAction('deflectors', 'hint.deflectorsFront', 15);
      if (player.deflectors !== 'front') player.setDeflectors('front');
      ctx.setObjective(2, { done: true });
      yield c.say('wedge', 'l1.wedge.size');
      c.say('redLeader', 'l1.rl.chatter');
      // The Imperial screen: two destroyers come around the station.
      yield c.say('redLeader', 'ls.rl.destroyers');
      startBattle();
      c.say('base', 'ls.base.orders');
      c.say('goldLeader', 'ls.gold.cover');
      yield 6;
      c.say('biggs', 'ls.biggs.ties');
      yield 30;
      c.say('porkins', 'ls.porkins.flak');
    }
    ctx.run(script());
  },
};
