// 2D canvas HUD: reticle, target brackets, scanner, ship status, objectives, comms, targeting computer.
import * as THREE from 'three';
import { clamp } from '../core/rng';
import { t, type StringKey } from '../i18n/i18n';
import { SPEAKER_COLOR, SPEAKER_NAME, type Comms } from '../game/comms';
import type { Ship } from '../game/ship';
import type { Targetable } from '../game/types';
import type { World } from '../game/world';

export interface Objective {
  key: StringKey;
  params?: Record<string, string | number>;
  done: boolean;
  failed?: boolean;
}

export interface TargetingComputer {
  /** Distance to the exhaust port in metres. */
  range: number;
  /** Player lateral/vertical offset from the trench centreline (-1..1). */
  offX: number;
  offY: number;
  inWindow: boolean;
  scroll: number;
}

export interface HudState {
  world: World;
  player: Ship | null;
  camera: THREE.PerspectiveCamera;
  target: Targetable | null;
  objectives: Objective[];
  /** Highlighted points (objective markers). */
  markers: { pos: THREE.Vector3; key: StringKey }[];
  timer: { key: StringKey; seconds: number } | null;
  comms: Comms;
  hint: string | null;
  banner: { title: string; sub: string; alpha: number } | null;
  stick: { x: number; y: number };
  computer: TargetingComputer | null;
  computerOff: boolean;
  cockpit: boolean;
  torpedoes: number;
  lockProgress: number; // 0..1 torpedo lock
  aimPoint: THREE.Vector3 | null;
  showHud: boolean;
  enemyOnTail: boolean;
  /** Aim assist currently bending the bolts onto a target. */
  aimAssist: boolean;
  targetInfo: { name: string; hull: number; shielded: boolean; distance: number } | null;
  feedback: Feedback;
  /** One-line key reminder (bottom centre). */
  prompts: string | null;
  /** Cinematic hold-to-skip progress 0..1, or null when not skippable. */
  skip: number | null;
  rearView: boolean;
  autoLevel: boolean;
}

/** Combat feedback, modelled on modern space-combat HUDs (hit/kill markers, damage arcs, kill feed). */
export interface Feedback {
  hit: number; // seconds left on the hit marker
  kill: number; // seconds left on the kill marker
  damage: { angle: number; life: number }[]; // screen-space angle (0 = up) of incoming fire
  toasts: { text: string; color: string; life: number }[];
  score: number;
}

const AMBER = '#ffb347';
const RED = '#ff4a3a';
const GREEN = '#7dff7a';
const CYAN = '#8fd3ff';
const FONT = '"Eurostile", "Bank Gothic", "Orbitron", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const _p = new THREE.Vector3();
const _inv = new THREE.Quaternion();

