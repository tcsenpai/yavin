// Top-level orchestration: menus ↔ levels, player control & flight assists, camera, HUD feedback, scoring.
import * as THREE from 'three';
import { AudioSystem, type MusicMood } from '../audio/audio';
import { Engine } from '../core/engine';
import { Input, type FlightInput } from '../core/input';
import { clamp, damp } from '../core/rng';
import { AIM_ASSIST, DIFFICULTY_SCALE, HULL_REGEN, loadSettings, saveSettings, type Difficulty, type Settings } from '../core/settings';
import { t, type StringKey } from '../i18n/i18n';
import type { LevelContext, LevelDef, LevelStats } from '../levels/context';
import { buildEnvironment } from '../levels/environment';
import { resolveSkirmish, skirmishConfig } from '../levels/skirmish';
import type { XWingModel } from '../models/ships';
import { Hud, type Feedback, type Objective, type TargetInfo } from '../ui/hud';
import { Menus, type Rank } from '../ui/menus';
import { Subsystem } from './capital';
import { DogfightBrain } from './ai';
import { Comms, type Speaker } from './comms';
import { ScriptRunner, type Script } from './script';
import { Ship } from './ship';
import { Tower } from './tower';
import type { Targetable } from './types';
import { World } from './world';

type State = 'menu' | 'card' | 'playing' | 'paused' | 'result';

const TORPEDOES = 6; // T-65: two launchers, three proton torpedoes each
const CONVERGENCE = 450;
const SKIP_HOLD = 1.0; // seconds to hold to skip a cinematic

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Quaternion();

const newStats = (): LevelStats => ({ kills: 0, towers: 0, shots: 0, hits: 0, time: 0, forceUsed: false, score: 0 });

/** Named wingmen who can come to the player's aid, and the radio voice they use. */
const HELPER_SPEAKER: Partial<Record<StringKey, Speaker>> = {
  'spk.wedge': 'wedge',
  'spk.biggs': 'biggs',
  'spk.porkins': 'porkins',
  'spk.redLeader': 'redLeader',
  'spk.red10': 'red10',
  'spk.red9': 'red9',
  'spk.goldLeader': 'goldLeader',
};

/** Points and display name for anything the player destroys. */
function killValue(target: Targetable): { points: number; name: StringKey } | null {
  if (target instanceof Ship) return target.kind === 'tieadv' ? { points: 500, name: 'tgt.tieadv' } : { points: 100, name: target.nameKey ?? 'tgt.tie' };
  if (target instanceof Tower) return target.kind === 'tower' ? { points: 150, name: 'tgt.tower' } : { points: 80, name: 'tgt.wall' };
  if (target instanceof Subsystem) {
    const pts = { shieldGen: 300, bridge: 600, hangar: 300, turbolaser: 120 }[target.kind];
    return { points: pts, name: `tgt.${target.kind}` as StringKey };
  }
  return null;
}

export function targetName(target: Targetable): StringKey {
  if (target instanceof Ship) return target.nameKey ?? (target.kind === 'tieadv' ? 'tgt.tieadv' : target.kind === 'tie' ? 'tgt.tie' : 'tgt.ally');
  if (target instanceof Tower) return target.kind === 'tower' ? 'tgt.tower' : 'tgt.wall';
  if (target instanceof Subsystem) return `tgt.${target.kind}` as StringKey;
  return 'tgt.tie';
}

function hullFraction(target: Targetable): number {
  if (target instanceof Ship) return clamp(target.hull / target.spec.hull, 0, 1);
  if (target instanceof Tower || target instanceof Subsystem) return clamp(target.hp / target.maxHp, 0, 1);
  return 1;
}

/** Silhouette family shown on the targeting display. */
function targetKind(target: Targetable): TargetInfo['kind'] {
  if (target instanceof Ship) return target.kind === 'tie' || target.kind === 'tieadv' ? target.kind : 'other';
  if (target instanceof Tower) return target.kind === 'tower' ? 'tower' : 'wall';
  if (target instanceof Subsystem) return target.kind;
  return 'other';
}

class Ctx implements LevelContext {
  player: Ship | null = null;
  objectives: Objective[] = [];
  markers: { pos: THREE.Vector3; key: StringKey }[] = [];
  timer: { key: StringKey; seconds: number } | null = null;
  hint: StringKey | null = null;
  hintParams?: Record<string, string | number>;
  computer: LevelContext['computer'] = null;
  computerAvailable = false;
  computerOff = false;
  showHud = true;
  playerControl = true;
  torpedoes = TORPEDOES;
  onTorpedo: LevelContext['onTorpedo'] = null;
  cameraOverride: LevelContext['cameraOverride'] = null;
  onUpdate: LevelContext['onUpdate'] = null;
  shake = 0;
  flash = 0;
  r2Alive = true;
  stats = newStats();
  scripts = new ScriptRunner();
  outcome: { kind: 'complete' } | { kind: 'fail'; reason: StringKey } | null = null;
  bannerState: { title: string; sub: string; alpha: number; life: number } | null = null;
  pendingConfirm = false;
  confirmPressed = false;

  constructor(
    readonly scene: THREE.Scene,
    readonly world: World,
    readonly audio: AudioSystem,
    readonly comms: Comms,
    readonly input: Input,
    readonly camera: THREE.PerspectiveCamera,
    readonly difficulty: number,
    readonly checkpoint: number,
    private toast: (text: string, color: string) => void,
    private onCheckpoint: (value: number) => void,
  ) {}

