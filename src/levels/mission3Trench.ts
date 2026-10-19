// Level 4, The trench run. Wall guns, Vader and his wingmen, Wedge and Biggs, the Force, the Falcon, the port.
import * as THREE from 'three';
import { KinematicBrain } from '../game/ai';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import { Tower } from '../game/tower';
import { createExhaustPort } from '../models/ships';
import { DeathStarSurface } from '../world/surface';
import { TRENCH_DEPTH, TRENCH_HALF_WIDTH, Trench } from '../world/trench';
import { RED, spawnPlayer, spawnShip } from './common';
import type { LevelContext, LevelDef } from './context';
import { buildEnvironment } from './environment';

const PORT_DIST = 21000;
const WINDOW_NEAR = 90;
const WINDOW_FAR = 480;
const FORCE_WINDOW_FAR = 640;

export const mission3: LevelDef = {
  id: 'trench',
  kind: 'mission',
  par: 2400,
  titleKey: 'l4.title',
  subKey: 'l4.sub',
  introKey: 'l4.intro',
  controlsKey: 'l4.controls',
  checkpoints: [
    { key: 'l4.cp.start', value: 0 },
    { key: 'l4.cp.vader', value: 0.5 },
    { key: 'l4.cp.final', value: 0.85 },
  ],
  setup(ctx: LevelContext) {
    const env = buildEnvironment(ctx.scene, {
      deathStarCenter: null,
      shadows: true,
      shadowExtent: 180,
      yavinPos: new THREE.Vector3(-0.9e8, 1.1e8, -2.4e8),
      yavin4Pos: new THREE.Vector3(1.4e7, 0.9e7, -2.6e7),
      ambient: 0.5,
    });
    ctx.scene.fog = new THREE.Fog(0x030407, 1400, 5200);
    const surface = new DeathStarSurface({ seed: 31, curvatureR: 0, trench: { halfWidth: TRENCH_HALF_WIDTH, depth: TRENCH_DEPTH }, viewChunks: 6 });
    ctx.world.setSurface(surface);
    const trench = new Trench(31, PORT_DIST + 2000);
    ctx.world.setTrench(trench);

    const portPos = new THREE.Vector3(0, -TRENCH_DEPTH + 0.05, -PORT_DIST);
    const port = createExhaustPort();
    port.position.copy(portPos);
    ctx.scene.add(port);
    // Beacon glow above the port so it reads at speed.
    const portLight = new THREE.PointLight(0xff6a2a, 300, 120, 1.5);
    portLight.position.copy(portPos).add(new THREE.Vector3(0, 6, 0));
    ctx.scene.add(portLight);

    const p0 = ctx.checkpoint;
    const startZ = -p0 * PORT_DIST - 40;
    const player = spawnPlayer(ctx, new THREE.Vector3(0, -TRENCH_DEPTH * 0.5, startZ));
    player.throttle = 1;
    player.speed = player.spec.maxSpeed;
    player.vel.set(0, 0, -player.speed);
    surface.prewarm(player.pos);
    trench.update(player.pos);

    const progress = () => Math.max(0, -player.pos.z / PORT_DIST);

    // Wingmen behind Luke (Biggs: "We'll stay back far enough to cover you").
    const follow = (off: THREE.Vector3) => () => player.pos.clone().add(off);
    const mkWing = (key: 'spk.biggs' | 'spk.wedge', off: THREE.Vector3) => {
      const s = spawnShip(ctx, 'xwing', key, player.pos.clone().add(off), undefined, RED);
      s.invulnerable = true;
      s.brain = new KinematicBrain(follow(off), 2.5);
      return s;
    };
    const biggsOff = new THREE.Vector3(-9, 5, 70);
    const wedgeOff = new THREE.Vector3(10, 10, 95);
    const biggs = p0 < 0.55 ? mkWing('spk.biggs', biggsOff) : null;
    const wedge = p0 < 0.45 ? mkWing('spk.wedge', wedgeOff) : null;

    // Vader and two wingmen arrive from behind.
    let vader: Ship | null = null;
    let black2: Ship | null = null;
    let black3: Ship | null = null;
    const vaderOff = new THREE.Vector3(0, 4, 200);
    const spawnVader = () => {
      const back = new THREE.Vector3(0, 30, 900);
      vader = spawnShip(ctx, 'tieadv', 'spk.vader', player.pos.clone().add(back));
      black2 = spawnShip(ctx, 'tie', 'spk.wingman', player.pos.clone().add(back).add(new THREE.Vector3(-16, 6, 20)));
      black3 = spawnShip(ctx, 'tie', 'spk.wingman', player.pos.clone().add(back).add(new THREE.Vector3(16, 8, 24)));
      for (const s of [vader, black2, black3]) s.invulnerable = true;
      vader.brain = new KinematicBrain(follow(vaderOff), 0.9);
      black2.brain = new KinematicBrain(follow(new THREE.Vector3(-14, 7, 222)), 0.9);
      black3.brain = new KinematicBrain(follow(new THREE.Vector3(14, 9, 226)), 0.9);
    };
    if (p0 >= 0.45) spawnVader();

    // Gun emplacements along the trench (active before Vader arrives).
    const turrets = new Map<number, Tower[]>();
    let gunsActive = p0 < 0.35;
    const manageTurrets = () => {
      const seg = trench.segmentIndexAt(player.pos.z);
      for (let i = seg; i < seg + 10; i++) {
        if (turrets.has(i) || i * Trench.SEGMENT > PORT_DIST * 0.42 || i * Trench.SEGMENT < 600) continue;
        const list = trench.turretSlots(i).map((slot, k) => ctx.world.addTower(new Tower('wall', i * 7 + k, slot.pos, slot.normal, ctx.difficulty)));
        for (const t of list) t.silenced = !gunsActive;
        turrets.set(i, list);
      }
      for (const [i, list] of turrets) {
        if (i >= seg - 2) continue;
        for (const t of list) {
          ctx.scene.remove(t.model.root);
          const idx = ctx.world.towers.indexOf(t);
          if (idx >= 0) ctx.world.towers.splice(idx, 1);
        }
        turrets.delete(i);
      }
    };

    ctx.objectives = [
      { key: 'l4.obj.trench', done: false },
      { key: 'l4.obj.port', done: false },
    ];
    ctx.markers = [{ pos: portPos, key: 'l4.marker.port' }];
    ctx.computerAvailable = true;
    ctx.music('trench');
    ctx.timer = { key: 'hud.timer.base', seconds: p0 > 0 ? 95 : 165 };

    let torpsAway = false;
    let finished = false;
    let outOfTrench = 0;
    let vaderFire = 0;
    // Resuming at the final approach: R2 is already lost and Vader already has a bead on you.
    let vaderAimAtPlayer = p0 >= 0.82;
    if (p0 >= 0.6) ctx.r2Alive = false;
    let tcScroll = 0;

    const fireVader = (target: THREE.Vector3, miss: number) => {
      const v = vader as Ship | null;
      if (!v?.alive) return;
      v.model.root.updateMatrixWorld();
      for (const m of v.model.cannonMuzzles.slice(0, 2)) {
        const o = m.getWorldPosition(new THREE.Vector3());
        // Offset at least 7 m from the target so "near misses" really miss (miss < 7 = aimed shot).
        const ang = Math.random() * Math.PI * 2;
        const r = miss < 7 ? Math.random() * miss : 7 + Math.random() * (miss - 7);
        const aim = target.clone().add(new THREE.Vector3(Math.cos(ang) * r, Math.sin(ang) * r, 0));
        ctx.world.weapons.fireBolt(v, o, aim.sub(o), 820, 'green', 12, 'empire');
      }
      ctx.audio.laser('tie', v.pos);
    };

    ctx.onUpdate = (dt) => {
      env.update(dt, ctx.camera, player.alive ? player.pos : ctx.camera.position);
      surface.update(ctx.camera.position, 2);
      trench.update(ctx.camera.position);
      manageTurrets();
      for (const cp of [0.5, 0.85]) if (progress() > cp) ctx.reachCheckpoint(cp);
      if (!finished && ctx.timer) {
        ctx.timer.seconds -= dt;
        if (ctx.timer.seconds <= 0) {
          finished = true;
          ctx.run(deathStarFires());
        }
      }
      if (!player.alive || finished) return;
      const range = player.pos.z - portPos.z;
      const far = ctx.computerOff ? FORCE_WINDOW_FAR : WINDOW_FAR;
      const inWindow = range > WINDOW_NEAR && range < far;
      tcScroll += (player.speed * dt) / 60;
      const inTrench = player.pos.y < -2;
      ctx.computer =
        !ctx.computerOff && inTrench
          ? { range, offX: player.pos.x / TRENCH_HALF_WIDTH, offY: (player.pos.y + TRENCH_DEPTH / 2) / (TRENCH_DEPTH / 2), inWindow, scroll: tcScroll }
          : null;
      // Leaving the trench is suicide (the towers and Vader both get a clear shot).
      if (!inTrench) {
        outOfTrench += dt;
        ctx.hint = 'hint.stayInTrench';
        if (outOfTrench > 1.5 && Math.random() < dt * 3) {
          player.takeDamage(8 * ctx.difficulty, player.pos.clone().add(new THREE.Vector3(0, 10, 50)), null);
          ctx.world.fx.flak(player.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 30, 8, -20)));
        }
        if (outOfTrench > 7) ctx.fail('fail.leftTrench');
      } else if (ctx.hint === 'hint.stayInTrench') {
        ctx.hint = null;
        outOfTrench = 0;
      } else outOfTrench = 0;
      if (player.forward().z > 0.2) ctx.hint = 'hint.wrongWay';
      else if (ctx.hint === 'hint.wrongWay') ctx.hint = null;
      // Vader's guns.
      vaderFire -= dt;
      const v = vader as Ship | null;
      if (v?.alive && vaderFire <= 0 && progress() > 0.4) {
        vaderFire = vaderAimAtPlayer ? 0.35 : 0.8;
        // Deliberate near-misses except when the player leaves the trench.
        fireVader(player.pos.clone().addScaledVector(player.vel, 0.25), outOfTrench > 1 ? 2 : vaderAimAtPlayer ? 14 : 22);
      }
      if (range < -60 && !torpsAway) {
        finished = true;
        ctx.fail('fail.passedPort');
      }
    };

    ctx.onTorpedo = () => {
      if (torpsAway || finished || !player.alive) return true;
      if (ctx.torpedoes <= 0) return true;
      const range = player.pos.z - portPos.z;
      if (range > 1600 || range < 0) return false; // normal dumb-fire torpedo far from the port
      torpsAway = true;
      ctx.torpedoes = Math.max(0, ctx.torpedoes - 2);
      const far = ctx.computerOff ? FORCE_WINDOW_FAR : WINDOW_FAR;
      const good = range > WINDOW_NEAR && range < far && player.pos.y < -4 && Math.abs(player.pos.x) < TRENCH_HALF_WIDTH * 0.7;
      player.model.root.updateMatrixWorld();
      const ports = 'torpedoPorts' in player.model ? player.model.torpedoPorts : [];
      let arrived = 0;
      ports.slice(0, 2).forEach((pt, i) => {
        const o = pt.getWorldPosition(new THREE.Vector3());
        const v = player.vel.clone().add(new THREE.Vector3(0, -6, 0));
        // A miss "impacts on the surface" short of / beside the port.
        const aim = good ? portPos.clone() : portPos.clone().add(new THREE.Vector3((i ? 1 : -1) * 7, 0.2, range < WINDOW_NEAR ? -60 : 40 + Math.random() * 60));
        const tp = ctx.world.weapons.fireTorpedo(player, o, v, null, aim);
        tp.guidance = good ? 4 : 1.6;
        tp.onArrive = () => {
          arrived++;
          if (good) {
            ctx.world.fx.explosion(portPos.clone().add(new THREE.Vector3(0, 2, 0)), 4);
            if (arrived === 2) ctx.run(success());
          } else {
            ctx.world.fx.explosion(tp.pos, 6);
            ctx.audio.explosion('medium', tp.pos);
            if (arrived === 2) ctx.run(missed());
          }
        };
      });
      ctx.audio.torpedo();
      ctx.stats.shots += 2;
      return true;
    };

    function* success(): Script {
      finished = true;
      ctx.stats.hits += 2;
      ctx.award(1500, 'm3.award.port');
      if (ctx.computerOff) ctx.award(1000, 'm3.award.force');
      if (ctx.timer) ctx.award(Math.round(ctx.timer.seconds) * 5, 'm3.award.time');
      ctx.setObjective(1, { done: true });
      ctx.timer = null;
      ctx.computer = null;
      ctx.markers = [];
      ctx.flash = 0.5;
      ctx.audio.explosion('large', portPos);
      ctx.shake = 0.6;
      ctx.playerControl = false;
      // Autopilot: climb out of the trench.
      player.brain = {
        update(s: Ship) {
          s.ctrl.pitch = s.pos.y < 400 ? 0.6 : 0;
          s.ctrl.yaw = 0;
          s.ctrl.roll = 0;
          s.throttle = 1;
        },
      };
      yield ctx.comms.interrupt('luke', 'l4.luke.inside');
      yield ctx.comms.say('base', 'l4.base.pullOut');
      yield 1;
      ctx.complete();
    }

    function* missed(): Script {
      finished = true;
      yield ctx.comms.interrupt('base', 'l4.base.impacted');
      yield 0.5;
      ctx.fail('fail.missed');
    }

    function* deathStarFires(): Script {
      ctx.playerControl = false;
      yield ctx.comms.interrupt('tarkin', 'l4.tarkin.fire');
      ctx.flash = 0.8;
      ctx.audio.explosion('deathstar');
      yield 1.5;
      ctx.fail('fail.yavin4');
    }

    function* countdown(): Script {
      const c = ctx.comms;
      yield () => !!ctx.timer && ctx.timer.seconds < 61;
      if (!finished) yield c.say('officer', 'l4.officer.oneMinute');
      yield () => !!ctx.timer && ctx.timer.seconds < 31;
      if (!finished) yield c.say('officer', 'l4.officer.thirty');
      yield () => !!ctx.timer && ctx.timer.seconds < 10;
      if (!finished) yield c.say('tarkin', 'l4.tarkin.standBy');
    }

    function* forceWatch(): Script {
      yield () => ctx.computerOff;
      ctx.stats.forceUsed = true;
      yield ctx.comms.say('base', 'l4.base.computerOff');
      yield ctx.comms.say('luke', 'l4.luke.allright');
    }

    // Each story beat fires at its own trench progress, independent of how long earlier radio lines take,
    // so the choreography stays locked to the player's position however fast they fly.
    const beat = (at: number, body: () => Script) => {
      if (p0 > 0 && p0 >= at) return;
      ctx.run(
        (function* (): Script {
          yield () => progress() > at;
          if (!finished && player.alive) yield* body();
        })(),
      );
    };

    beat(0, function* () {
      const c = ctx.comms;
      yield 0.5;
      c.say('luke', 'l4.luke.fullThrottle');
      c.say('wedge', 'l4.wedge.withYou');
      c.say('biggs', 'l4.biggs.pullOut');
      c.say('luke', 'l4.luke.beggars');
      c.say('biggs', 'l4.biggs.stayBack');
    });
    beat(0.14, function* () {
      ctx.comms.say('wedge', 'l4.wedge.tower');
      ctx.comms.say('luke', 'l4.luke.worry');
    });
    beat(0.3, function* () {
      ctx.setObjective(0, { done: true });
      // The guns fall silent: fighters are coming.
      gunsActive = false;
      for (const list of turrets.values()) for (const t of list) t.silenced = true;
      if (!vader) spawnVader();
      yield ctx.comms.interrupt('luke', 'l4.luke.gunsStopped');
      ctx.comms.say('biggs', 'l4.biggs.rearDeflectors');
      yield ctx.waitAction('deflectors', 'hint.deflectorsRear', 8);
      ctx.comms.say('vader', 'l4.vader.myself');
    });
    if (p0 >= 0.3) {
      ctx.setObjective(0, { done: true });
      gunsActive = false;
    }
    beat(0.42, function* () {
      if (!wedge) return;
      wedge.damageSmoke = 0.9;
      ctx.world.fx.sparks(wedge.pos.clone());
      ctx.audio.explosion('small', wedge.pos);
      ctx.comms.interrupt('wedge', 'l4.wedge.hit');
      ctx.comms.say('luke', 'l4.luke.getClear');
      yield 2.5;
      // Wedge peels up and out of the trench.
      const exit = player.pos.clone();
      (wedge.brain as KinematicBrain).target = () => exit.clone().add(new THREE.Vector3(30, 400, 0));
      yield 3;
      ctx.world.removeShip(wedge);
    });
    beat(0.52, function* () {
      if (!biggs) return;
      yield ctx.comms.interrupt('biggs', 'l4.biggs.hurry');
      for (let i = 0; i < 4; i++) {
        fireVader(biggs.pos, 0.5);
        yield 0.25;
      }
      biggs.invulnerable = false;
      ctx.world.destroyShip(biggs, vader);
      ctx.comms.say('luke', 'l4.luke.biggs');
    });
    beat(0.6, function* () {
      // Vader scores a hit: R2 is lost.
      fireVader(player.pos, 0.5);
      player.shieldAft = 0;
      player.takeDamage(18, player.pos.clone().add(new THREE.Vector3(0, 0, 30)), vader);
      ctx.world.fx.sparks(player.pos.clone().add(new THREE.Vector3(0, 1.5, 1.2)));
      ctx.shake = 0.8;
      ctx.r2Alive = false;
      ctx.comms.interrupt('r2', 'r2.scream');
      ctx.comms.say('luke', 'l4.luke.lostR2');
    });
    beat(0.67, function* () {
      yield ctx.comms.interrupt('obiwan', 'l4.ben.force');
    });
    beat(0.73, function* () {
      yield ctx.comms.interrupt('obiwan', 'l4.ben.letGo');
      if (!ctx.computerOff) ctx.hint = 'hint.computerOff';
      yield () => progress() > 0.82 || ctx.computerOff;
      if (ctx.hint === 'hint.computerOff') ctx.hint = null;
    });
    beat(0.77, function* () {
      ctx.comms.say('vader', 'l4.vader.strong');
    });
    beat(0.82, function* () {
      vaderAimAtPlayer = true;
      ctx.audio.alarm(true);
      ctx.comms.interrupt('vader', 'l4.vader.haveYou');
    });
    beat(0.86, hanArrives);

    function* hanArrives(): Script {
      const c = ctx.comms;
      // The Falcon dives out of the sun onto Vader's wingmen.
      const falcon = spawnShip(ctx, 'falcon', 'spk.han', player.pos.clone().add(new THREE.Vector3(60, 700, -1600)));
      falcon.invulnerable = true;
      let phase = 0;
      falcon.brain = new KinematicBrain(() => {
        const v = vader as Ship | null;
        const anchor = v?.alive ? v.pos : player.pos.clone().add(vaderOff);
        if (phase === 0) return anchor.clone().add(new THREE.Vector3(0, 120, -260));
        return player.pos.clone().add(new THREE.Vector3(-40, 260, -400));
      }, 1.2);
      ctx.audio.alarm(false);
      yield c.interrupt('han', 'l4.han.yahoo');
      yield 1.2;
      // Falcon guns.
      const b2 = black2 as Ship | null;
      const b3 = black3 as Ship | null;
      for (let i = 0; i < 8; i++) {
        falcon.model.root.updateMatrixWorld();
        const tgt = b2?.alive ? b2 : b3;
        if (tgt) {
          const o = falcon.pos.clone();
          ctx.world.weapons.fireBolt(falcon, o, tgt.pos.clone().sub(o), 900, 'red', 0, 'rebel');
          ctx.audio.laser('falcon', falcon.pos);
        }
        yield 0.09;
      }
      if (b2?.alive) {
        b2.invulnerable = false;
        ctx.world.destroyShip(b2, falcon);
      }
      vaderAimAtPlayer = false;
      yield c.say('wingman', 'l4.wingman.look');
      yield 0.6;
      // Black 3 veers into Vader; both tumble away.
      const v = vader as Ship | null;
      if (b3?.alive && v?.alive) {
        b3.invulnerable = false;
        ctx.world.destroyShip(b3, null);
        ctx.world.fx.explosion(v.pos.clone(), 4);
        const vb = v.brain as KinematicBrain;
        vb.spin = 9;
        const from = v.pos.clone();
        vb.target = () => from.add(new THREE.Vector3(0.6, 1.6, 0.2));
        vb.stiffness = 2;
        yield c.say('vader', 'l4.vader.what');
        yield 2.5;
        ctx.world.removeShip(v);
      }
      phase = 1;
      yield c.say('han', 'l4.han.clear');
      yield ctx.comms.say('obiwan', 'l4.ben.trust');
    }

    ctx.run(countdown());
    ctx.run(forceWatch());
  },
};
