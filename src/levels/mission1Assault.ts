// Mission 1, The Assault. One continuous flight: the strike force closes on the Death Star, Red Leader's
// orders come over the radio while two Star Destroyers move up to screen the station. Break their shields
// and bridges, cut down the TIE waves, then follow Red Leader in toward the surface.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { BatteryRunBrain, DogfightBrain, FormationBrain } from '../game/ai';
import { CapitalShip } from '../game/capital';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { StringKey } from '../i18n/i18n';
import { GOLD, RED, lookQuat, spawnPlayer, spawnShip } from './common';
import type { LevelContext, LevelDef } from './context';
import { DEATH_STAR_RADIUS, buildEnvironment } from './environment';

const R = DEATH_STAR_RADIUS;
/** TIE fighters in the air at once while a hangar still launches. */
const MAX_TIES_OUT = 8;

export const mission1: LevelDef = {
  id: 'assault',
  kind: 'mission',
  par: 4200,
  titleKey: 'm1.title',
  subKey: 'm1.sub',
  introKey: 'm1.intro',
  controlsKey: 'm1.controls',
  checkpoints: [
    { key: 'm1.cp.start', value: 0 },
    { key: 'm1.cp.battle', value: 1 },
  ],
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
    // Shown ~1.75× canonical size: at combat ranges the true 1.6 km reads too small against the Death Star.
    const ISD_SCALE = 1.75;
    const isdPos = [new THREE.Vector3(-2300, 300, -10500), new THREE.Vector3(2500, -420, -12500)];
    const caps = isdPos.map((p, i) => {
      const aim = new THREE.Vector3(i ? -300 : 300, p.y, 1500);
      const c = ctx.world.addCapital(new CapitalShip(i + 1, p, lookQuat(p, aim), 45, ctx.difficulty, ISD_SCALE));
      // TIEs only come out of the hangars, at most MAX_TIES_OUT in the air at once, until the hangar
      // (or the whole destroyer) is knocked out.
      c.hangarInterval = i ? 16 : 13;
      c.launchRoom = () => Math.max(0, MAX_TIES_OUT - tieList.filter((t) => t.alive).length);
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
      t.brain = new DogfightBrain({ skill: 0.55 * ctx.difficulty, minAltitude: 0, leash });
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
    const rng = new Rng(9);
    // Shared by every fighter's brain: once the destroyers are out, the dogfight re-centres on the player.
    const leash = { center: battleCentre.clone(), radius: 5500 };
    let screenBroken = false;

    ctx.onUpdate = (dt) => {
      dist = Math.max(2500, dist - closing * dt);
      ds.mesh.position.copy(battleCentre).addScaledVector(dsDir, R + dist);
      env.update(dt, ctx.camera, player.pos);
      if (!battle) {
        // The capital ships keep station relative to the station until the fight starts.
        ctx.markers = player.pos.distanceTo(lead.pos) > 500 ? [{ pos: lead.pos, key: 'spk.redLeader' }] : [];
        return;
      }
      if (!screenBroken && caps.every((c) => c.disabled)) {
        // Destroyers out: battery-run pilots rejoin the dogfight and everything converges on Red Five.
        screenBroken = true;
        leash.radius = 2200;
        for (const s of [...wing, ...golds]) if (s.alive) s.brain = new DogfightBrain({ skill: 0.5, minAltitude: 0, leash, fireScale: 0.35 });
      }
      if (screenBroken) {
        leash.center.copy(player.pos);
        // Stragglers left kilometres away (TIEs or wingmen) are quietly brought back into the fight,
        // out of the player's view, so the remaining kills are never stranded across the battlefield.
        const fwd = player.forward();
        for (const s of ctx.world.ships) {
          if (s === player || !s.alive || s.kinematic) continue;
          const off = s.pos.clone().sub(player.pos);
          if (off.length() < 4000 || off.normalize().dot(fwd) > 0.3) continue;
          const back = fwd.clone().negate().add(new THREE.Vector3(rng.range(-0.6, 0.6), rng.range(-0.3, 0.3), rng.range(-0.6, 0.6))).normalize();
          s.pos.copy(player.pos).addScaledVector(back, 2200);
          s.vel.copy(player.vel);
        }
      }
      // Objective markers: shield domes first, then the exposed bridge; finally the remaining TIEs.
      ctx.markers = caps.flatMap((c) => {
        if (c.disabled) return [];
        const gensAlive = c.subsystems.filter((s) => s.kind === 'shieldGen' && s.alive);
        if (gensAlive.length) return gensAlive.map((s) => ({ pos: s.pos, key: 'ls.marker.gen' as StringKey }));
        const br = c.subsystems.find((s) => s.kind === 'bridge' && s.alive);
        return br ? [{ pos: br.pos, key: 'ls.marker.bridge' as StringKey }] : [];
      });
      if (screenBroken && ties < tieGoal) {
        const near = tieList.filter((t) => t.alive).sort((a, b) => a.pos.distanceToSquared(player.pos) - b.pos.distanceToSquared(player.pos));
        ctx.markers = near.slice(0, 3).map((t) => ({ pos: t.pos, key: 'tgt.tie' as StringKey }));
      }
      // Capital ships slow to a standstill once they are in position.
      for (const c of caps) if (!c.disabled && c.root.position.z > -8000) c.vel.multiplyScalar(Math.exp(-0.4 * dt));
      if (!screenBroken && player.alive && player.pos.distanceTo(battleCentre) > 8000) {
        farTime += dt;
        ctx.hint = 'hint.returnBattle';
        if (farTime > 20) ctx.fail('fail.deserted');
      } else if (ctx.hint === 'hint.returnBattle') {
        ctx.hint = null;
        farTime = 0;
      }
      // With every hangar gone and the last TIE down, there is nobody left to shoot: the objective is met.
      const tiesDone = ties >= tieGoal || (!caps.some((c) => c.hangarAlive) && tieList.every((t) => !t.alive));
      if (battle && tiesDone && !ctx.objectives[5].done) ctx.setObjective(5, { done: true });
      if (gens >= 4 && bridges >= 2 && tiesDone && !finishing) {
        finishing = true;
        ctx.run(diveIn());
      }
    };

    function startBattle(): void {
      ctx.reachCheckpoint(1);
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
      // The first fighters scramble from under the destroyers' hangar bays.
      for (const c of caps) c.launch(ctx.world, 4);
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
      yield* battleIntro();
    }
    /** `resumed`: when starting from the checkpoint the fight is already on as the radio call comes in. */
    function* battleIntro(resumed = false): Script {
      const c = ctx.comms;
      if (resumed) startBattle();
      // The Imperial screen: two destroyers come around the station.
      yield c.say('redLeader', 'ls.rl.destroyers');
      if (!resumed) startBattle();
      c.say('base', 'ls.base.orders');
      c.say('goldLeader', 'ls.gold.cover');
      yield 6;
      c.say('biggs', 'ls.biggs.ties');
      yield 30;
      c.say('porkins', 'ls.porkins.flak');
    }

    if (ctx.checkpoint >= 1) {
      // Checkpoint "Star Destroyers": skip the approach, formation already in attack trim, destroyers on station.
      for (const i of [0, 1, 2]) ctx.objectives[i].done = true;
      for (const s of [player, lead, ...wing, ...golds]) {
        s.sfoils = s.sfoilTarget = 1;
        s.pos.z -= 3500;
      }
      player.setDeflectors('front');
      player.throttle = 0.8;
      caps.forEach((c) => c.root.position.add(new THREE.Vector3(0, 0, 2500)));
      dist = 55000;
      ctx.run(battleIntro(true));
    } else ctx.run(script());
  },
};