  run(script: Script): void {
    this.scripts.run(script);
  }
  music(mood: MusicMood): void {
    this.audio.setMusic(mood);
  }
  setObjective(i: number, patch: Partial<Objective>): void {
    const o = this.objectives[i];
    if (!o) return;
    const wasDone = o.done;
    Object.assign(o, patch);
    if (!wasDone && o.done) {
      this.audio.ui('objective');
      this.toast(`${t('toast.objective')}: ${t(o.key, o.params)}`, '#ffe14a');
    }
  }
  complete(): void {
    this.outcome ??= { kind: 'complete' };
  }
  fail(reason: StringKey): void {
    this.outcome ??= { kind: 'fail', reason };
  }
  banner(title: StringKey, sub?: StringKey, seconds = 3.5): void {
    this.bannerState = { title: t(title), sub: sub ? t(sub) : '', alpha: 0, life: seconds };
  }
  award(points: number, label: StringKey, params?: Record<string, string | number>): void {
    this.stats.score += points;
    this.toast(`+${points}  ${t(label, params)}`, '#ffd27a');
  }
  reachCheckpoint(value: number): void {
    this.onCheckpoint(value);
  }
  waitAction(action: 'confirm' | 'sfoils' | 'deflectors' | 'targetComputer', hint: StringKey, timeout = 15): () => boolean {
    this.hint = hint;
    const start = this.world.time;
    const p = this.player;
    const initial = { sfoils: p?.sfoilTarget, defl: p?.deflectors, computer: this.computerOff };
    let pressed = false;
    this.pendingConfirm = action === 'confirm';
    return () => {
      if (action === 'confirm') pressed = this.confirmPressed;
      else if (action === 'sfoils') pressed = !!p && p.sfoilTarget !== initial.sfoils && p.sfoilTarget === 1;
      else if (action === 'deflectors') pressed = !!p && p.deflectors !== initial.defl;
      else pressed = this.computerOff !== initial.computer;
      const done = pressed || this.world.time - start > timeout;
      if (done) {
        if (this.hint === hint) this.hint = null;
        this.pendingConfirm = false;
        this.confirmPressed = false;
      }
      return done;
    };
  }
}

export class Game {
  private engine: Engine;
  private input: Input;
  private audio = new AudioSystem();
  private hud: Hud;
  private comms: Comms;
  private menus: Menus;
  private settings: Settings = loadSettings();
  private state: State = 'menu';
  private ctx: Ctx | null = null;
  private level: LevelDef;
  private checkpoint = 0;
  /** Difficulty the current level was built with. */
  private levelDifficulty: Difficulty = 'pilot';
  private inCampaign = false;
  private campaignStats = newStats();
  private last = performance.now();
  private elapsed = 0;
  private menuScene: THREE.Scene | null = null;
  // Player-side state
  private target: Targetable | null = null;
  private lockT = 0;
  private lockTime = 1;
  /** Automatic laser lock on an enemy fighter (see AIM_ASSIST.laserLock). */
  private laserLock: Ship | null = null;
  private laserAcq = 0;
  private laserAcqFor: Ship | null = null;
  /** Target the pilot released by hand: not re-locked until another target is chosen or L is pressed again. */
  private lockReleased: Targetable | null = null;
  private assisted = false;
  private manualTargetAt = -99;
  private cockpit = false;
  private hudHidden = false;
  private lookBack = false;
  private camQuat = new THREE.Quaternion();
  private camPos = new THREE.Vector3();
  private deadTime = 0;
  private readonly tgtDir = new THREE.Vector3();
  private repairChirp = 0;
  private skipT = 0;
  private stick = { x: 0, y: 0 };
  private enemyOnTail = false;
  private tailSince = 0;
  private helpCooldown = 10;
  private helper: { ship: Ship; chaser: Ship; brain: DogfightBrain; prevBrain: Ship['brain']; prevScale: number; until: number; speaker: Speaker } | null = null;
  private feedback: Feedback = { hit: 0, kill: 0, damage: [], toasts: [], score: 0 };

