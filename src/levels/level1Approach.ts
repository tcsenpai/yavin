// Level 1 — The approach: roll call, S-foils to attack position, the magnetic field, attack speed.
import * as THREE from 'three';
import { FormationBrain } from '../game/ai';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import { Rng } from '../core/rng';
import { GOLD, RED, spawnPlayer, spawnShip } from './common';
import type { LevelContext, LevelDef } from './context';
import { DEATH_STAR_RADIUS, buildEnvironment } from './environment';
import type { StringKey } from '../i18n/i18n';

const START_DIST = 150000; // surface distance at start (m)
const END_DIST = 5000;

export const level1: LevelDef = {
  id: 'approach',
  titleKey: 'l1.title',
  subKey: 'l1.sub',
  introKey: 'l1.intro',
  controlsKey: 'l1.controls',
  setup(ctx: LevelContext) {
    const R = DEATH_STAR_RADIUS;
    const dsDir = new THREE.Vector3(0.05, -0.22, -1).normalize();
    const env = buildEnvironment(ctx.scene, {
      deathStarCenter: dsDir.clone().multiplyScalar(R + START_DIST),
      dishFacing: dsDir.clone().negate(),
      shadows: false,
      // Behind the formation: Yavin 4 (where they launched) and the gas giant Yavin.
      yavin4Pos: new THREE.Vector3(-0.6e7, 0.2e7, 2.2e7),
      yavinPos: new THREE.Vector3(2.2e8, -0.5e8, -1.4e8),
    });
    const ds = env.deathStar!;

    // Red Leader leads the formation along -Z; everyone else keeps station.
    const lead = spawnShip(ctx, 'xwing', 'spk.redLeader', new THREE.Vector3(0, 0, 0), undefined, RED);
    lead.throttle = 0.45;
    lead.invulnerable = true;
    lead.sfoils = lead.sfoilTarget = 0;
    lead.brain = {
      update(s: Ship) {
        s.ctrl.pitch = s.ctrl.yaw = s.ctrl.roll = 0;
        s.ctrl.fire = false;
      },
    };
    const wing: [StringKey, THREE.Vector3][] = [
      ['spk.wedge', new THREE.Vector3(-26, 2, 22)],
      ['spk.biggs', new THREE.Vector3(26, -2, 24)],
      ['spk.porkins', new THREE.Vector3(-52, 5, 46)],
      ['spk.red10', new THREE.Vector3(80, 10, 70)],
      ['spk.red7', new THREE.Vector3(-80, 10, 70)],
      ['spk.red9', new THREE.Vector3(106, -6, 92)],
      ['spk.red11', new THREE.Vector3(-106, -6, 92)],
    ];
    const reds: Ship[] = [lead];
    for (const [key, off] of wing) {
      const s = spawnShip(ctx, 'xwing', key, off.clone(), undefined, RED);
      s.invulnerable = true;
      s.sfoils = s.sfoilTarget = 0;
      s.brain = new FormationBrain(lead, off);
      reds.push(s);
    }
    // Gold squadron (Y-wings) flying a parallel course.
    const golds: Ship[] = [];
    for (let i = 0; i < 6; i++) {
      const off = new THREE.Vector3(-320 - (i % 3) * 34, 40 + Math.floor(i / 3) * 18, 60 + (i % 3) * 30 + Math.floor(i / 3) * 40);
      const s = spawnShip(ctx, 'ywing', i === 0 ? 'spk.goldLeader' : null, off.clone(), undefined, GOLD);
      s.invulnerable = true;
      s.brain = new FormationBrain(lead, off);
      golds.push(s);
    }

    const player = spawnPlayer(ctx, new THREE.Vector3(52, -4, 48));
    player.sfoils = player.sfoilTarget = 0;
    player.throttle = 0.45;

    ctx.objectives = [
      { key: 'l1.obj.report', done: false },
      { key: 'l1.obj.sfoils', done: false },
      { key: 'l1.obj.deflectors', done: false },
      { key: 'l1.obj.speed', done: false },
      { key: 'l1.obj.formation', done: false },
    ];
    ctx.music('approach');

    let dist = START_DIST;
    let closing = 1450; // m/s scripted closure (time-compressed approach)
    let scriptDone = false;
    let flakOn = false;
    let farTime = 0;
    const rng = new Rng(5);

    ctx.onUpdate = (dt) => {
      dist = Math.max(END_DIST, dist - closing * dt);
      if (!scriptDone) dist = Math.max(dist, 12000);
      ds.mesh.position.copy(lead.pos).addScaledVector(dsDir, R + dist);
      env.update(dt, ctx.camera, player.pos);
      // Stay with the formation.
      const d = player.pos.distanceTo(lead.pos);
      if (d > 900) {
        farTime += dt;
        ctx.hint = 'hint.formation';
        if (farTime > 25) ctx.fail('fail.formation');
      } else {
        farTime = 0;
        if (ctx.hint === 'hint.formation') ctx.hint = null;
      }
      ctx.markers = d > 400 ? [{ pos: lead.pos, key: 'spk.redLeader' }] : [];
      // Flak once inside the defensive envelope.
      if (flakOn && rng.chance(dt * 2.2)) {
        const p = player.pos.clone().add(new THREE.Vector3(rng.range(-400, 400), rng.range(-200, 150), rng.range(-900, -200)));
        ctx.world.fx.flak(p);
        ctx.audio.explosion('small', p);
        if (p.distanceTo(player.pos) < 22) player.takeDamage(8, p, null);
      }
      if (flakOn && rng.chance(dt * 1.5)) {
        const from = player.pos.clone().add(new THREE.Vector3(rng.range(-600, 600), -900, rng.range(-1500, -600)));
        const to = player.pos.clone().add(new THREE.Vector3(rng.range(-80, 80), rng.range(-40, 40), rng.range(-120, 40)));
        ctx.world.weapons.fireBolt(null, from, to.sub(from), 600, 'green', 14, 'empire', true);
      }
      if (scriptDone && dist <= END_DIST + 1) ctx.complete();
    };

    function* script(): Script {
      const c = ctx.comms;
      yield 2.5;
      yield c.say('redLeader', 'l1.rl.reportIn');
      yield c.say('red10', 'l1.red10');
      yield c.say('red7', 'l1.red7');
      yield c.say('biggs', 'l1.red3');
      yield c.say('porkins', 'l1.red6');
      yield c.say('red9', 'l1.red9');
      yield c.say('wedge', 'l1.red2');
      yield c.say('red11', 'l1.red11');
      yield ctx.waitAction('confirm', 'hint.reportIn', 14);
      yield c.say('luke', 'l1.red5');
      ctx.setObjective(0, { done: true });
      yield 1;
      yield c.say('redLeader', 'l1.rl.sfoils');
      for (const s of [...reds, ...golds]) s.sfoilTarget = 1;
      yield ctx.waitAction('sfoils', 'hint.sfoils', 20);
      if (player.sfoilTarget < 1) {
        player.sfoilTarget = 1;
        ctx.audio.sfoils();
      }
      ctx.setObjective(1, { done: true });
      yield 2;
      yield c.say('base', 'l1.base.range');
      yield 1;
      // The magnetic field: shake + interference.
      closing = 1700;
      yield c.say('redLeader', 'l1.rl.field');
      ctx.shake = 0.7;
      ctx.flash = 0.25;
      yield c.say('redLeader', 'l1.rl.doubleFront');
      yield ctx.waitAction('deflectors', 'hint.deflectorsFront', 20);
      if (player.deflectors !== 'front') player.setDeflectors('front');
      ctx.setObjective(2, { done: true });
      yield 1;
      yield c.say('wedge', 'l1.wedge.size');
      yield c.say('redLeader', 'l1.rl.chatter');
      lead.throttle = 0.92;
      ctx.hint = 'hint.throttle';
      yield () => player.throttle > 0.85;
      ctx.hint = null;
      ctx.setObjective(3, { done: true });
      flakOn = true;
      closing = 2400;
      yield c.say('redLeader', 'l1.rl.thisIsIt');
      yield 2;
      yield c.say('goldLeader', 'l1.gold.start');
      yield c.say('redLeader', 'l1.rl.position');
      ctx.setObjective(4, { done: true });
      scriptDone = true;
    }
    ctx.run(script());
  },
};
