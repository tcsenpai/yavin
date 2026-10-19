// Skirmish modes, fought in orbit above a chosen planet:
// free battle (pick arena, allies, TIEs, Star Destroyers), solo (no allies), survival (endless waves of rising
// difficulty, ends when you are shot down) and random (everything rolled).
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { BatteryRunBrain, DogfightBrain } from '../game/ai';
import { CapitalShip } from '../game/capital';
import type { Ship, ShipKind } from '../game/ship';
import type { StringKey } from '../i18n/i18n';
import { ARENA_IDS, arenaEnv, type ArenaId } from './arenas';
import { GOLD, RED, lookQuat, spawnPlayer, spawnShip } from './common';
import type { LevelContext, LevelDef } from './context';
import { buildEnvironment } from './environment';

export const SKIRMISH_MODES = ['free', 'solo', 'survival', 'random'] as const;
export type SkirmishMode = (typeof SKIRMISH_MODES)[number];

export interface SkirmishConfig {
  mode: SkirmishMode;
  arena: ArenaId;
  allies: number;
  ties: number;
  destroyers: number;
}

export const SKIRMISH_LIMITS: Record<'allies' | 'ties' | 'destroyers', [number, number]> = {
  allies: [0, 11],
  ties: [2, 40],
  destroyers: [0, 3],
};

/** The battle the next skirmish level builds: always set by the menu (Game.startSkirmish) before opening it. */
export const skirmishConfig: SkirmishConfig = { mode: 'free', arena: 'yavin', allies: 0, ties: 2, destroyers: 0 };

/** Resolve the menu choice into a concrete battle: random rolls everything, solo has no allies. */
export function resolveSkirmish(c: SkirmishConfig): SkirmishConfig {
  if (c.mode === 'random') {
    const rng = new Rng(Date.now() % 100000);
    return {
      mode: 'random',
      arena: rng.pick(ARENA_IDS),
      allies: rng.int(0, 8),
      ties: rng.int(6, 24),
      destroyers: rng.int(0, 2),
    };
  }
  return { ...c, allies: c.mode === 'solo' ? 0 : c.allies };
}

export const ARENA_NAME: Record<ArenaId, StringKey> = {
  yavin: 'arena.yavin',
  tatooine: 'arena.tatooine',
  naboo: 'arena.naboo',
  alderaan: 'arena.alderaan',
  coruscant: 'arena.coruscant',
  hoth: 'arena.hoth',
  endor: 'arena.endor',
};

/** Named wingmen first (they talk and come to the player's aid), then anonymous Red and Gold flights. */
const WINGMEN: [StringKey | null, ShipKind][] = [
  ['spk.wedge', 'xwing'],
  ['spk.biggs', 'xwing'],
  ['spk.goldLeader', 'ywing'],
  ['spk.porkins', 'xwing'],
  ['spk.red10', 'xwing'],
  ['spk.gold2', 'ywing'],
  ['spk.red9', 'xwing'],
  ['spk.red7', 'xwing'],
  ['spk.gold5', 'ywing'],
  ['spk.red11', 'xwing'],
  [null, 'xwing'],
];

const ISD_SCALE = 1.75;
/** TIEs alive at once (the rest of the pool joins as they fall). */
const MAX_ALIVE = 12;
/** Hangar-launched TIEs in the air at once, per Star Destroyer. */
const MAX_HANGAR_OUT = 8;