  constructor(
    container: HTMLElement,
    private levels: LevelDef[],
    private campaign: string[],
  ) {
    this.level = levels[0];
    this.engine = new Engine(container);
    this.input = new Input(this.engine.canvas);
    this.hud = new Hud(container);
    this.comms = new Comms(this.audio);
    this.menus = new Menus(container, levels, campaign, this.settings, {
      startCampaign: () =>
        this.unlockAudio(() =>
          this.menus.showCrawl(() => {
            this.inCampaign = true;
            this.campaignStats = newStats();
            this.openLevel(campaign[0], 0);
          }),
        ),
      startLevel: (id, cp) =>
        this.unlockAudio(() => {
          this.inCampaign = false;
          this.openLevel(id, cp ?? 0);
        }),
      startSkirmish: (cfg) =>
        this.unlockAudio(() => {
          this.settings.skirmish = cfg;
          saveSettings(this.settings);
          Object.assign(skirmishConfig, resolveSkirmish(cfg));
          this.inCampaign = false;
          this.openLevel(`skirmish-${cfg.mode}`, 0);
        }),
      continueCampaign: () =>
        this.unlockAudio(() => {
          const r = this.resumePoint();
          this.inCampaign = true;
          // Continuing keeps this session's running totals; only a fresh start (nothing to resume) resets them.
          if (!r) this.campaignStats = newStats();
          this.openLevel(r?.id ?? campaign[0], r?.checkpoint ?? 0);
        }),
      resumeInfo: () => {
        const r = this.resumePoint();
        const lv = r && this.levels.find((l) => l.id === r.id);
        if (!r || !lv) return null;
        const cp = lv.checkpoints?.find((c) => c.value === r.checkpoint);
        return `${t(lv.titleKey)}${cp && r.checkpoint > 0 ? ` · ${t(cp.key)}` : ''}`;
      },
      setDifficulty: (d) => {
        this.settings.difficulty = d;
        this.applySettings(this.settings);
        this.openLevel(this.level.id, this.checkpoint);
      },
      settingsChanged: (s) => this.applySettings(s),
      resume: () => this.resume(),
      restart: (cp) => this.openLevel(this.level.id, cp ?? this.checkpoint),
      quit: () => this.toMenu(),
      next: () => this.openNext(),
      uiSound: (k) => this.audio.ui(k),
    });
    this.applySettings(this.settings);
    this.engine.canvas.addEventListener('click', () => {
      if (this.state === 'playing') this.input.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.input.locked && this.state === 'playing' && this.ctx?.playerControl && this.ctx.showHud) this.pause();
    });
    window.addEventListener('keydown', (e) => {
      if (this.state === 'playing' && (e.code === 'KeyP' || (e.code === 'Escape' && !this.input.locked))) this.pause();
    });
    this.buildMenuBackdrop();
    this.menus.showTitle();
    requestAnimationFrame((ts) => this.frame(ts));
  }

  private unlockAudio(then: () => void): void {
    void this.audio.init().then(() => this.applyAudioSettings());
    then();
  }

  private applyAudioSettings(): void {
    this.audio.setMasterVolume(this.settings.master);
    this.audio.setMusicVolume(this.settings.music);
  }

  private applySettings(s: Settings): void {
    this.settings = s;
    saveSettings(s);
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.comms.voices = s.voices;
    if (this.engine.quality !== s.quality) this.engine.setQuality(s.quality);
    this.applyAudioSettings();
  }

  /** Slowly drifting Death Star + Yavin behind the title menu. */
  private buildMenuBackdrop(): void {
    const scene = new THREE.Scene();
    const env = buildEnvironment(scene, {
      deathStarCenter: new THREE.Vector3(-90000, 30000, -340000),
      dishFacing: new THREE.Vector3(0.4, 0, 1).normalize(),
      shadows: false,
      yavinPos: new THREE.Vector3(1.7e8, -0.9e8, -2.6e8),
      yavin4Pos: new THREE.Vector3(-1.5e7, -0.6e7, 3e7),
    });
    scene.userData.update = (dt: number) => {
      const cam = this.engine.camera;
      this.elapsed += dt;
      cam.position.set(0, 0, 0);
      cam.fov = 55;
      cam.updateProjectionMatrix();
      cam.quaternion.setFromEuler(new THREE.Euler(0.05, Math.sin(this.elapsed * 0.03) * 0.08 + 0.05, 0));
      env.update(dt, cam, cam.position);
    };
    // Kept for the whole session: never disposed when a level replaces it.
    scene.userData.persistent = true;
    this.menuScene = scene;
    this.engine.setScene(scene);
  }

  private toMenu(): void {
    this.input.releaseLock();
    this.teardownLevel();
    this.state = 'menu';
    this.inCampaign = false;
    this.audio.stopEngine();
    this.audio.alarm(false);
    this.audio.lockTone(false);
    this.audio.setMusic('menu');
    this.engine.fade = 0;
    if (this.menuScene) this.engine.setScene(this.menuScene);
    this.menus.showTitle();
  }

  private teardownLevel(): void {
    this.ctx?.scripts.clear();
    this.ctx = null;
    this.comms.clear();
    this.target = null;
    // Leaving a paused level (restart, checkpoint, quit) must un-suspend audio, and the old HUD must not
    // stay frozen over the next card.
    this.audio.resume();
    this.hud.clear();
  }

  /** Called by levels as the player passes a checkpoint: retries resume from here, and it unlocks in the menu. */
  private saveCheckpoint(level: LevelDef, value: number): void {
    if (value <= this.checkpoint) return;
    this.checkpoint = value;
    const prev = this.settings.checkpoints[level.id] ?? 0;
    if (value > prev) {
      this.settings.checkpoints[level.id] = value;
      saveSettings(this.settings);
    }
    this.feedback.toasts.push({ text: t('toast.checkpoint'), color: '#8fd3ff', life: 3.5 });
    this.audio.ui('objective');
  }

  /** Furthest point reached in the campaign: the next mission after the last completed one, or a saved checkpoint. */
  private resumePoint(): { id: string; checkpoint: number } | null {
    let best: { id: string; checkpoint: number } | null = null;
    const missions = this.campaign.filter((id) => this.levels.find((l) => l.id === id)?.kind === 'mission');
    for (const [i, id] of missions.entries()) {
      const cp = this.settings.checkpoints[id] ?? 0;
      if (this.settings.completed.includes(id)) {
        const next = missions[i + 1];
        best = next ? { id: next, checkpoint: this.settings.checkpoints[next] ?? 0 } : { id, checkpoint: 0 };
      } else if (cp > 0) best = { id, checkpoint: cp };
    }
    return best;
  }

  private openNext(): void {
    const i = this.campaign.indexOf(this.level.id);
    if (i < 0 || i + 1 >= this.campaign.length) {
      this.toMenu();
      return;
    }
    this.inCampaign = true;
    this.openLevel(this.campaign[i + 1], 0);
  }

  private openLevel(id: string, checkpoint: number): void {
    const level = this.levels.find((l) => l.id === id);
    if (!level) {
      this.toMenu();
      return;
    }
    this.level = level;
    this.checkpoint = checkpoint;
    this.input.releaseLock();
    this.teardownLevel();
    this.state = 'card';
    this.audio.stopEngine();
    this.audio.alarm(false);
    this.audio.lockTone(false);
    this.menus.showLoading();
    // Build behind the card so the first frame is ready.
    setTimeout(() => {
      const scene = new THREE.Scene();
      const world = new World(scene, this.audio);
      // The level is built for this difficulty: assists, regen and records follow it even if the setting
      // is changed from the pause menu (that takes effect on the next level).
      this.levelDifficulty = this.settings.difficulty;
      const diff = DIFFICULTY_SCALE[this.levelDifficulty];
      world.difficulty = diff;
      this.feedback = { hit: 0, kill: 0, damage: [], toasts: [], score: 0 };
      const ctx = new Ctx(
        scene,
        world,
        this.audio,
        this.comms,
        this.input,
        this.engine.camera,
        diff,
        checkpoint,
        (text, color) => this.feedback.toasts.push({ text, color, life: 3.2 }),
        (value) => this.saveCheckpoint(level, value),
      );
      this.ctx = ctx;
      this.wireWorldEvents(ctx);
      level.setup(ctx);
      this.engine.setScene(scene);
      this.cockpit = false;
      this.deadTime = 0;
      this.lockT = 0;
      this.laserLock = null;
      this.laserAcq = 0;
      this.lockReleased = null;
      this.skipT = 0;
      this.manualTargetAt = -99;
      this.helper = null;
      this.tailSince = 0;
      this.helpCooldown = 10;
      if (ctx.player) {
        this.camQuat.copy(ctx.player.quat);
        this.camPos.copy(ctx.player.pos);
      }
      // Render one frame (compiles shaders) under the card.
      this.updateCamera(ctx, 0.016);
      this.engine.render(0);
      // Cinematics start immediately (they are skippable); flyable levels show the mission card.
      if (level.kind === 'cinematic') this.beginPlay();
      else this.menus.showCard(level, this.settings.difficulty, () => this.beginPlay());
    }, 30);
  }

  private wireWorldEvents(ctx: Ctx): void {
    ctx.world.events = {
      onDestroyed: (target, killer) => {
        if (target === this.target) this.target = null;
        if (!killer || killer !== ctx.player) return;
        const v = killValue(target);
        if (target instanceof Ship) ctx.stats.kills++;
        if (target instanceof Tower || target instanceof Subsystem) ctx.stats.towers++;
        if (v) {
          ctx.award(v.points, 'toast.kill', { name: t(v.name) });
          this.feedback.kill = 0.5;
        }
      },
      onTargetHit: (target, attacker) => {
        if (attacker && attacker === ctx.player && target.team === 'empire') {
          ctx.stats.hits++;
          this.feedback.hit = 0.18;
        }
      },
      onPlayerHit: (from) => {
        ctx.shake = Math.max(ctx.shake, 0.35);
        this.engine.damage = Math.min(1, this.engine.damage + 0.35);
        const p = ctx.player;
        if (!p) return;
        // Direction indicator around the reticle, in the camera's frame.
        _inv.copy(this.engine.camera.quaternion).invert();
        _v.copy(from).sub(p.pos).applyQuaternion(_inv);
        this.feedback.damage.push({ angle: Math.atan2(_v.x, _v.y), life: 1.2 });
        if (this.feedback.damage.length > 6) this.feedback.damage.shift();
      },
      onPlayerCrash: () => {
        ctx.shake = Math.max(ctx.shake, 0.6);
        this.engine.damage = Math.min(1, this.engine.damage + 0.1);
      },
    };
  }

  private beginPlay(): void {
    this.menus.hide();
    this.state = 'playing';
    this.input.clearPresses();
    this.input.centerStick();
    if (this.ctx?.showHud) this.input.requestLock();
    this.last = performance.now();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.releaseLock();
    this.audio.suspend();
    this.menus.showPause(this.unlockedCheckpoints(this.level), this.checkpoint);
  }

  private unlockedCheckpoints(level: LevelDef): { key: StringKey; value: number }[] | undefined {
    const reached = Math.max(this.settings.checkpoints[level.id] ?? 0, this.checkpoint);
    return level.checkpoints?.filter((c) => c.value <= reached);
  }

  private resume(): void {
    this.menus.hide();
    this.state = 'playing';
    this.audio.resume();
    this.input.clearPresses();
    if (this.ctx?.showHud) this.input.requestLock();
    this.last = performance.now();
  }

  private rank(score: number): Rank {
    const par = typeof this.level.par === 'function' ? this.level.par() : (this.level.par ?? 1000);
    return score >= par ? 'S' : score >= par * 0.75 ? 'A' : score >= par * 0.5 ? 'B' : 'C';
  }

  private finishLevel(ctx: Ctx): void {
    const o = ctx.outcome!;
    this.input.releaseLock();
    this.audio.stopEngine();
    this.audio.alarm(false);
    this.audio.lockTone(false);
    this.state = 'result';
    const level = this.level;
    if (o.kind === 'fail') {
      this.audio.ui('fail');
      this.audio.setMusic('defeat');
      this.menus.showFail(o.reason, this.unlockedCheckpoints(level), this.checkpoint);
      return;
    }
    if (level.kind === 'cinematic') {
      // Epilogue closes the campaign; the briefing (an extra) returns to the menu.
      if (this.inCampaign && this.campaign.indexOf(level.id) === this.campaign.length - 1) {
        this.audio.setMusic('victory');
        this.menus.showEnding(this.campaignStats, this.rank(this.campaignStats.score));
      } else if (this.inCampaign) this.openNext();
      else this.toMenu();
      return;
    }
    // End-of-mission bonuses: hull integrity and gunnery.
    const p = ctx.player;
    const hull = p ? clamp(p.hull / p.spec.hull, 0, 1) * 100 : 0;
    const accuracy = ctx.stats.shots ? ctx.stats.hits / ctx.stats.shots : 0;
    const bonus = Math.round(hull * 5 + accuracy * 1000);
    ctx.stats.score += bonus;
    const rank = this.rank(ctx.stats.score);
    if (!this.settings.completed.includes(level.id)) this.settings.completed.push(level.id);
    const prev = this.settings.best[level.id];
    const isBest = !prev || ctx.stats.score > prev.score;
    if (isBest) this.settings.best[level.id] = { score: ctx.stats.score, rank, difficulty: this.levelDifficulty };
    saveSettings(this.settings);
    if (this.inCampaign) {
      for (const k of ['kills', 'towers', 'shots', 'hits', 'time', 'score'] as const) this.campaignStats[k] += ctx.stats[k];
      this.campaignStats.forceUsed ||= ctx.stats.forceUsed;
    }
    this.audio.ui('objective');
    const hasNext = this.inCampaign && this.campaign.indexOf(level.id) < this.campaign.length - 1;
    this.menus.showResult(level, ctx.stats, { hull, bonus, rank, best: isBest }, hasNext);
  }

  // ---------------------------------------------------------------- player

  private pickTarget(p: Ship, world: World, cycle: boolean): void {
    const fwd = p.forward(_v);
    const all = world.targetables
      .filter((tg) => tg.team === 'empire' && tg.alive)
      .map((tg) => {
        _w.copy(tg.pos).sub(p.pos);
        const d = _w.length();
        const cos = _w.dot(fwd) / Math.max(d, 1);
        return { tg, score: (1.2 - cos) * 3000 + d * 0.5, d };
      });
    // Prefer what's in front within 5 km; if nothing is that close, fall back to the nearest hostile anywhere
    // so the edge arrow always leads the player to the remaining enemies.
    let cands = all.filter((c) => c.d < 5000).sort((a, b) => a.score - b.score);
    if (!cands.length) cands = all.sort((a, b) => a.d - b.d).slice(0, 1);
    if (!cands.length) {
      this.target = null;
      return;
    }
    if (cycle && this.target) {
      const i = cands.findIndex((c) => c.tg === this.target);
      this.target = cands[(i + 1) % cands.length].tg;
    } else this.target = cands[0].tg;
  }

  /** Auto-level: roll wings level and bring the nose to the horizon; any stick input cancels it. */
  private applyAutoLevel(p: Ship, inp: FlightInput): void {
    if (Math.abs(inp.pitch) + Math.abs(inp.yaw) + Math.abs(inp.roll) > 0.25) {
      p.autoLevel = false;
      return;
    }
    const nose = Math.asin(clamp(p.forward(_w).y, -1, 1));
    // Signed roll angle about the nose relative to world up: 0 = level, ±π = inverted, >0 = right wing down.
    const rollErr = Math.atan2(-p.right(_v).y, p.up(_w).y);
    p.ctrl.roll = clamp(-rollErr * 2.2, -1, 1);
    p.ctrl.pitch = Math.abs(rollErr) < 0.6 ? clamp(-nose * 2.5, -1, 1) : 0;
    p.ctrl.yaw = 0;
    if (Math.abs(rollErr) < 0.03 && Math.abs(nose) < 0.03) p.autoLevel = false;
  }

  private controlPlayer(ctx: Ctx, p: Ship, dt: number): THREE.Vector3 | null {
    const inp = this.input.read(dt);
    this.stick = inp.stick;
    this.lookBack = inp.lookBack;
    if (this.input.consume('camera')) this.cockpit = !this.cockpit;
    if (this.input.consume('hud')) this.hudHidden = !this.hudHidden;
    if (this.input.consume('confirm') && ctx.pendingConfirm) ctx.confirmPressed = true;
    if (!ctx.playerControl || p.brain) {
      this.input.clearPresses();
      return null;
    }
    p.ctrl.pitch = inp.pitch;
    p.ctrl.yaw = inp.yaw;
    p.ctrl.roll = inp.roll;
    p.boosting = inp.boost;
    for (const [action, dir] of [['evadeLeft', -1], ['evadeRight', 1]] as const) {
      if (this.input.consume(action) && p.startEvade(dir)) this.audio.sfoils();
    }
    if (this.input.consume('level')) p.autoLevel = !p.autoLevel;
    if (p.autoLevel) this.applyAutoLevel(p, inp);
    p.throttle = clamp(p.throttle + inp.throttleDelta * 0.55 * dt, 0, 1);
    for (const [k, v] of [['throttle1', 0.25], ['throttle2', 0.5], ['throttle3', 0.75], ['throttle4', 1]] as const) {
      if (this.input.consume(k)) p.throttle = v;
    }
    if (this.input.consume('sfoils')) {
      p.sfoilTarget = p.sfoilTarget > 0.5 ? 0 : 1;
      this.audio.sfoils();
    }
    if (this.input.consume('deflectors')) {
      p.setDeflectors(p.deflectors === 'balanced' ? 'front' : p.deflectors === 'front' ? 'rear' : 'balanced');
      this.audio.ui('select');
    }
    if (this.input.consume('targetComputer') && ctx.computerAvailable) {
      ctx.computerOff = !ctx.computerOff;
      this.audio.ui('select');
    }
    if (this.input.consume('targetAttacker')) {
      // Target whoever last hit us, else the closest hostile fighter behind.
      const att = p.lastAttacker?.alive && p.lastAttacker.team !== p.team ? p.lastAttacker : null;
      const tail = ctx.world.ships.filter((s) => s.alive && s.team !== p.team).sort((a, b) => a.pos.distanceToSquared(p.pos) - b.pos.distanceToSquared(p.pos))[0];
      const pick = att ?? tail ?? null;
      if (pick) {
        this.target = pick;
        this.manualTargetAt = ctx.world.time;
        this.audio.ui('select');
      }
    }
    const cycle = this.input.consume('target');
    if (cycle) this.manualTargetAt = ctx.world.time;
    // Also re-pick when the auto-selected target is far away (>5 km) and the player hasn't chosen it by hand.
    const stale = !!this.target && this.target.pos.distanceTo(p.pos) > 5000 && ctx.world.time - this.manualTargetAt > 4;
    if (cycle || stale || !this.target?.alive) this.pickTarget(p, ctx.world, cycle);

    // Aim: cannons converge ahead. Aim assist (difficulty-scaled, optional) only engages when the reticle is
    // already close to a hostile's lead point: it bends the bolts onto that point and adds a little stick friction.
    const fwd = p.forward(_v).clone();
    const aim = p.pos.clone().addScaledVector(fwd, CONVERGENCE);
    const prof = AIM_ASSIST[this.levelDifficulty];
    this.lockTime = prof.lockTime;
    this.assisted = false;
    if (this.settings.aimAssist) {
      let best: Targetable | null = null;
      let bestK = 1;
      const lead = new THREE.Vector3();
      for (const h of ctx.world.targetables) {
        if (h.team === p.team || !h.alive) continue;
        const d = h.pos.distanceTo(p.pos);
        if (d > prof.range || d < 20) continue;
        _w.copy(h.pos).addScaledVector(h.vel, d / p.spec.boltSpeed).sub(p.pos).normalize();
        const ang = Math.acos(clamp(_w.dot(fwd), -1, 1));
        // Capture cone: base angle (narrower at long range) + the target's own angular size.
        const cone = THREE.MathUtils.degToRad(prof.coneDeg) * clamp(800 / d, 0.5, 1) + Math.atan(h.radius / d);
        const k = ang / cone;
        if (k < bestK) {
          bestK = k;
          best = h;
          lead.copy(h.pos).addScaledVector(h.vel, d / p.spec.boltSpeed);
        }
      }
      if (best) {
        aim.copy(lead);
        this.assisted = true;
        // Reticle friction: easier to stay on target, never steers for you.
        const f = prof.friction * (1 - bestK);
        p.ctrl.pitch *= 1 - f;
        p.ctrl.yaw *= 1 - f;
        // Soft targeting: follow what you're aiming at unless you picked a target recently or hold a laser lock.
        if (best !== this.target && !this.laserLock && ctx.world.time - this.manualTargetAt > 4) this.target = best;
      }
    }
    const tg = this.target;
    let locked = false;
    if (tg?.alive) {
      const d = tg.pos.distanceTo(p.pos);
      _w.copy(tg.pos).sub(p.pos).normalize();
      // Acquire inside a tight cone; once locked, hold the lock through a wider one.
      const hold = this.lockT >= this.lockTime ? 0.94 : 0.992;
      if (_w.dot(fwd) > hold && d < 1800) this.lockT = Math.min(this.lockTime, this.lockT + dt);
      else this.lockT = Math.max(0, this.lockT - dt * 2);
      locked = this.lockT >= this.lockTime;
    } else this.lockT = 0;
    this.updateLaserLock(p, fwd, prof.laserLock, aim, dt);
    this.audio.lockTone(locked && ctx.torpedoes > 0);

    if (inp.fire && p.fireCannons(ctx.world, aim)) ctx.stats.shots += 2;
    if (inp.torpedo && !ctx.onTorpedo?.()) {
      if (ctx.torpedoes > 0) {
        ctx.torpedoes--;
        p.model.root.updateMatrixWorld();
        const ports = (p.model as XWingModel).torpedoPorts ?? [];
        const o = ports[ctx.torpedoes % 2]?.getWorldPosition(new THREE.Vector3()) ?? p.pos.clone();
        ctx.world.weapons.fireTorpedo(p, o, p.vel.clone().addScaledVector(fwd, 40), locked ? tg : null, null);
        this.audio.torpedo();
        this.lockT = 0;
      } else this.audio.ui('fail');
    }
    // The HUD reticle stays on the fixed convergence point; assist only bends the bolts.
    return p.pos.clone().addScaledVector(fwd, CONVERGENCE);
  }

  /**
   * Laser lock: the selected enemy fighter is locked once it has been in view (within ~30° of the nose, under
   * 1.8 km) for the difficulty's delay; the lock then holds while it stays in view (40°, 2.5 km) and selected.
   * While locked, bolts fired with the lead point inside `steerDeg` of the nose are directed onto it.
   */
  private updateLaserLock(p: Ship, fwd: THREE.Vector3, prof: { delay: number; steerDeg: number } | null, aim: THREE.Vector3, dt: number): void {
    const tg = this.target;
    if (this.input.consume('lock')) {
      if (this.laserLock) {
        this.lockReleased = this.laserLock;
        this.laserLock = null;
        this.laserAcq = 0;
        this.audio.ui('select');
      } else this.lockReleased = null;
    }
    if (this.lockReleased && this.lockReleased !== tg) this.lockReleased = null;
    const fighter = tg instanceof Ship && tg.alive && !tg.kinematic && tg.team !== p.team ? tg : null;
    if (!prof || !this.settings.aimAssist || !fighter || fighter === this.lockReleased) {
      this.laserLock = null;
      this.laserAcq = 0;
      return;
    }
    _w.copy(fighter.pos).sub(p.pos);
    const d = _w.length();
    const cos = _w.dot(fwd) / Math.max(d, 1);
    if (this.laserLock === fighter) {
      if (cos < Math.cos(THREE.MathUtils.degToRad(40)) || d > 2500) {
        this.laserLock = null;
        this.laserAcq = 0;
      }
    } else {
      this.laserLock = null;
      if (this.laserAcqFor !== fighter) {
        this.laserAcqFor = fighter;
        this.laserAcq = 0;
      }
      const inView = cos > Math.cos(THREE.MathUtils.degToRad(30)) && d < 1800;
      this.laserAcq = inView ? this.laserAcq + dt : Math.max(0, this.laserAcq - dt * 2);
      if (inView && this.laserAcq >= prof.delay) {
        this.laserLock = fighter;
        this.audio.ui('confirm');
      }
    }
    if (!this.laserLock) return;
    _v.copy(fighter.pos).addScaledVector(fighter.vel, d / p.spec.boltSpeed);
    _w.copy(_v).sub(p.pos).normalize();
    if (_w.dot(fwd) > Math.cos(THREE.MathUtils.degToRad(prof.steerDeg))) {
      aim.copy(_v);
      this.assisted = true;
    }
  }

  private updateCamera(ctx: Ctx, dt: number): void {
    const cam = this.engine.camera;
    if (ctx.cameraOverride?.(cam, dt)) return;
    const p = ctx.player;
    if (!p) return;
    if (p.alive) {
      this.camQuat.slerp(p.quat, this.cockpit ? 1 : damp(4.5, dt));
      this.camPos.copy(p.pos);
    }
    const model = p.model as XWingModel;
    if (this.lookBack && p.alive) {
      // Rear view: camera ahead of the nose looking back over the ship (who's on my tail?).
      p.model.root.visible = true;
      _v.set(0, 5, -26).applyQuaternion(p.quat);
      cam.position.copy(p.pos).add(_v);
      _w.set(0, 2, 120).applyQuaternion(p.quat).add(p.pos);
      cam.up.set(0, 1, 0).applyQuaternion(p.quat);
      cam.lookAt(_w);
    } else if (this.cockpit && p.alive && model.cockpitAnchor) {
      p.model.root.updateMatrixWorld();
      model.cockpitAnchor.getWorldPosition(cam.position);
      cam.quaternion.copy(p.quat);
      p.model.root.visible = false;
    } else {
      p.model.root.visible = p.alive;
      const back = p.alive ? 22 : 60;
      _v.set(0, 4.8, back).applyQuaternion(this.camQuat);
      cam.position.copy(this.camPos).add(_v);
      // Aim above the ship so it sits low in frame and the reticle area stays clear.
      _w.set(0, 3.2, -90).applyQuaternion(this.camQuat).add(this.camPos);
      cam.up.set(0, 1, 0).applyQuaternion(this.camQuat);
      cam.lookAt(_w);
    }
    // Shake.
    const s = ctx.shake * ctx.shake;
    if (s > 0.001) {
      _q.setFromEuler(new THREE.Euler((Math.random() - 0.5) * s * 0.06, (Math.random() - 0.5) * s * 0.06, (Math.random() - 0.5) * s * 0.04));
      cam.quaternion.multiply(_q);
    }
    const speedK = p.alive ? clamp((p.speed - p.spec.minSpeed) / (p.spec.maxSpeed - p.spec.minSpeed), 0, 1) : 0;
    const fov = (this.cockpit ? 74 : 66) + speedK * 8;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * damp(3, dt);
      cam.updateProjectionMatrix();
    }
  }

  private targetInfo(tg: Targetable, p: Ship): TargetInfo {
    _w.copy(tg.pos).sub(p.pos);
    const distance = _w.length();
    const dir = this.tgtDir.copy(_w).divideScalar(Math.max(distance, 1e-3));
    // Closing rate: relative velocity projected onto the line of sight (positive = range shrinking).
    const closing = _v.copy(p.vel).sub(tg.vel).dot(dir);
    dir.applyQuaternion(_inv.copy(p.quat).invert());
    return {
      name: t(targetName(tg)),
      kind: targetKind(tg),
      hull: hullFraction(tg),
      shielded: tg instanceof Subsystem && tg.shielded,
      distance,
      speed: tg.vel.length(),
      closing,
      dir,
    };
  }

  /** The hostile fighter sitting on the player's six (within 700 m, nose on us), if any. */
  private findTail(p: Ship, world: World): Ship | null {
    const fwd = p.forward(_v);
    for (const s of world.ships) {
      // Scripted pursuers (the trench run) drive their own alarms.
      if (!s.alive || s.team === p.team || s.kinematic) continue;
      _w.copy(s.pos).sub(p.pos);
      const d = _w.length();
      if (d > 700 || d < 1) continue;
      if (_w.dot(fwd) / d > -0.6) continue;
      if (s.forward(new THREE.Vector3()).dot(_w.normalize().negate()) > 0.9) return s;
    }
    return null;
  }

  /**
   * Wingman assist ("I'm on him, Luke!"): if a fighter stays on the player's tail for a few seconds, the
   * nearest named wingman breaks off to clear it, then returns to what it was doing.
   */
  private updateWingmanAssist(ctx: Ctx, p: Ship, tail: Ship | null, dt: number): void {
    this.tailSince = tail ? this.tailSince + dt : 0;
    this.helpCooldown -= dt;
    const h = this.helper;
    if (h) {
      const over = !h.chaser.alive || !h.ship.alive || ctx.world.time > h.until;
      if (!over) return;
      // Hand the pilot back only if nothing (a level script) re-tasked him meanwhile.
      if (h.ship.alive && h.ship.brain === h.brain) {
        h.ship.brain = h.prevBrain;
        h.ship.damageScale = h.prevScale;
        if (!h.chaser.alive) this.comms.say(h.speaker, 'help.clear');
      }
      this.helper = null;
      return;
    }
    if (!tail || tail.kinematic || this.tailSince < 4 || this.helpCooldown > 0) return;
    let best: Ship | null = null;
    for (const s of ctx.world.ships) {
      if (!s.alive || s.isPlayer || s.team !== p.team || s.kinematic || !(s.brain instanceof DogfightBrain)) continue;
      // Wingmen on a scripted errand (e.g. Biggs in trouble) keep it.
      if (s.brain.opts.forcedTarget) continue;
      if (!s.nameKey || !(s.nameKey in HELPER_SPEAKER)) continue;
      if (!best || s.pos.distanceToSquared(p.pos) < best.pos.distanceToSquared(p.pos)) best = s;
    }
    if (!best?.nameKey) return;
    const speaker = HELPER_SPEAKER[best.nameKey];
    if (!speaker) return;
    // Bring a distant wingman in behind the attacker (out of the player's forward view).
    if (best.pos.distanceTo(p.pos) > 1500) {
      best.pos.copy(tail.pos).addScaledVector(tail.forward(), -450).add(new THREE.Vector3(0, 30, 0));
      best.quat.copy(tail.quat);
      best.vel.copy(tail.vel);
    }
    const brain = new DogfightBrain({ skill: 1, minAltitude: ctx.world.surface ? 60 : 0, forcedTarget: () => tail });
    this.helper = { ship: best, chaser: tail, brain, prevBrain: best.brain, prevScale: best.damageScale, until: ctx.world.time + 12, speaker };
    best.brain = brain;
    best.damageScale = 1;
    this.helpCooldown = 22;
    this.comms.say(speaker, 'help.onHim');
  }

  private updateFeedback(dt: number): void {
    const f = this.feedback;
    f.hit = Math.max(0, f.hit - dt);
    f.kill = Math.max(0, f.kill - dt);
    for (const d of f.damage) d.life -= dt;
    f.damage = f.damage.filter((d) => d.life > 0);
    for (const tst of f.toasts) tst.life -= dt;
    f.toasts = f.toasts.filter((tst) => tst.life > 0).slice(-5);
    f.score = this.ctx?.stats.score ?? 0;
  }

  private step(ctx: Ctx, dt: number): void {
    ctx.stats.time += dt;
    // Gamepad Start (keyboard P/Esc is handled by the keydown listener).
    if (this.input.consume('pause')) {
      this.pause();
      return;
    }
    const p = ctx.player;
    let aim: THREE.Vector3 | null = null;
    if (this.level.kind === 'cinematic') {
      // Cinematics: hold Enter/Space to skip.
      const inp = this.input.read(dt);
      this.skipT = inp.skipHeld ? this.skipT + dt : Math.max(0, this.skipT - dt * 2);
      if (this.skipT >= SKIP_HOLD) ctx.complete();
    } else if (p?.alive) aim = this.controlPlayer(ctx, p, dt);
    else this.input.read(dt);
    ctx.scripts.update(dt);
    ctx.onUpdate?.(dt);
    ctx.world.update(dt);
    this.comms.update(dt);
    this.updateFeedback(dt);

    if (p && this.level.kind !== 'cinematic') {
      if (p.alive) {
        const regen = HULL_REGEN[this.levelDifficulty];
        if (regen && p.sinceHit >= regen.delay && p.hull < p.spec.hull) {
          // Difficulty-based self-repair (Cadet: always; Pilot: after a few seconds out of fire).
          p.hull = Math.min(p.spec.hull, p.hull + regen.rate * dt);
        } else if (ctx.r2Alive && p.sinceHit > 4 && p.hull < p.spec.hull * 0.8) {
          // R2-D2 patches the hull between hits.
          p.hull += 1.4 * dt;
          this.repairChirp -= dt;
          if (this.repairChirp <= 0) {
            this.audio.r2('happy');
            this.repairChirp = 9;
          }
        }
        this.audio.setEngine(clamp(p.speed / p.spec.maxSpeed, 0, 1), p.maneuvering || p.throttle > 0.97);
        const tail = this.findTail(p, ctx.world);
        this.enemyOnTail = !!tail;
        if (ctx.playerControl) this.updateWingmanAssist(ctx, p, tail, dt);
        const low = p.hull / p.spec.hull < 0.25;
        this.audio.alarm(low || this.enemyOnTail);
      } else {
        this.deadTime += dt;
        this.audio.stopEngine();
        this.audio.alarm(false);
        this.audio.lockTone(false);
        if (this.deadTime > 2.8) ctx.fail('fail.destroyed');
      }
    }
    // Decays.
    ctx.shake = Math.max(0, ctx.shake - dt * 1.2);
    ctx.flash = Math.max(0, ctx.flash - dt * 1.5);
    this.engine.damage = Math.max(0, this.engine.damage - dt * 1.6);
    if (ctx.bannerState) {
      const b = ctx.bannerState;
      b.life -= dt;
      b.alpha = Math.min(1, b.alpha + dt * 3, b.life);
      if (b.life <= 0) ctx.bannerState = null;
    }
    this.updateCamera(ctx, dt);
    const cam = this.engine.camera;
    this.audio.setListener(cam.position, cam.getWorldDirection(_v), _w.set(0, 1, 0).applyQuaternion(cam.quaternion));
    this.engine.flash = ctx.flash;
    ctx.world.fx.setViewport(window.innerHeight * Math.min(window.devicePixelRatio, 2), cam.fov);

    const tg = this.target?.alive ? this.target : null;
    const showHud = ctx.showHud && !this.hudHidden;
    this.hud.draw(
      {
        world: ctx.world,
        player: p,
        camera: cam,
        target: tg,
        targetInfo: tg && p ? this.targetInfo(tg, p) : null,
        objectives: ctx.objectives,
        markers: ctx.markers,
        timer: ctx.timer,
        comms: this.comms,
        hint: ctx.hint ? t(ctx.hint, ctx.hintParams) : !this.input.locked && ctx.showHud && ctx.playerControl ? t('hint.click') : null,
        banner: ctx.bannerState,
        stick: this.stick,
        computer: ctx.computer,
        computerOff: ctx.computerOff,
        cockpit: this.cockpit && !this.lookBack,
        torpedoes: ctx.torpedoes,
        lockProgress: this.lockT / this.lockTime,
        laserLock: this.laserLock ? 1 : this.laserAcqFor && this.laserAcqFor === this.target ? Math.min(0.99, this.laserAcq / Math.max(AIM_ASSIST[this.levelDifficulty].laserLock?.delay ?? 1, 0.01)) : 0,
        aimPoint: this.lookBack ? null : aim,
        showHud,
        enemyOnTail: this.enemyOnTail,
        aimAssist: this.assisted,
        feedback: this.feedback,
        prompts: showHud && ctx.playerControl ? t('hud.prompts') : null,
        skip: this.level.kind === 'cinematic' ? this.skipT / SKIP_HOLD : null,
        rearView: this.lookBack,
        autoLevel: !!p?.autoLevel,
      },
      dt,
    );

    if (ctx.outcome) this.finishLevel(ctx);
  }

  private frame(now: number): void {
    requestAnimationFrame((ts) => this.frame(ts));
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.audio.update(dt);
    if (this.state === 'menu') {
      (this.engine.scene.userData.update as ((dt: number) => void) | undefined)?.(dt);
    } else if (this.state === 'playing' && this.ctx) {
      this.step(this.ctx, dt);
    }
    this.engine.render(now / 1000);
  }
}
