// Training, a holographic flight course off Yavin 4. Skippable step by step (N) and replayable at any difficulty.
import * as THREE from 'three';
import { DogfightBrain, KinematicBrain } from '../game/ai';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { StringKey } from '../i18n/i18n';
import { lookQuat, spawnPlayer, spawnShip } from './common';
import type { LevelContext, LevelDef } from './context';
import { buildEnvironment } from './environment';

const RING_COLOR = new THREE.Color(0.4, 1.6, 2.4);
const RING_NEXT = new THREE.Color(2.4, 1.6, 0.3);

export const training: LevelDef = {
  id: 'training',
  kind: 'training',
  par: 2200,
  titleKey: 'tr.title',
  subKey: 'tr.sub',
  introKey: 'tr.intro',
  controlsKey: 'tr.controls',
  setup(ctx: LevelContext) {
    const env = buildEnvironment(ctx.scene, {
      deathStarCenter: null,
      shadows: false,
      viewFill: 0.9,
      ambient: 0.8,
      yavin4Pos: new THREE.Vector3(0.3e7, -0.55e7, -1.1e7),
      yavinPos: new THREE.Vector3(-2.4e8, 0.4e8, -1.8e8),
    });
    const player = spawnPlayer(ctx, new THREE.Vector3(0, 0, 0));
    player.throttle = 0.5;
    player.sfoils = player.sfoilTarget = 0;
    ctx.onUpdate = (dt) => env.update(dt, ctx.camera, player.pos);
    ctx.music('approach');
    const diff = ctx.difficulty;
    const skip = () => ctx.input.consume('skipStep');
    const objective = (key: StringKey, params?: Record<string, number>) => {
      ctx.objectives.push({ key, params, done: false });
      return ctx.objectives.length - 1;
    };
    const spawnDrone = (pos: THREE.Vector3, armed: boolean): Ship => {
      const d = spawnShip(ctx, 'tie', null, pos, lookQuat(pos, player.pos));
      d.throttle = 0.6;
      d.brain = armed ? new DogfightBrain({ skill: 0.3 * diff, minAltitude: 0, fireScale: 0.5 }) : null;
      d.damageScale = 0.4; // training remotes sting, they don't kill outright
      if (!armed) d.kinematic = true;
      return d;
    };

    function* rings(): Script {
      const n = 5;
      const idx = objective('tr.obj.rings', { n: 0, total: n });
      const meshes: THREE.Mesh[] = [];
      const geo = new THREE.TorusGeometry(18 - diff * 3, 0.9, 10, 48);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < n; i++) {
        // A gentle slalom that needs pitch and yaw.
        pts.push(new THREE.Vector3(Math.sin(i * 1.3) * 160 * diff, Math.cos(i * 0.9) * 90 * diff - 40, -500 - i * 520));
      }
      pts.forEach((p, i) => {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: RING_COLOR.clone(), toneMapped: false, transparent: true, opacity: 0.9 }));
        m.position.copy(p);
        const next = pts[i + 1] ?? p.clone().add(new THREE.Vector3(0, 0, -400));
        m.lookAt(next);
        ctx.scene.add(m);
        meshes.push(m);
      });
      ctx.comms.say('instructor', 'tr.i.rings');
      ctx.hint = 'tr.h.rings';
      let passed = 0;
      while (passed < n) {
        const target = meshes[passed];
        (target.material as THREE.MeshBasicMaterial).color.copy(RING_NEXT);
        ctx.markers = [{ pos: target.position, key: 'tr.marker.ring' }];
        let prevZ = player.pos.z;
        yield () => {
          if (skip()) {
            passed = n - 1;
            return true;
          }
          const rel = player.pos.clone().sub(target.position);
          const crossed = prevZ > target.position.z && player.pos.z <= target.position.z;
          prevZ = player.pos.z;
          // Missed rings re-arm: fly back around and try again.
          return crossed && Math.hypot(rel.x, rel.y) < 18 - diff * 3 + 2;
        };
        target.visible = false;
        passed++;
        ctx.audio.ui('confirm');
        ctx.setObjective(idx, { params: { n: passed, total: n }, done: passed >= n });
      }
      ctx.award(300, 'tr.award.rings');
      ctx.markers = [];
      ctx.hint = null;
    }

    function* throttle(): Script {
      const idx = objective('tr.obj.throttle');
      ctx.comms.say('instructor', 'tr.i.throttle');
      ctx.hint = 'tr.h.throttle';
      yield () => player.throttle > 0.97 || skip();
      ctx.hint = 'tr.h.throttle2';
      yield () => (player.throttle < 0.55 && player.throttle > 0.45) || skip();
      ctx.setObjective(idx, { done: true });
      ctx.hint = null;
    }

    function* level(): Script {
      const idx = objective('tr.obj.level');
      ctx.comms.say('instructor', 'tr.i.level');
      ctx.hint = 'tr.h.roll';
      const bank = () => -Math.asin(THREE.MathUtils.clamp(player.right().y, -1, 1));
      yield () => Math.abs(bank()) > 1 || skip();
      ctx.hint = 'tr.h.level';
      yield () => player.autoLevel || skip();
      yield () => (!player.autoLevel && Math.abs(bank()) < 0.08) || skip();
      ctx.setObjective(idx, { done: true });
      ctx.hint = null;
    }

    function* guns(): Script {
      const n = 3;
      const idx = objective('tr.obj.static', { n: 0, total: n });
      ctx.comms.say('instructor', 'tr.i.guns');
      if (player.sfoilTarget < 1) ctx.hint = 'hint.sfoils';
      const fwd = player.forward();
      const base = player.pos.clone().addScaledVector(fwd, 700);
      const list = [-1, 0, 1].map((k) => spawnDrone(base.clone().add(new THREE.Vector3(k * 70, k * 25, k * 40)), false));
      yield () => player.sfoilTarget === 1 || skip();
      ctx.hint = 'tr.h.fire';
      yield () => {
        const dead = list.filter((d) => !d.alive).length;
        ctx.setObjective(idx, { params: { n: dead, total: n }, done: dead >= n });
        if (skip()) for (const d of list) if (d.alive) ctx.world.destroyShip(d, null);
        return dead >= n || list.every((d) => !d.alive);
      };
      ctx.setObjective(idx, { done: true });
      ctx.hint = null;
    }

    function* moving(): Script {
      const n = 3;
      const idx = objective('tr.obj.moving', { n: 0, total: n });
      ctx.comms.say('instructor', 'tr.i.moving');
      ctx.hint = 'tr.h.target';
      const centre = player.pos.clone().addScaledVector(player.forward(), 900);
      const list = [0, 1, 2].map((k) => {
        const d = spawnDrone(centre.clone(), false);
        const a0 = (k * Math.PI * 2) / 3;
        const speed = 0.12 + diff * 0.1;
        d.brain = new KinematicBrain(() => {
          const a = a0 + speed * ctx.world.time;
          return centre.clone().add(new THREE.Vector3(Math.cos(a) * 260, Math.sin(a * 1.7) * 80, Math.sin(a) * 260));
        }, 3);
        return d;
      });
      yield () => {
        const dead = list.filter((d) => !d.alive).length;
        ctx.setObjective(idx, { params: { n: dead, total: n }, done: dead >= n });
        if (skip()) for (const d of list) if (d.alive) ctx.world.destroyShip(d, null);
        return list.every((d) => !d.alive);
      };
      ctx.setObjective(idx, { params: { n, total: n }, done: true });
      ctx.hint = null;
    }

    function* torpedo(): Script {
      const idx = objective('tr.obj.torpedo');
      ctx.comms.say('instructor', 'tr.i.torpedo');
      ctx.hint = 'tr.h.torpedo';
      const d = spawnDrone(player.pos.clone().addScaledVector(player.forward(), 1300).add(new THREE.Vector3(0, 60, 0)), false);
      yield () => !d.alive || skip();
      if (d.alive) ctx.world.destroyShip(d, null);
      ctx.setObjective(idx, { done: true });
      ctx.hint = null;
    }

    function* combat(): Script {
      const n = 2 + Math.round(diff);
      const idx = objective('tr.obj.combat', { n: 0, total: n });
      ctx.comms.say('instructor', 'tr.i.combat');
      ctx.hint = 'hint.deflectorsFront';
      const from = player.pos.clone().addScaledVector(player.forward(), 1500);
      const list = Array.from({ length: n }, (_, k) => spawnDrone(from.clone().add(new THREE.Vector3(k * 40, k * 20, 0)), true));
      yield () => player.deflectors === 'front' || skip();
      ctx.hint = 'tr.h.attacker';
      yield () => {
        const dead = list.filter((x) => !x.alive).length;
        ctx.setObjective(idx, { params: { n: dead, total: n }, done: dead >= n });
        if (skip()) for (const x of list) if (x.alive) ctx.world.destroyShip(x, null);
        return list.every((x) => !x.alive);
      };
      ctx.setObjective(idx, { params: { n, total: n }, done: true });
      ctx.hint = null;
    }

    function* course(): Script {
      yield 1;
      yield ctx.comms.say('instructor', 'tr.i.welcome');
      yield* rings();
      yield* throttle();
      yield* level();
      yield* guns();
      yield* moving();
      yield* torpedo();
      yield* combat();
      ctx.award(500, 'tr.award.complete');
      yield ctx.comms.say('instructor', 'tr.i.done');
      ctx.complete();
    }
    ctx.run(course());
  },
};
