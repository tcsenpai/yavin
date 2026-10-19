// Level 3 — TIE fighters engage. Save Biggs, while Gold and Red Leader make their trench runs.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { DogfightBrain } from '../game/ai';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { StringKey } from '../i18n/i18n';
import { RED, lookQuat, spawnPlayer, spawnShip, spawnTies } from './common';
import type { LevelContext, LevelDef } from './context';
import { buildSurfaceScene, placeTowers } from './surfaceScene';

export const level3: LevelDef = {
  id: 'dogfight',
  titleKey: 'l3.title',
  subKey: 'l3.sub',
  introKey: 'l3.intro',
  setup(ctx: LevelContext) {
    const sc = buildSurfaceScene(ctx, 23);
    const arena = new THREE.Vector3(0, 400, -1500);
    const leash = { center: arena, radius: 2600 };
    placeTowers(ctx, sc.surface, 91, 5, new THREE.Vector3(0, 0, -1500), 2200).forEach((t) => {
      t.interval *= 1.8; // most ground fire has shifted to the fighters
    });
    sc.surface.prewarm(new THREE.Vector3(0, 0, 0));

    const start = new THREE.Vector3(0, 450, 600);
    const heading = lookQuat(start, new THREE.Vector3(0, 380, -1000));
    const player = spawnPlayer(ctx, start, heading);
    player.throttle = 0.8;

    const allies: [StringKey, THREE.Vector3][] = [
      ['spk.biggs', new THREE.Vector3(50, 10, 40)],
      ['spk.wedge', new THREE.Vector3(-50, -5, 40)],
      ['spk.red10', new THREE.Vector3(-140, 30, 60)],
      ['spk.red9', new THREE.Vector3(140, 20, 80)],
    ];
    const ships = allies.map(([key, off]) => {
      const s = spawnShip(ctx, 'xwing', key, start.clone().add(off), heading, RED);
      s.invulnerable = key === 'spk.biggs' || key === 'spk.wedge';
      s.brain = new DogfightBrain({ skill: 0.55, minAltitude: 70, leash, fireScale: 0.5 });
      return s;
    });
    const [biggs, wedge] = ships;

    const need = Math.round(8 + 4 * ctx.difficulty);
    let kills = 0;
    ctx.objectives = [
      { key: 'l3.obj.ties', params: { n: 0, total: need }, done: false },
      { key: 'l3.obj.biggs', done: false },
    ];
    ctx.music('combat');
    sc.flak = 0.6 * ctx.difficulty;

    const ties: Ship[] = [];
    const rng = new Rng(3);
    const wave = (n: number) => {
      const ang = rng.range(0, Math.PI * 2);
      const from = arena.clone().add(new THREE.Vector3(Math.cos(ang) * 2600, rng.range(150, 500), Math.sin(ang) * 2600));
      for (const s of spawnTies(ctx, n, from, player.pos, 0.6, 60, leash)) {
        ties.push(s);
        s.onDestroyed = () => {
          kills++;
          ctx.setObjective(0, { params: { n: Math.min(kills, need), total: need }, done: kills >= need });
        };
      }
    };

    // TIE scream on close pass-bys.
    const screamed = new Set<Ship>();
    ctx.onUpdate = (dt) => {
      sc.update(dt);
      for (const t of ties) {
        if (!t.alive) continue;
        const d = t.pos.distanceTo(player.pos);
        if (d < 90 && !screamed.has(t)) {
          screamed.add(t);
          ctx.audio.tieFlyby(t.pos);
        } else if (d > 300) screamed.delete(t);
      }
      // Keep pressure up until the quota is met.
      const alive = ties.filter((t) => t.alive).length;
      if (kills < need && alive < 3 && ctx.stats.time > 12) wave(Math.min(4, need - kills + 1));
    };

    function* biggsInTrouble(): Script {
      const c = ctx.comms;
      // A TIE latches onto Biggs: player has to clear him.
      const from = biggs.pos.clone().addScaledVector(biggs.forward(), -350).add(new THREE.Vector3(0, 40, 0));
      const chaser = spawnShip(ctx, 'tie', null, from, biggs.quat.clone());
      chaser.throttle = 1;
      chaser.brain = new DogfightBrain({ skill: 0.9, minAltitude: 50, forcedTarget: () => biggs });
      chaser.onDestroyed = () => {
        kills++;
        ctx.setObjective(0, { params: { n: Math.min(kills, need), total: need }, done: kills >= need });
      };
      ties.push(chaser);
      biggs.brain = new DogfightBrain({ skill: 0.3, minAltitude: 80, leash: { center: player.pos, radius: 500 }, fireScale: 0 });
      ctx.markers = [{ pos: biggs.pos, key: 'spk.biggs' }];
      yield c.interrupt('biggs', 'l3.biggs.tail');
      yield c.say('luke', 'l3.luke.biggs');
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
      biggs.brain = new DogfightBrain({ skill: 0.55, minAltitude: 70, leash, fireScale: 0.5 });
      ctx.setObjective(1, { done: true });
      yield c.say('biggs', 'l3.biggs.thanks');
    }

    function* lukeOnTail(): Script {
      const c = ctx.comms;
      const from = player.pos.clone().addScaledVector(player.forward(), -420).add(new THREE.Vector3(0, 30, 0));
      const chaser = spawnShip(ctx, 'tie', null, from, player.quat.clone());
      chaser.throttle = 1;
      chaser.brain = new DogfightBrain({ skill: 0.7 * ctx.difficulty, minAltitude: 50, forcedTarget: () => player });
      ties.push(chaser);
      chaser.onDestroyed = () => {
        kills++;
        ctx.setObjective(0, { params: { n: Math.min(kills, need), total: need }, done: kills >= need });
      };
      yield 3;
      if (!chaser.alive) return;
      yield c.say('luke', 'l3.luke.shake');
      yield c.say('wedge', 'l3.wedge.onHim');
      wedge.brain = new DogfightBrain({ skill: 1, minAltitude: 60, forcedTarget: () => chaser });
      const t1 = ctx.world.time;
      yield () => !chaser.alive || ctx.world.time - t1 > 10;
      if (chaser.alive) ctx.world.destroyShip(chaser, wedge);
      wedge.brain = new DogfightBrain({ skill: 0.55, minAltitude: 70, leash, fireScale: 0.5 });
      yield c.say('luke', 'l3.luke.thanksWedge');
    }

    function* script(): Script {
      const c = ctx.comms;
      yield 1;
      yield c.say('luke', 'l3.luke.scope');
      yield c.say('redLeader', 'l3.rl.visual');
      wave(4);
      yield 2;
      yield c.say('biggs', 'l3.biggs.coming');
      yield () => kills >= 3 || ctx.stats.time > 45;
      ctx.run(lukeOnTail());
      yield () => kills >= 5 || ctx.stats.time > 80;
      ctx.run(biggsInTrouble());
      yield () => ctx.objectives[1].done;
      yield () => kills >= need;
      // The trench runs begin: Gold squadron, then Red Leader. (Over the radio.)
      yield 1;
      yield c.say('goldLeader', 'l3.gold.attackRun');
      yield c.say('gold5', 'l3.gold5.stayOn');
      yield c.say('vader', 'l3.vader.formation');
      yield c.say('gold2', 'l3.gold2.tooClose');
      yield c.say('gold5', 'l3.gold5.stayOn2');
      yield c.say('goldLeader', 'l3.gold.loosen');
      ctx.audio.explosion('medium');
      yield 1;
      yield c.say('gold5', 'l3.gold5.behind');
      ctx.audio.explosion('medium');
      yield 1;
      yield c.say('redLeader', 'l3.rl.rendezvous');
      yield c.say('redLeader', 'l3.rl.away');
      yield c.say('red10', 'l3.red10.negative');
      yield c.say('redLeader', 'l3.rl.hit');
      ctx.audio.explosion('medium');
      yield 1.5;
      yield c.say('luke', 'l3.luke.closeUp');
      yield c.say('wedge', 'l3.wedge.withYou');
      ctx.complete();
    }
    ctx.run(script());
  },
};
