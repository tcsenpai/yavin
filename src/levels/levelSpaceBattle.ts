// Space battle — two Star Destroyers screen the station. Bring down their shield generators, then their bridges,
// while TIE waves pour out of the hangars.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { DogfightBrain, steerToward } from '../game/ai';
import { CapitalShip, type Subsystem } from '../game/capital';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { World } from '../game/world';
import type { StringKey } from '../i18n/i18n';
import { GOLD, RED, lookQuat, spawnPlayer, spawnShip, spawnTies } from './common';
import type { LevelContext, LevelDef } from './context';
import { buildEnvironment } from './environment';

/** Y-wing / wingman attack runs on a capital ship's turbolaser batteries. */
class BatteryRunBrain {
  private target: Subsystem | null = null;
  private phase: 'run' | 'extend' = 'run';
  private t = 0;
  constructor(private caps: CapitalShip[], private seed: number) {}

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

export const levelSpace: LevelDef = {
  id: 'space',
  titleKey: 'ls.title',
  subKey: 'ls.sub',
  introKey: 'ls.intro',
  controlsKey: 'ls.controls',
  setup(ctx: LevelContext) {
    const env = buildEnvironment(ctx.scene, {
      deathStarCenter: new THREE.Vector3(30000, -40000, -150000),
      dishFacing: new THREE.Vector3(-0.2, 0.3, 1).normalize(),
      shadows: false,
      yavinPos: new THREE.Vector3(-2.2e8, 0.6e8, -1.6e8),
      yavin4Pos: new THREE.Vector3(1.0e7, 0.3e7, 2.8e7),
    });

    const player = spawnPlayer(ctx, new THREE.Vector3(0, 0, 0));
    player.throttle = 0.85;
    player.setDeflectors('front');

    // Two Imperial-class Star Destroyers steaming toward the strike force.
    const isdA = ctx.world.addCapital(new CapitalShip(1, new THREE.Vector3(-1300, 220, -4200), lookQuat(new THREE.Vector3(-1300, 220, -4200), new THREE.Vector3(300, 220, 800)), 22, ctx.difficulty, 0));
    const isdB = ctx.world.addCapital(new CapitalShip(2, new THREE.Vector3(1500, -320, -5600), lookQuat(new THREE.Vector3(1500, -320, -5600), new THREE.Vector3(-200, -320, 600)), 18, ctx.difficulty, 1));
    const caps = [isdA, isdB];
    isdB.hangarInterval = 34;

    // Strike force.
    const heading = new THREE.Quaternion();
    const allies: [StringKey, THREE.Vector3, boolean][] = [
      ['spk.redLeader', new THREE.Vector3(-40, 10, -60), true],
      ['spk.biggs', new THREE.Vector3(40, 5, 30), true],
      ['spk.wedge', new THREE.Vector3(-40, -6, 35), true],
      ['spk.porkins', new THREE.Vector3(80, 0, 70), true],
      ['spk.red10', new THREE.Vector3(-110, 20, 80), false],
      ['spk.red9', new THREE.Vector3(120, 25, 90), false],
    ];
    const leash = { center: new THREE.Vector3(0, 0, -3500), radius: 4200 };
    allies.forEach(([key, off, armour], i) => {
      const s = spawnShip(ctx, 'xwing', key, off, heading, RED);
      s.invulnerable = armour;
      s.brain = i % 3 === 2 ? new BatteryRunBrain(caps, i) : new DogfightBrain({ skill: 0.55, minAltitude: 0, leash, fireScale: 0.5 });
    });
    for (let i = 0; i < 4; i++) {
      const s = spawnShip(ctx, 'ywing', i === 0 ? 'spk.goldLeader' : null, new THREE.Vector3(-260 - i * 30, 40, 120 + i * 20), heading, GOLD);
      s.invulnerable = i === 0;
      s.brain = new BatteryRunBrain(caps, i * 3 + 1);
    }

    const tieGoal = Math.round(8 + 4 * ctx.difficulty);
    let ties = 0;
    let gens = 0;
    let bridges = 0;
    ctx.objectives = [
      { key: 'ls.obj.shields', params: { n: 0, total: 4 }, done: false },
      { key: 'ls.obj.bridges', params: { n: 0, total: 2 }, done: false },
      { key: 'ls.obj.ties', params: { n: 0, total: tieGoal }, done: false },
    ];
    ctx.music('combat');

    const tieList: Ship[] = [];
    const trackTie = (t: Ship) => {
      tieList.push(t);
      t.onDestroyed = () => {
        ties++;
        ctx.setObjective(2, { params: { n: Math.min(ties, tieGoal), total: tieGoal }, done: ties >= tieGoal });
      };
    };
    for (const c of caps) {
      c.onLaunch = trackTie;
      c.onSubsystemDestroyed = (s, killer) => {
        if (killer === player && s.kind === 'turbolaser') ctx.stats.towers++;
        if (s.kind === 'shieldGen') {
          gens++;
          ctx.setObjective(0, { params: { n: gens, total: 4 }, done: gens >= 4 });
          ctx.run(shieldLine(c));
        }
        if (s.kind === 'bridge') {
          bridges++;
          ctx.setObjective(1, { params: { n: bridges, total: 2 }, done: bridges >= 2 });
          ctx.run(bridgeLine());
        }
      };
    }

    // Objective markers: shield domes first, then the exposed bridge.
    const refreshMarkers = () => {
      ctx.markers = caps.flatMap((c) => {
        if (c.disabled) return [];
        const gensAlive = c.subsystems.filter((s) => s.kind === 'shieldGen' && s.alive);
        if (gensAlive.length) return gensAlive.map((s) => ({ pos: s.pos, key: 'ls.marker.gen' as StringKey }));
        const br = c.subsystems.find((s) => s.kind === 'bridge' && s.alive);
        return br ? [{ pos: br.pos, key: 'ls.marker.bridge' as StringKey }] : [];
      });
    };
    refreshMarkers();

    const rng = new Rng(9);
    let tieRefill = 15;
    let farTime = 0;
    ctx.onUpdate = (dt) => {
      env.update(dt, ctx.camera, player.pos);
      refreshMarkers();
      // Extra TIE waves from the station until the quota is met.
      tieRefill -= dt;
      const alive = tieList.filter((t) => t.alive).length;
      if (tieRefill <= 0 && alive < 4 && ties < tieGoal) {
        tieRefill = 14 / ctx.difficulty;
        const ang = rng.range(-0.8, 0.8);
        const from = new THREE.Vector3(Math.sin(ang) * 4500, rng.range(-500, 600), -3500 - Math.cos(ang) * 3000);
        for (const t of spawnTies(ctx, 4, from, player.pos, 0.6, 0, leash)) trackTie(t);
      }
      if (player.alive && player.pos.distanceTo(leash.center) > 7000) {
        farTime += dt;
        ctx.hint = 'hint.returnBattle';
        if (farTime > 20) ctx.fail('fail.deserted');
      } else if (ctx.hint === 'hint.returnBattle') {
        ctx.hint = null;
        farTime = 0;
      }
      if (gens >= 4 && bridges >= 2 && ties >= tieGoal && !finishing) {
        finishing = true;
        ctx.run(outro());
      }
    };
    let finishing = false;

    function* shieldLine(c: CapitalShip): Script {
      if (!c.shieldsUp) yield ctx.comms.say('redLeader', 'ls.rl.shieldsDown');
      else if (gens === 1) yield ctx.comms.say('wedge', 'ls.wedge.gen');
    }
    function* bridgeLine(): Script {
      yield ctx.comms.say('biggs', 'ls.biggs.bridge');
    }
    function* outro(): Script {
      yield 1;
      yield ctx.comms.say('redLeader', 'ls.rl.regroup');
      yield ctx.comms.say('goldLeader', 'ls.gold.trench');
      ctx.complete();
    }
    function* script(): Script {
      const c = ctx.comms;
      yield 1.5;
      yield c.say('redLeader', 'ls.rl.destroyers');
      yield c.say('base', 'ls.base.orders');
      yield c.say('goldLeader', 'ls.gold.cover');
      for (const t of spawnTies(ctx, 6, new THREE.Vector3(0, 300, -4200), player.pos, 0.55, 0, leash)) trackTie(t);
      yield 2;
      yield c.say('biggs', 'ls.biggs.ties');
      yield 25;
      yield c.say('porkins', 'ls.porkins.flak');
    }
    ctx.run(script());
  },
};