function setup(ctx: LevelContext): void {
  const cfg = skirmishConfig;
  const survival = cfg.mode === 'survival';
  const rng = new Rng(7 + ARENA_IDS.indexOf(cfg.arena));
  const env = buildEnvironment(ctx.scene, { deathStarCenter: null, shadows: false, viewFill: 0.9, ambient: 0.7, ...arenaEnv(cfg.arena) });
  ctx.music('combat');

  const player = spawnPlayer(ctx, new THREE.Vector3(0, 0, 0));
  player.sfoils = player.sfoilTarget = 1;
  player.throttle = 0.7;
  player.setDeflectors('front');

  // The fight follows the player: everyone stays within a few kilometres of Red Five.
  const leash = { center: player.pos.clone(), radius: 2600 };
  const caps: CapitalShip[] = [];
  const allyBrain = (i: number, kind: ShipKind) =>
    caps.length && kind === 'ywing' && i % 2 === 0 ? new BatteryRunBrain(caps, i) : new DogfightBrain({ skill: 0.5, minAltitude: 0, leash, fireScale: 0.35 });
  const allies: Ship[] = [];
  const spawnAlly = (i: number, pos: THREE.Vector3) => {
    const [key, kind] = WINGMEN[i % WINGMEN.length];
    const s = spawnShip(ctx, kind, key, pos, player.quat.clone(), kind === 'ywing' ? GOLD : RED);
    s.sfoils = s.sfoilTarget = 1;
    s.throttle = 0.8;
    s.brain = allyBrain(i, kind);
    allies.push(s);
    return s;
  };
  for (let i = 0; i < cfg.allies; i++) {
    const side = i % 2 ? 1 : -1;
    spawnAlly(i, new THREE.Vector3(side * (40 + Math.floor(i / 2) * 36), (i % 3) * 8 - 8, 30 + Math.floor(i / 2) * 30));
  }

  // ---------------------------------------------------------------- enemies
  const enemies: Ship[] = [];
  let pool = 0; // fighters still to come in this battle / wave
  let advPool = 0;
  let skill = 0.6;
  const spawnGroup = (n: number, kind: ShipKind, from: THREE.Vector3) => {
    const q = lookQuat(from, player.pos);
    for (let i = 0; i < n; i++) {
      const off = new THREE.Vector3((i % 3) * 30 - 30, Math.floor(i / 3) * 20 + (i % 2) * 10, Math.floor(i / 3) * 40).applyQuaternion(q);
      const s = spawnShip(ctx, kind, null, from.clone().add(off), q);
      s.throttle = 1;
      s.brain = new DogfightBrain({ skill: skill * ctx.difficulty, minAltitude: 0, leash });
      enemies.push(s);
    }
  };
  /** New arrivals come from the sides or behind, outside the player's forward view. */
  const arrivalPoint = (dist: number) => {
    const fwd = player.forward();
    const dir = fwd.negate().add(new THREE.Vector3(rng.range(-1.2, 1.2), rng.range(-0.4, 0.5), rng.range(-1.2, 1.2))).normalize();
    return player.pos.clone().addScaledVector(dir, dist);
  };
  const refill = () => {
    let alive = enemies.filter((e) => e.alive).length;
    while (alive < MAX_ALIVE && (pool > 0 || advPool > 0)) {
      if (advPool > 0) {
        advPool--;
        spawnGroup(1, 'tieadv', arrivalPoint(2400));
        alive++;
        continue;
      }
      const n = Math.min(3, pool, MAX_ALIVE - alive);
      pool -= n;
      spawnGroup(n, 'tie', arrivalPoint(2400));
      alive += n;
    }
  };
  const addDestroyer = (i: number) => {
    const ang = (i - 0.5) * 0.9 + rng.range(-0.2, 0.2);
    const p = player.pos.clone().add(new THREE.Vector3(Math.sin(ang) * 6500, rng.range(-500, 500), -Math.cos(ang) * 6500 - 2000));
    const aim = player.pos.clone().add(new THREE.Vector3(-Math.sin(ang) * 2000, p.y, 1500));
    const c = ctx.world.addCapital(new CapitalShip(10 + i, p, lookQuat(p, aim), 25, ctx.difficulty, ISD_SCALE));
    // Like the campaign: TIEs scramble from under the hangar, at most MAX_HANGAR_OUT per destroyer in the
    // air at once, until the hangar or the bridge is knocked out.
    const launched: Ship[] = [];
    c.hangarInterval = 14;
    c.launchRoom = () => Math.max(0, MAX_HANGAR_OUT - launched.filter((t) => t.alive).length);
    c.onLaunch = (t) => {
      t.brain = new DogfightBrain({ skill: skill * ctx.difficulty, minAltitude: 0, leash });
      launched.push(t);
      enemies.push(t);
    };
    c.onSubsystemDestroyed = (s) => {
      if (s.kind === 'bridge') ctx.comms.say(allies.some((a) => a.alive && a.nameKey === 'spk.biggs') ? 'biggs' : 'base', 'ls.biggs.bridge');
    };
    caps.push(c);
    // Y-wings switch to attack runs once there is a destroyer to hit.
    allies.forEach((a, j) => {
      if (a.alive && a.kind === 'ywing') a.brain = allyBrain(j, 'ywing');
    });
  };

  // ---------------------------------------------------------------- objectives & flow
  const enemiesLeft = () => enemies.filter((e) => e.alive).length + pool + advPool;
  const capsLeft = () => caps.filter((c) => !c.disabled).length;
  let wave = 0;
  let waveBreak = 0;
  let deadT = 0;
  let finished = false;

  const startWave = () => {
    wave++;
    ctx.stats.wave = wave;
    skill = Math.min(0.45 + wave * 0.05, 0.95);
    pool = Math.min(3 + wave * 2, 40);
    advPool = wave >= 3 ? Math.floor(wave / 3) : 0;
    if (wave % 5 === 0) addDestroyer(wave / 5 - 1);
    // Reinforcements: every third wave the flight is brought back up to strength.
    if (wave > 1 && wave % 3 === 1) {
      let k = allies.filter((a) => a.alive).length;
      for (let i = 0; k < cfg.allies; i++) {
        if (allies[i]?.alive) continue;
        spawnAlly(i, arrivalPoint(1200));
        k++;
      }
    }
    if (wave > 1) player.hull = Math.min(player.spec.hull, player.hull + player.spec.hull * 0.3);
    ctx.banner('sk.wave', undefined, 3);
    ctx.hint = null;
    refill();
  };

  if (survival) {
    ctx.objectives = [
      { key: 'sk.obj.wave', params: { n: 1 }, done: false },
      { key: 'sk.obj.left', params: { n: 0 }, done: false },
    ];
    startWave();
  } else {
    pool = cfg.ties;
    for (let i = 0; i < cfg.destroyers; i++) addDestroyer(i);
    ctx.objectives = [{ key: 'sk.obj.left', params: { n: enemiesLeft() }, done: false }];
    if (cfg.destroyers) ctx.objectives.push({ key: 'sk.obj.destroyers', params: { n: 0, total: cfg.destroyers }, done: false });
    // The first wave comes in ahead, so the battle opens head-on.
    const first = Math.min(pool, 6);
    pool -= first;
    spawnGroup(first, 'tie', new THREE.Vector3(rng.range(-400, 400), rng.range(-150, 250), -3000));
    refill();
  }
  ctx.comms.say(cfg.allies ? 'wedge' : 'base', cfg.allies ? 'sk.go' : 'sk.solo');
  if (caps.length) ctx.comms.say('base', 'sk.isd');

  ctx.onUpdate = (dt) => {
    env.update(dt, ctx.camera, player.pos);
    leash.center.copy(player.pos);
    // Stragglers kilometres away are brought back behind the player, out of view.
    const fwd = player.forward();
    for (const s of ctx.world.ships) {
      if (s === player || !s.alive || s.kinematic) continue;
      const off = s.pos.clone().sub(player.pos);
      if (off.length() < 4500 || off.normalize().dot(fwd) > 0.3) continue;
      s.pos.copy(arrivalPoint(2200));
      s.vel.copy(player.vel);
    }
    for (const c of caps) if (!c.disabled && c.root.position.distanceTo(player.pos) < 4000) c.vel.multiplyScalar(Math.exp(-0.4 * dt));
    refill();

    const left = enemiesLeft();
    // Markers on the last few fighters and on destroyer shield generators / bridges.
    const near = enemies.filter((e) => e.alive).sort((a, b) => a.pos.distanceToSquared(player.pos) - b.pos.distanceToSquared(player.pos));
    ctx.markers = [
      ...(left <= 3 ? near.slice(0, 3).map((t) => ({ pos: t.pos, key: 'tgt.tie' as StringKey })) : []),
      ...caps.flatMap((c) => {
        if (c.disabled) return [];
        const gens = c.subsystems.filter((s) => s.kind === 'shieldGen' && s.alive);
        if (gens.length) return gens.map((s) => ({ pos: s.pos, key: 'ls.marker.gen' as StringKey }));
        const br = c.subsystems.find((s) => s.kind === 'bridge' && s.alive);
        return br ? [{ pos: br.pos, key: 'ls.marker.bridge' as StringKey }] : [];
      }),
    ];

    if (survival) {
      ctx.setObjective(0, { params: { n: wave } });
      ctx.setObjective(1, { params: { n: left + capsLeft() } });
      if (!player.alive) {
        // Survival ends when you are shot down: the score is what you held out for.
        deadT += dt;
        if (deadT > 2.5) ctx.complete();
        return;
      }
      if (left === 0 && capsLeft() === 0) {
        if (waveBreak === 0) {
          ctx.award(250 * wave, 'sk.award.wave', { n: wave });
          ctx.hint = 'sk.hint.nextWave';
        }
        waveBreak += dt;
        if (waveBreak > 6) {
          waveBreak = 0;
          startWave();
        }
      }
      return;
    }
    ctx.setObjective(0, { params: { n: left }, done: left === 0 });
    if (cfg.destroyers) {
      const down = cfg.destroyers - capsLeft();
      ctx.setObjective(1, { params: { n: down, total: cfg.destroyers }, done: down >= cfg.destroyers });
    }
    if (!finished && player.alive && left === 0 && capsLeft() === 0) {
      finished = true;
      ctx.award(300 + cfg.destroyers * 500, 'sk.award.win');
      ctx.comms.say('base', 'sk.win');
      ctx.run(
        (function* () {
          yield 3;
          ctx.complete();
        })(),
      );
    }
  };
}

const MODE_KEY: Record<SkirmishMode, { title: StringKey; sub: StringKey }> = {
  free: { title: 'sk.mode.free', sub: 'sk.mode.free.desc' },
  solo: { title: 'sk.mode.solo', sub: 'sk.mode.solo.desc' },
  survival: { title: 'sk.mode.survival', sub: 'sk.mode.survival.desc' },
  random: { title: 'sk.mode.random', sub: 'sk.mode.random.desc' },
};
export { MODE_KEY as SKIRMISH_MODE_KEY };

/** Par score for rank S, scaled to the battle size. */
function par(): number {
  const c = skirmishConfig;
  if (c.mode === 'survival') return 9000;
  return Math.round((c.ties * 100 + c.destroyers * 2200 + 300) * (c.allies ? 0.8 : 1.1) + 1200);
}

export const skirmishLevels: LevelDef[] = SKIRMISH_MODES.map((mode) => ({
  id: `skirmish-${mode}`,
  kind: 'skirmish' as const,
  par,
  titleKey: MODE_KEY[mode].title,
  subKey: MODE_KEY[mode].sub,
  introKey: MODE_KEY[mode].sub,
  setup,
}));
