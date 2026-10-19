// Top-level orchestration: menus ↔ levels, player control, camera, HUD, audio, the frame loop.
import * as THREE from 'three';
import { AudioSystem, type MusicMood } from '../audio/audio';
import { Engine } from '../core/engine';
import { Input } from '../core/input';
import { clamp, damp } from '../core/rng';
import { DIFFICULTY_SCALE, loadSettings, saveSettings, type Settings } from '../core/settings';
import { t, type StringKey } from '../i18n/i18n';
import type { LevelContext, LevelDef, LevelStats } from '../levels/context';
import { Hud } from '../ui/hud';
import { Menus } from '../ui/menus';
import { Comms } from './comms';
import { ScriptRunner, type Script } from './script';
import type { Ship } from './ship';
import type { Targetable } from './types';
import { World } from './world';
import type { Objective } from '../ui/hud';
import type { XWingModel } from '../models/ships';
import { buildEnvironment } from '../levels/environment';

type State = 'menu' | 'card' | 'playing' | 'paused' | 'result';

const TORPEDOES = 6; // T-65: two launchers, three proton torpedoes each
const LOCK_TIME = 1.1;
const CONVERGENCE = 450;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

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
  stats: LevelStats = { kills: 0, towers: 0, shots: 0, hits: 0, time: 0, forceUsed: false };
  scripts = new ScriptRunner();
  outcome: { kind: 'complete' } | { kind: 'fail'; reason: StringKey } | null = null;
  bannerState: { title: string; sub: string; alpha: number; life: number } | null = null;

  constructor(
    readonly scene: THREE.Scene,
    readonly world: World,
    readonly audio: AudioSystem,
    readonly comms: Comms,
    readonly input: Input,
    readonly camera: THREE.PerspectiveCamera,
    readonly difficulty: number,
    readonly checkpoint: number,
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
    if (!wasDone && o.done) this.audio.ui('objective');
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
  pendingConfirm = false;
  confirmPressed = false;
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
  private levelIndex = 0;
  private checkpoint = 0;
  private campaign: LevelStats = { kills: 0, towers: 0, shots: 0, hits: 0, time: 0, forceUsed: false };
  private last = performance.now();
  private elapsed = 0;
  private menuScene: THREE.Scene | null = null;
  // Player-side state
  private target: Targetable | null = null;
  private lockT = 0;
  private cockpit = false;
  private camQuat = new THREE.Quaternion();
  private camPos = new THREE.Vector3();
  private deadTime = 0;
  private repairChirp = 0;
  private stick = { x: 0, y: 0 };
  private enemyOnTail = false;

  constructor(container: HTMLElement, private levels: LevelDef[]) {
    this.engine = new Engine(container);
    this.input = new Input(this.engine.canvas);
    this.hud = new Hud(container);
    this.comms = new Comms(this.audio);
    this.menus = new Menus(container, levels, this.settings, {
      startCampaign: () => this.unlockAudio(() => this.menus.showCrawl(() => this.openLevel(0, 0))),
      startLevel: (i, cp) => this.unlockAudio(() => this.openLevel(i, cp ?? 0)),
      settingsChanged: (s) => this.applySettings(s),
      resume: () => this.resume(),
      restart: (cp) => this.openLevel(this.levelIndex, cp ?? this.checkpoint),
      quit: () => this.toMenu(),
      next: () => this.openLevel(this.levelIndex + 1, 0),
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
      if (this.state === 'paused' && (e.code === 'Escape' || e.code === 'KeyP')) {
        // Browsers need a gesture to re-lock; Esc closes the menu and the next click re-locks.
        e.preventDefault();
      }
    });
    this.buildMenuBackdrop();
    this.menus.showTitle();
    requestAnimationFrame((t) => this.frame(t));
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

  /** Slowly orbiting Death Star + Yavin behind the title menu. */
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
    this.menuScene = scene;
    this.engine.setScene(scene);
  }

  private toMenu(): void {
    this.input.releaseLock();
    this.teardownLevel();
    this.state = 'menu';
    this.audio.stopEngine();
    this.audio.alarm(false);
    this.audio.setMusic('menu');
    this.engine.fade = 0;
    if (this.menuScene) this.engine.setScene(this.menuScene);
    this.hud.clear();
    this.menus.showTitle();
  }

  private teardownLevel(): void {
    this.ctx?.scripts.clear();
    this.ctx = null;
    this.comms.clear();
    this.target = null;
  }

  private openLevel(index: number, checkpoint: number): void {
    if (index >= this.levels.length) {
      this.toMenu();
      return;
    }
    if (index === 0) this.campaign = { kills: 0, towers: 0, shots: 0, hits: 0, time: 0, forceUsed: false };
    this.levelIndex = index;
    this.checkpoint = checkpoint;
    this.input.releaseLock();
    this.teardownLevel();
    const level = this.levels[index];
    this.state = 'card';
    this.audio.stopEngine();
    this.audio.alarm(false);
    this.menus.showLoading();
    // Build behind the card so the first frame is ready.
    setTimeout(() => {
      const scene = new THREE.Scene();
      const world = new World(scene, this.audio);
      const diff = DIFFICULTY_SCALE[this.settings.difficulty];
      world.difficulty = diff;
      const ctx = new Ctx(scene, world, this.audio, this.comms, this.input, this.engine.camera, diff, checkpoint);
      this.ctx = ctx;
      this.wireWorldEvents(ctx);
      level.setup(ctx);
      this.engine.setScene(scene);
      this.cockpit = false;
      this.deadTime = 0;
      this.lockT = 0;
      if (ctx.player) {
        this.camQuat.copy(ctx.player.quat);
        this.camPos.copy(ctx.player.pos);
      }
      // Render one frame (compiles shaders) under the card.
      this.updateCamera(ctx, 0.016);
      this.engine.render(0);
      this.menus.showCard(level, index, () => this.beginPlay());
    }, 30);
  }

  private wireWorldEvents(ctx: Ctx): void {
    ctx.world.events = {
      onDestroyed: (target, killer) => {
        if (killer && killer === ctx.player) {
          if ('kind' in target && (target as Ship).spec) ctx.stats.kills++;
        }
        if (target === this.target) this.target = null;
      },
      onTargetHit: (target, attacker) => {
        if (attacker && attacker === ctx.player && target.team === 'empire') ctx.stats.hits++;
      },
      onPlayerHit: () => {
        ctx.shake = Math.max(ctx.shake, 0.35);
        this.engine.damage = Math.min(1, this.engine.damage + 0.35);
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
    this.audio.suspend();
    this.menus.showPause();
  }

  private resume(): void {
    this.menus.hide();
    this.state = 'playing';
    this.audio.resume();
    this.input.clearPresses();
    if (this.ctx?.showHud) this.input.requestLock();
    this.last = performance.now();
  }

  private finishLevel(ctx: Ctx): void {
    const o = ctx.outcome!;
    this.input.releaseLock();
    this.audio.stopEngine();
    this.audio.alarm(false);
    this.state = 'result';
    const level = this.levels[this.levelIndex];
    if (o.kind === 'complete') {
      for (const k of ['kills', 'towers', 'shots', 'hits', 'time'] as const) this.campaign[k] += ctx.stats[k];
      this.campaign.forceUsed ||= ctx.stats.forceUsed;
      const next = this.levelIndex + 1;
      if (!this.settings.completed.includes(level.id)) {
        this.settings.completed.push(level.id);
        saveSettings(this.settings);
      }
      if (next >= this.levels.length) {
        this.audio.setMusic('victory');
        this.menus.showEnding(this.campaign);
        return;
      }
      // Briefing / cinematic levels flow straight on.
      if (!ctx.showHud) {
        this.openLevel(next, 0);
        return;
      }
      this.audio.ui('objective');
      const hull = ctx.player ? (ctx.player.hull / ctx.player.spec.hull) * 100 : 0;
      this.menus.showResult(level, ctx.stats, hull, true);
    } else {
      this.audio.ui('fail');
      this.audio.setMusic('defeat');
      this.menus.showFail(o.reason, level.checkpoints, this.checkpoint);
    }
  }

  // ---------------------------------------------------------------- player

  private pickTarget(p: Ship, world: World, cycle: boolean): void {
    const fwd = p.forward(_v);
    const cands = world.targetables
      .filter((t) => t.team === 'empire' && t.alive)
      .map((t) => {
        _w.copy(t.pos).sub(p.pos);
        const d = _w.length();
        const cos = _w.dot(fwd) / Math.max(d, 1);
        return { t, score: (1.2 - cos) * 3000 + d * 0.5, cos, d };
      })
      .filter((c) => c.d < 5000)
      .sort((a, b) => a.score - b.score);
    if (!cands.length) {
      this.target = null;
      return;
    }
    if (cycle && this.target) {
      const i = cands.findIndex((c) => c.t === this.target);
      this.target = cands[(i + 1) % cands.length].t;
    } else this.target = cands[0].t;
  }

  private controlPlayer(ctx: Ctx, p: Ship, dt: number): THREE.Vector3 | null {
    const inp = this.input.read(dt);
    this.stick = inp.stick;
    if (this.input.consume('camera')) this.cockpit = !this.cockpit;
    if (this.input.consume('confirm') && ctx.pendingConfirm) ctx.confirmPressed = true;
    if (!ctx.playerControl || p.brain) {
      this.input.clearPresses();
      return null;
    }
    p.ctrl.pitch = inp.pitch;
    p.ctrl.yaw = inp.yaw;
    p.ctrl.roll = inp.roll;
    p.throttle = clamp(p.throttle + inp.throttleDelta * 0.55 * dt, 0, 1);
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
    const cycle = this.input.consume('target');
    if (cycle || !this.target?.alive) this.pickTarget(p, ctx.world, cycle);

    // Aim: cannons converge ahead; gentle assist pulls onto the lead point when close to it.
    const fwd = p.forward(_v);
    const aim = p.pos.clone().addScaledVector(fwd, CONVERGENCE);
    const tg = this.target;
    let locked = false;
    if (tg?.alive) {
      const d = tg.pos.distanceTo(p.pos);
      const lead = tg.pos.clone().addScaledVector(tg.vel, d / p.spec.boltSpeed);
      _w.copy(lead).sub(p.pos).normalize();
      const cos = _w.dot(fwd);
      if (cos > 0.9975 && d < 1200) aim.copy(lead);
      _w.copy(tg.pos).sub(p.pos).normalize();
      if (_w.dot(fwd) > 0.992 && d < 1800 && ctx.torpedoes > 0) this.lockT = Math.min(LOCK_TIME, this.lockT + dt);
      else this.lockT = Math.max(0, this.lockT - dt * 2);
      locked = this.lockT >= LOCK_TIME;
    } else this.lockT = 0;
    this.audio.lockTone(locked);

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
    if (this.cockpit && p.alive && model.cockpitAnchor) {
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

  private checkTail(p: Ship, world: World): boolean {
    const fwd = p.forward(_v);
    for (const s of world.ships) {
      if (!s.alive || s.team === p.team) continue;
      _w.copy(s.pos).sub(p.pos);
      const d = _w.length();
      if (d > 700 || d < 1) continue;
      if (_w.dot(fwd) / d > -0.6) continue;
      if (s.forward(new THREE.Vector3()).dot(_w.normalize().negate()) > 0.9) return true;
    }
    return false;
  }

  private step(ctx: Ctx, dt: number): void {
    ctx.stats.time += dt;
    const p = ctx.player;
    let aim: THREE.Vector3 | null = null;
    if (p?.alive) aim = this.controlPlayer(ctx, p, dt);
    else this.input.read(dt);
    ctx.scripts.update(dt);
    ctx.onUpdate?.(dt);
    ctx.world.update(dt);
    this.comms.update(dt);

    if (p) {
      if (p.alive) {
        // R2-D2 patches the hull between hits.
        if (ctx.r2Alive && p.sinceHit > 4 && p.hull < p.spec.hull * 0.8) {
          p.hull += 1.4 * dt;
          this.repairChirp -= dt;
          if (this.repairChirp <= 0) {
            this.audio.r2('happy');
            this.repairChirp = 9;
          }
        }
        this.audio.setEngine(clamp(p.speed / p.spec.maxSpeed, 0, 1), p.throttle > 0.97);
        this.enemyOnTail = this.checkTail(p, ctx.world);
        const low = p.hull / p.spec.hull < 0.25;
        this.audio.alarm(low || this.enemyOnTail);
      } else {
        this.deadTime += dt;
        this.audio.stopEngine();
        this.audio.alarm(false);
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

    this.hud.draw(
      {
        world: ctx.world,
        player: p,
        camera: cam,
        target: this.target,
        objectives: ctx.objectives,
        markers: ctx.markers,
        timer: ctx.timer,
        comms: this.comms,
        hint: ctx.hint ? t(ctx.hint, ctx.hintParams) : !this.input.locked && ctx.showHud && ctx.playerControl ? t('hint.click') : null,
        banner: ctx.bannerState,
        stick: this.stick,
        computer: ctx.computer,
        computerOff: ctx.computerOff,
        cockpit: this.cockpit,
        torpedoes: ctx.torpedoes,
        lockProgress: this.lockT / LOCK_TIME,
        aimPoint: aim,
        showHud: ctx.showHud,
        enemyOnTail: this.enemyOnTail,
      },
      dt,
    );

    if (ctx.outcome) this.finishLevel(ctx);
  }

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
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