export class Hud {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private time = 0;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
  }

  /** Project a world point to screen; z > 1 means behind the camera. */
  private project(cam: THREE.Camera, p: THREE.Vector3): { x: number; y: number; behind: boolean } {
    _p.copy(p).project(cam);
    const behind = _p.z > 1;
    return { x: (_p.x * 0.5 + 0.5) * this.w, y: (-_p.y * 0.5 + 0.5) * this.h, behind };
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(s: HudState, dt: number): void {
    this.time += dt;
    const c = this.ctx;
    this.clear();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.lineJoin = 'round';
    if (s.cockpit && s.player?.alive) this.drawCockpit();
    if (s.showHud && s.player?.alive) {
      this.drawMarkers(s);
      this.drawReticle(s);
      this.drawFeedback(s.feedback);
      this.drawStatus(s);
      this.drawScanner(s);
      if (s.targetInfo) this.drawTargetPanel(s.targetInfo);
      if (s.computer) this.drawComputer(s.computer);
      if (s.computerOff) this.drawForce();
      if (s.rearView) this.text(t('hud.rearView'), this.w / 2, 96, 16, AMBER, 'center', FONT, '700');
      if (s.autoLevel) this.text(t('hud.autoLevel'), this.w / 2, this.h / 2 + 80, 13, CYAN, 'center');
    }
    if (s.showHud) {
      this.drawObjectives(s);
      this.drawTimer(s);
      this.drawScoreAndFeed(s.feedback);
      if (s.prompts) this.text(s.prompts, this.w / 2, this.h - 10, 11, 'rgba(242,230,201,0.55)', 'center', MONO, '500');
    }
    this.drawComms(s.comms, !!s.computer && s.showHud);
    if (s.hint) this.drawHint(s.hint);
    if (s.banner && s.banner.alpha > 0) this.drawBanner(s.banner);
    if (s.skip !== null) this.drawSkip(s.skip);
  }

  /** Hit marker (white X), kill marker (red, bigger), directional damage arcs around the reticle. */
  private drawFeedback(f: Feedback): void {
    const c = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const xMark = (r0: number, r1: number, color: string, width: number) => {
      c.strokeStyle = color;
      c.lineWidth = width;
      c.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      }
      c.stroke();
    };
    if (f.kill > 0) xMark(14, 30, `rgba(255,74,58,${Math.min(1, f.kill * 3)})`, 3);
    else if (f.hit > 0) xMark(10, 20, `rgba(255,255,255,${Math.min(1, f.hit * 8)})`, 2);
    for (const d of f.damage) {
      const a = d.angle - Math.PI / 2; // 0 = up on screen
      c.strokeStyle = `rgba(255,60,40,${Math.min(1, d.life) * 0.9})`;
      c.lineWidth = 6;
      c.beginPath();
      c.arc(cx, cy, 150, a - 0.28, a + 0.28);
      c.stroke();
    }
  }

  private drawScoreAndFeed(f: Feedback): void {
    const x = this.w - 24;
    this.text(t('hud.score'), x, 28, 11, AMBER, 'right');
    this.text(String(f.score).padStart(6, '0'), x, 52, 22, '#ffe14a', 'right', MONO, '700');
    f.toasts.forEach((tst, i) => {
      this.ctx.globalAlpha = Math.min(1, tst.life * 2);
      this.text(tst.text, x, 80 + i * 20, 13, tst.color, 'right', FONT, '600');
    });
    this.ctx.globalAlpha = 1;
  }

  private drawTargetPanel(ti: { name: string; hull: number; shielded: boolean; distance: number }): void {
    const w = 220;
    const x = this.w - w - 30;
    const y = this.h - 260;
    this.panel(x, y, w, 62);
    this.text(ti.name.toUpperCase(), x + 12, y + 20, 12, RED, 'left', FONT, '700');
    this.text(`${Math.round(ti.distance)} m`, x + w - 12, y + 20, 11, AMBER, 'right', MONO);
    this.bar(x + 12, y + 30, w - 24, 9, ti.hull, ti.shielded ? CYAN : RED);
    if (ti.shielded) this.text(t('hud.shielded'), x + 12, y + 55, 10, CYAN, 'left', FONT, '700');
  }

  private drawSkip(p: number): void {
    const c = this.ctx;
    const x = this.w - 60;
    const y = this.h - 60;
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(x, y, 18, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = '#ffe14a';
    c.beginPath();
    c.arc(x, y, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, p));
    c.stroke();
    this.text(t('hud.holdSkip'), x - 30, y + 5, 13, 'rgba(242,230,201,0.85)', 'right');
  }

  private text(str: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', font = FONT, weight = '600'): void {
    const c = this.ctx;
    c.font = `${weight} ${size}px ${font}`;
    c.textAlign = align;
    c.fillStyle = color;
    c.fillText(str, x, y);
  }

  private drawReticle(s: HudState): void {
    const c = this.ctx;
    const p = s.player!;
    // Reticle sits on the convergence point of the cannons.
    let cx = this.w / 2;
    let cy = this.h / 2;
    if (s.aimPoint) {
      const pr = this.project(s.camera, s.aimPoint);
      if (!pr.behind) {
        cx = pr.x;
        cy = pr.y;
      }
    }
    const col = !p.canFire ? 'rgba(255,179,71,0.35)' : s.aimAssist ? RED : AMBER;
    c.strokeStyle = col;
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(cx, cy, 16, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22);
      c.lineTo(cx + Math.cos(a) * 34, cy + Math.sin(a) * 34);
      c.stroke();
    }
    c.fillStyle = col;
    c.fillRect(cx - 1, cy - 1, 2, 2);
    // Squadrons-style reticle arcs: throttle on the left, deflectors on the right.
    // `bottom`/`top` are canvas angles; the bar fills from the bottom end toward the top end.
    const arc = (bottom: number, top: number, v: number, color: string) => {
      const end = bottom + (top - bottom) * clamp(v, 0, 1);
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(255,179,71,0.18)';
      c.beginPath();
      c.arc(cx, cy, 50, Math.min(bottom, top), Math.max(bottom, top));
      c.stroke();
      c.strokeStyle = color;
      c.beginPath();
      c.arc(cx, cy, 50, Math.min(bottom, end), Math.max(bottom, end));
      c.stroke();
    };
    arc(Math.PI * 0.68, Math.PI * 1.32, p.throttle, '#ffd68a');
    const sh = p.spec.shields ? (p.shieldFore + p.shieldAft) / (p.spec.shields * 2) : 0;
    arc(Math.PI * 0.32, Math.PI * -0.32, sh, sh > 0.3 ? CYAN : RED);
    // Virtual stick indicator.
    const sx = this.w / 2 + s.stick.x * 120;
    const sy = this.h / 2 + s.stick.y * 120;
    c.strokeStyle = 'rgba(143,211,255,0.25)';
    c.beginPath();
    c.arc(this.w / 2, this.h / 2, 120, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = 'rgba(143,211,255,0.8)';
    c.beginPath();
    c.moveTo(sx - 6, sy);
    c.lineTo(sx + 6, sy);
    c.moveTo(sx, sy - 6);
    c.lineTo(sx, sy + 6);
    c.stroke();
    if (!p.canFire) this.text(t('hud.sfoilsClosed'), this.w / 2, this.h / 2 + 60, 13, AMBER, 'center');
    if (s.enemyOnTail && Math.floor(this.time * 3) % 2 === 0) this.text(t('hud.enemyTail'), this.w / 2, this.h / 2 - 70, 15, RED, 'center');
  }

  private bracket(x: number, y: number, r: number, color: string, width = 1.6): void {
    const c = this.ctx;
    const k = r * 0.45;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      c.moveTo(x + sx * r, y + sy * (r - k));
      c.lineTo(x + sx * r, y + sy * r);
      c.lineTo(x + sx * (r - k), y + sy * r);
    }
    c.stroke();
  }

  private edgeArrow(x: number, y: number, behind: boolean, color: string, label?: string): void {
    const c = this.ctx;
    let dx = x - this.w / 2;
    let dy = y - this.h / 2;
    if (behind) {
      dx = -dx;
      dy = -dy;
    }
    const a = Math.atan2(dy, dx);
    const rx = this.w / 2 - 50;
    const ry = this.h / 2 - 50;
    const k = Math.min(rx / Math.abs(Math.cos(a) || 1e-6), ry / Math.abs(Math.sin(a) || 1e-6));
    const px = this.w / 2 + Math.cos(a) * k;
    const py = this.h / 2 + Math.sin(a) * k;
    c.save();
    c.translate(px, py);
    c.rotate(a);
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(14, 0);
    c.lineTo(-6, -9);
    c.lineTo(-6, 9);
    c.closePath();
    c.fill();
    c.restore();
    if (label) this.text(label, px - Math.cos(a) * 24, py - Math.sin(a) * 24 + 4, 11, color, 'center', MONO);
  }

  private drawMarkers(s: HudState): void {
    const cam = s.camera;
    const player = s.player!;
    for (const tg of s.world.targetables) {
      if (tg === player) continue;
      const d = tg.pos.distanceTo(player.pos);
      if (d > 4000) continue;
      const pr = this.project(cam, tg.pos);
      if (pr.behind || pr.x < 0 || pr.y < 0 || pr.x > this.w || pr.y > this.h) continue;
      const hostile = tg.team === 'empire';
      const r = clamp((tg.radius * 900) / Math.max(d, 1), 7, 60);
      const selected = tg === s.target;
      this.bracket(pr.x, pr.y, r, hostile ? (selected ? RED : 'rgba(255,74,58,0.55)') : 'rgba(255,200,120,0.4)', selected ? 2.2 : 1.2);
      if (selected) {
        this.text(`${Math.round(d)} m`, pr.x + r + 6, pr.y - r + 10, 11, RED, 'left', MONO);
      }
    }
    const labels: { x: number; y: number }[] = [];
    for (const m of s.markers) {
      const pr = this.project(cam, m.pos);
      const d = m.pos.distanceTo(player.pos);
      const on = !pr.behind && pr.x > 30 && pr.y > 30 && pr.x < this.w - 30 && pr.y < this.h - 30;
      if (on) {
        const c = this.ctx;
        c.strokeStyle = '#ffe14a';
        c.lineWidth = 1.6;
        c.beginPath();
        c.moveTo(pr.x, pr.y - 12);
        c.lineTo(pr.x + 12, pr.y);
        c.lineTo(pr.x, pr.y + 12);
        c.lineTo(pr.x - 12, pr.y);
        c.closePath();
        c.stroke();
        if (!labels.some((l) => Math.abs(l.x - pr.x) < 90 && Math.abs(l.y - pr.y) < 16)) {
          labels.push({ x: pr.x, y: pr.y });
          this.text(`${t(m.key)} ${(d / 1000).toFixed(1)} km`, pr.x, pr.y - 18, 11, '#ffe14a', 'center', MONO);
        }
      } else {
        this.edgeArrow(pr.x, pr.y, pr.behind, '#ffe14a');
      }
    }
    const tg = s.target;
    if (tg?.alive) {
      const pr = this.project(cam, tg.pos);
      const onScreen = !pr.behind && pr.x > 0 && pr.y > 0 && pr.x < this.w && pr.y < this.h;
      if (!onScreen) this.edgeArrow(pr.x, pr.y, pr.behind, RED, `${Math.round(tg.pos.distanceTo(player.pos))}m`);
      else {
        // Lead indicator: where to shoot to hit a target moving at constant velocity.
        const d = tg.pos.distanceTo(player.pos);
        const lead = _p.copy(tg.pos).addScaledVector(tg.vel, d / player.spec.boltSpeed);
        const lp = this.project(cam, lead);
        if (!lp.behind) {
          const c = this.ctx;
          c.strokeStyle = RED;
          c.lineWidth = 1.4;
          c.beginPath();
          c.arc(lp.x, lp.y, 6, 0, Math.PI * 2);
          c.moveTo(lp.x - 10, lp.y);
          c.lineTo(lp.x - 6, lp.y);
          c.moveTo(lp.x + 6, lp.y);
          c.lineTo(lp.x + 10, lp.y);
          c.stroke();
        }
        if (s.lockProgress > 0) {
          const c = this.ctx;
          c.strokeStyle = s.lockProgress >= 1 ? '#ffffff' : AMBER;
          c.lineWidth = 2;
          c.beginPath();
          c.arc(pr.x, pr.y, 28 - s.lockProgress * 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.lockProgress);
          c.stroke();
          if (s.lockProgress >= 1) this.text(t('hud.locked'), pr.x, pr.y + 42, 12, '#ffffff', 'center');
        }
      }
    }
  }

  private bar(x: number, y: number, w: number, h: number, v: number, color: string): void {
    const c = this.ctx;
    c.strokeStyle = 'rgba(255,179,71,0.5)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w, h);
    c.fillStyle = color;
    c.fillRect(x + 2, y + 2, Math.max(0, (w - 3) * clamp(v, 0, 1)), h - 3);
  }

  private panel(x: number, y: number, w: number, h: number): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(8,10,14,0.45)';
    c.strokeStyle = 'rgba(255,179,71,0.35)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x + 10, y);
    c.lineTo(x + w, y);
    c.lineTo(x + w, y + h - 10);
    c.lineTo(x + w - 10, y + h);
    c.lineTo(x, y + h);
    c.lineTo(x, y + 10);
    c.closePath();
    c.fill();
    c.stroke();
  }

  private drawStatus(s: HudState): void {
    const p = s.player!;
    const x = 20;
    const y = this.h - 190;
    this.panel(x, y, 250, 170);
    const c = this.ctx;
    // Top-down X-wing silhouette with deflector arcs.
    const cx = x + 62;
    const cy = y + 82;
    const fore = p.spec.shields ? p.shieldFore / (p.spec.shields * 2) : 0;
    const aft = p.spec.shields ? p.shieldAft / (p.spec.shields * 2) : 0;
    const shieldCol = (v: number) => (v > 0.33 ? CYAN : v > 0.12 ? AMBER : RED);
    c.lineWidth = 4;
    c.strokeStyle = shieldCol(fore * 2);
    c.globalAlpha = 0.25 + clamp(fore * 2, 0, 1) * 0.75;
    c.beginPath();
    c.arc(cx, cy, 46, Math.PI * 1.1, Math.PI * 1.9);
    c.stroke();
    c.strokeStyle = shieldCol(aft * 2);
    c.globalAlpha = 0.25 + clamp(aft * 2, 0, 1) * 0.75;
    c.beginPath();
    c.arc(cx, cy, 46, Math.PI * 0.1, Math.PI * 0.9);
    c.stroke();
    c.globalAlpha = 1;
    const hullFrac = clamp(p.hull / p.spec.hull, 0, 1);
    c.strokeStyle = hullFrac > 0.5 ? AMBER : hullFrac > 0.25 ? '#ff8a3a' : RED;
    c.lineWidth = 1.6;
    c.beginPath();
    // fuselage
    c.moveTo(cx, cy - 34);
    c.lineTo(cx + 4, cy - 6);
    c.lineTo(cx + 4, cy + 22);
    c.lineTo(cx - 4, cy + 22);
    c.lineTo(cx - 4, cy - 6);
    c.closePath();
    // wings (S-foil spread shown as gap)
    const spread = 2 + p.sfoils * 5;
    for (const sd of [-1, 1]) {
      c.moveTo(cx + sd * 4, cy + 6);
      c.lineTo(cx + sd * 30, cy + 6 + spread * 0.3);
      c.lineTo(cx + sd * 30, cy + 18);
      c.lineTo(cx + sd * 4, cy + 18);
      c.moveTo(cx + sd * 30, cy - 10);
      c.lineTo(cx + sd * 30, cy + 18);
    }
    c.stroke();

    const tx = x + 128;
    this.text(t('hud.hull'), tx, y + 24, 11, AMBER);
    this.bar(tx, y + 30, 108, 9, hullFrac, hullFrac > 0.25 ? AMBER : RED);
    this.text(t('hud.speed'), tx, y + 58, 11, AMBER);
    this.bar(tx, y + 64, 108, 9, p.throttle, '#ffd68a');
    this.text(`${Math.round(p.speed * 3.6)} km/h`, tx + 108, y + 58, 11, AMBER, 'right', MONO);
    this.text(`${t('hud.torpedoes')}: ${s.torpedoes}`, tx, y + 92, 12, AMBER);
    this.text(`${t('hud.sfoils')}: ${t(p.sfoils > 0.97 ? 'hud.sfoils.open' : p.sfoils < 0.03 ? 'hud.sfoils.closed' : 'hud.sfoils.moving')}`, tx, y + 110, 12, p.sfoils > 0.97 ? AMBER : CYAN);
    this.text(`${t('hud.deflectors')}: ${t(`hud.defl.${p.deflectors}` as StringKey)}`, tx, y + 128, 12, CYAN);
    if (s.computer || s.computerOff) this.text(`${t('hud.computer')}: ${t(s.computerOff ? 'hud.off' : 'hud.on')}`, tx, y + 146, 12, s.computerOff ? CYAN : AMBER);
    this.text('RED 5 · T-65', x + 14, y + 160, 10, 'rgba(255,179,71,0.6)', 'left', MONO);
  }

  private drawScanner(s: HudState): void {
    const p = s.player!;
    const c = this.ctx;
    const R = 78;
    const cx = this.w - R - 30;
    const cy = this.h - R - 30;
    c.fillStyle = 'rgba(8,12,10,0.5)';
    c.strokeStyle = 'rgba(255,179,71,0.45)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    c.moveTo(cx - R, cy);
    c.lineTo(cx + R, cy);
    c.moveTo(cx, cy - R);
    c.lineTo(cx, cy + R);
    c.strokeStyle = 'rgba(255,179,71,0.18)';
    c.stroke();
    // Sweep.
    const a = (this.time * 2) % (Math.PI * 2);
    const grd = c.createConicGradient(a, cx, cy);
    grd.addColorStop(0, 'rgba(255,179,71,0.25)');
    grd.addColorStop(0.08, 'rgba(255,179,71,0)');
    grd.addColorStop(1, 'rgba(255,179,71,0)');
    c.fillStyle = grd;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.fill();
    const range = 2500;
    _inv.copy(p.quat).invert();
    for (const tg of s.world.targetables) {
      if (tg === p) continue;
      _p.copy(tg.pos).sub(p.pos).applyQuaternion(_inv);
      const d = Math.hypot(_p.x, _p.z);
      const k = Math.min(d, range) / range;
      const ang = Math.atan2(_p.x, -_p.z);
      const bx = cx + Math.sin(ang) * k * R;
      const by = cy - Math.cos(ang) * k * R;
      c.fillStyle = tg.team === 'empire' ? (tg === s.target ? '#ffffff' : RED) : GREEN;
      const above = _p.y > 0;
      c.beginPath();
      if (above) c.rect(bx - 2.5, by - 2.5, 5, 5);
      else c.arc(bx, by, 2.5, 0, Math.PI * 2);
      c.fill();
    }
    for (const m of s.markers) {
      _p.copy(m.pos).sub(p.pos).applyQuaternion(_inv);
      const d = Math.hypot(_p.x, _p.z);
      const k = Math.min(d, range) / range;
      const ang = Math.atan2(_p.x, -_p.z);
      c.fillStyle = '#ffe14a';
      c.fillRect(cx + Math.sin(ang) * k * R - 3, cy - Math.cos(ang) * k * R - 3, 6, 6);
    }
    this.text(t('hud.scanner'), cx, cy - R - 8, 10, 'rgba(255,179,71,0.7)', 'center');
  }

  private drawObjectives(s: HudState): void {
    if (!s.objectives.length) return;
    const x = 20;
    let y = 30;
    this.text(t('hud.objectives'), x, y, 12, AMBER);
    y += 6;
    for (const o of s.objectives) {
      y += 20;
      const col = o.failed ? RED : o.done ? '#8a8a8a' : '#f2e6c9';
      const mark = o.failed ? '✕' : o.done ? '✓' : '▸';
      this.text(`${mark} ${t(o.key, o.params)}`, x, y, 13, col, 'left', FONT, '500');
    }
  }

  private drawTimer(s: HudState): void {
    if (!s.timer) return;
    const sec = Math.max(0, s.timer.seconds);
    const m = Math.floor(sec / 60);
    const ss = Math.floor(sec % 60);
    const urgent = sec < 30;
    const col = urgent && Math.floor(this.time * 2) % 2 === 0 ? RED : AMBER;
    this.text(t(s.timer.key), this.w / 2, 28, 12, col, 'center');
    this.text(`${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, this.w / 2, 56, 26, col, 'center', MONO, '700');
  }

  /** Subtitles sit at the bottom edge (clear of the ship and reticle); above the targeting computer when it is up. */
  private drawComms(comms: Comms, raised: boolean): void {
    const line = comms.current;
    if (!line) return;
    const c = this.ctx;
    const text = t(line.key, line.params);
    const name = t(SPEAKER_NAME[line.speaker]);
    const maxW = Math.max(420, Math.min(700, this.w - 600));
    c.font = `500 17px ${FONT}`;
    const lines = wrap(c, text, maxW - 40);
    const boxH = 40 + lines.length * 23;
    const x = this.w / 2 - maxW / 2;
    // With the targeting computer up, the bottom is taken: put subtitles under the countdown timer instead.
    const y = raised ? 74 : this.h - 34 - boxH;
    const fade = Math.min(1, line.elapsed * 6, (line.duration - line.elapsed) * 4 + 0.3);
    c.globalAlpha = clamp(fade, 0, 1);
    c.fillStyle = line.ghost ? 'rgba(20,40,70,0.35)' : 'rgba(6,8,12,0.62)';
    c.fillRect(x, y, maxW, boxH);
    c.fillStyle = SPEAKER_COLOR[line.speaker];
    c.fillRect(x, y, 3, boxH);
    // Radio waveform.
    c.strokeStyle = SPEAKER_COLOR[line.speaker];
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i < 40; i++) {
      const v = Math.sin(this.time * 30 + i * 1.7) * Math.sin(this.time * 7 + i * 0.4) * 6;
      c.lineTo(x + maxW - 70 + i * 1.5, y + 18 + v);
    }
    c.stroke();
    this.text(name.toUpperCase(), x + 18, y + 24, 13, SPEAKER_COLOR[line.speaker], 'left', FONT, '700');
    lines.forEach((ln, i) => this.text(ln, x + 18, y + 50 + i * 23, 17, line.ghost ? '#cfe8ff' : '#f4efe4', 'left', FONT, line.ghost ? '400' : '500'));
    c.globalAlpha = 1;
  }

  private drawHint(hint: string): void {
    const c = this.ctx;
    c.font = `600 15px ${FONT}`;
    const w = c.measureText(hint).width + 36;
    const x = this.w / 2 - w / 2;
    const y = this.h * 0.3;
    c.fillStyle = 'rgba(10,10,10,0.55)';
    c.fillRect(x, y - 22, w, 34);
    c.strokeStyle = 'rgba(255,225,74,0.6)';
    c.strokeRect(x + 0.5, y - 21.5, w, 34);
    this.text(hint, this.w / 2, y, 15, '#ffe14a', 'center');
  }

  private drawBanner(b: { title: string; sub: string; alpha: number }): void {
    const c = this.ctx;
    c.globalAlpha = clamp(b.alpha, 0, 1);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, this.h * 0.36, this.w, 130);
    this.text(b.title.toUpperCase(), this.w / 2, this.h * 0.36 + 62, 40, '#ffe14a', 'center', FONT, '800');
    this.text(b.sub, this.w / 2, this.h * 0.36 + 100, 17, '#f2e6c9', 'center', FONT, '500');
    c.globalAlpha = 1;
  }

  /** The famous trench targeting display: perspective trench wireframe and range readout. */
  private drawComputer(tc: TargetingComputer): void {
    const c = this.ctx;
    const W = Math.min(380, this.w * 0.34);
    const H = W * 0.62;
    const x = this.w / 2 - W / 2;
    const y = this.h - H - 24;
    c.save();
    c.fillStyle = 'rgba(10,6,2,0.82)';
    c.fillRect(x, y, W, H);
    c.strokeStyle = 'rgba(255,140,40,0.85)';
    c.lineWidth = 2;
    c.strokeRect(x, y, W, H);
    c.beginPath();
    c.rect(x + 2, y + 2, W - 4, H - 4);
    c.clip();
    const vx = x + W / 2 - tc.offX * W * 0.12;
    const vy = y + H * 0.42 + tc.offY * H * 0.12;
    // Trench walls converging to the vanishing point; ribs scrolling toward the viewer.
    c.strokeStyle = '#ff9a2a';
    c.lineWidth = 1.4;
    const corners = [
      [x + W * 0.04, y + H * 0.06],
      [x + W * 0.96, y + H * 0.06],
      [x + W * 0.96, y + H * 0.94],
      [x + W * 0.04, y + H * 0.94],
    ];
    c.beginPath();
    for (const [px, py] of corners) {
      c.moveTo(px, py);
      c.lineTo(vx, vy);
    }
    c.stroke();
    const ribs = 9;
    for (let i = 0; i < ribs; i++) {
      const f = ((i + (tc.scroll % 1)) / ribs) ** 2.2;
      c.beginPath();
      corners.forEach(([px, py], k) => {
        const qx = vx + (px - vx) * f;
        const qy = vy + (py - vy) * f;
        if (k === 0) c.moveTo(qx, qy);
        else c.lineTo(qx, qy);
      });
      c.closePath();
      c.globalAlpha = 0.25 + f * 0.75;
      c.stroke();
    }
    c.globalAlpha = 1;
    // Target box grows as the port approaches; turns red in the firing window.
    const near = clamp(1 - tc.range / 6000, 0, 1);
    const box = 6 + near ** 3 * W * 0.4;
    c.strokeStyle = tc.inWindow ? '#ff2a1a' : '#ffd04a';
    c.lineWidth = tc.inWindow ? 3 : 1.6;
    c.strokeRect(vx - box / 2, vy + box * 0.4, box, box * 0.6);
    c.restore();
    this.text(t('hud.tc.title'), x + 10, y + 18, 10, '#ff9a2a', 'left', MONO);
    this.text(`${Math.max(0, Math.round(tc.range)).toString().padStart(5, '0')}`, x + W - 10, y + H - 12, 22, tc.inWindow ? '#ff3a2a' : '#ffb347', 'right', MONO, '700');
    if (tc.inWindow && Math.floor(this.time * 6) % 2 === 0) this.text(t('hud.tc.fire'), x + W / 2, y + H - 14, 14, '#ff3a2a', 'center', MONO, '700');
  }

  private drawForce(): void {
    const c = this.ctx;
    const g = c.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.25, this.w / 2, this.h / 2, this.h * 0.85);
    g.addColorStop(0, 'rgba(120,180,255,0)');
    g.addColorStop(1, `rgba(120,180,255,${0.12 + Math.sin(this.time * 1.5) * 0.04})`);
    c.fillStyle = g;
    c.fillRect(0, 0, this.w, this.h);
  }

  /** Cockpit frame: canopy struts and lower console silhouette. */
  private drawCockpit(): void {
    const c = this.ctx;
    const w = this.w;
    const h = this.h;
    c.fillStyle = '#0b0c0e';
    c.beginPath();
    c.moveTo(0, h);
    c.lineTo(0, h * 0.72);
    c.lineTo(w * 0.2, h * 0.68);
    c.lineTo(w * 0.36, h * 0.8);
    c.lineTo(w * 0.64, h * 0.8);
    c.lineTo(w * 0.8, h * 0.68);
    c.lineTo(w, h * 0.72);
    c.lineTo(w, h);
    c.closePath();
    c.fill();
    c.fillStyle = '#16181c';
    c.beginPath();
    c.moveTo(w * 0.36, h * 0.8);
    c.lineTo(w * 0.64, h * 0.8);
    c.lineTo(w * 0.7, h);
    c.lineTo(w * 0.3, h);
    c.closePath();
    c.fill();
    // Canopy struts.
    c.strokeStyle = '#0d0e10';
    c.lineWidth = 26;
    c.beginPath();
    c.moveTo(w * 0.2, h * 0.68);
    c.lineTo(w * 0.32, 0);
    c.moveTo(w * 0.8, h * 0.68);
    c.lineTo(w * 0.68, 0);
    c.stroke();
    c.lineWidth = 10;
    c.beginPath();
    c.moveTo(w * 0.32, h * 0.06);
    c.lineTo(w * 0.68, h * 0.06);
    c.stroke();
    // Console lamps.
    for (let i = 0; i < 12; i++) {
      const on = (Math.floor(this.time * 2 + i * 1.7) % 5) > 1;
      c.fillStyle = on ? (i % 3 === 0 ? '#ff4a3a' : '#ffb347') : '#3a2a1a';
      c.fillRect(w * 0.38 + i * (w * 0.02), h * 0.86, 6, 4);
    }
  }
}

function wrap(c: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (c.measureText(test).width > maxW && cur) {
      out.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) out.push(cur);
  return out;
}
