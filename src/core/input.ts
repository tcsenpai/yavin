// Keyboard + mouse (pointer-lock virtual stick) + gamepad, merged into one flight-control frame.
import { clamp } from './rng';

export interface FlightInput {
  pitch: number; // -1..1 (+ = nose up)
  yaw: number; // -1..1 (+ = nose right)
  roll: number; // -1..1 (+ = roll right)
  throttleDelta: number; // -1..1 per second
  fire: boolean;
  torpedo: boolean; // edge-triggered
  /** Held: rear view (B). */
  lookBack: boolean;
  /** Held: skip a cinematic (Enter / Space / gamepad A). */
  skipHeld: boolean;
  /** Held: engine boost (Shift / gamepad d-pad up). */
  boost: boolean;
  stick: { x: number; y: number }; // virtual mouse stick, for the HUD cursor
}

export type Action =
  | 'sfoils'
  | 'targetComputer'
  | 'camera'
  | 'target'
  | 'deflectors'
  | 'pause'
  | 'confirm'
  | 'torpedo'
  | 'level'
  | 'targetAttacker'
  | 'hud'
  | 'throttle1'
  | 'throttle2'
  | 'throttle3'
  | 'throttle4'
  | 'skipStep'
  | 'evadeLeft'
  | 'evadeRight';

const ACTION_KEYS: Record<Action, string[]> = {
  sfoils: ['KeyX'],
  targetComputer: ['KeyT'],
  camera: ['KeyC'],
  target: ['KeyR'],
  deflectors: ['KeyV'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'NumpadEnter'],
  torpedo: ['KeyF'],
  level: ['KeyZ'],
  targetAttacker: ['KeyG'],
  hud: ['KeyH'],
  throttle1: ['Digit1'],
  throttle2: ['Digit2'],
  throttle3: ['Digit3'],
  throttle4: ['Digit4'],
  skipStep: ['KeyN'],
  // Triggered by double-tapping the roll keys (see keydown handler), not by a single key.
  evadeLeft: [],
  evadeRight: [],
};

const GAMEPAD_ACTIONS: Partial<Record<Action, number>> = {
  sfoils: 3, // Y
  targetComputer: 2, // X
  camera: 8, // back/view
  target: 5, // RB
  deflectors: 4, // LB
  pause: 9, // start
  confirm: 0, // A
  torpedo: 1, // B
  level: 10, // left stick click
  targetAttacker: 11, // right stick click
  evadeLeft: 14, // d-pad left
  evadeRight: 15, // d-pad right
};

export class Input {
  sensitivity = 1;
  invertY = false;
  private keys = new Set<string>();
  private pressed = new Set<Action>();
  private stickX = 0;
  private stickY = 0;
  private mouseFire = false;
  private triggerLatch = false;
  private padPrev: boolean[] = [];
  private lastMouseMove = 0;
  private kb = { pitch: 0, yaw: 0, roll: 0 };
  /** Last key-down time per roll key, for double-tap evasive rolls. */
  private lastTap: Record<string, number> = {};

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      for (const [action, codes] of Object.entries(ACTION_KEYS) as [Action, string[]][]) {
        if (codes.includes(e.code)) this.pressed.add(action);
      }
      // Double-tap a roll key (within 300 ms) for an evasive barrel roll.
      const evade = { KeyA: 'evadeLeft', KeyQ: 'evadeLeft', KeyD: 'evadeRight', KeyE: 'evadeRight' }[e.code] as Action | undefined;
      if (evade) {
        const now = performance.now();
        if (now - (this.lastTap[e.code] ?? -1e9) < 300) this.pressed.add(evade);
        this.lastTap[e.code] = now;
      }
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFire = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const s = 0.0016 * this.sensitivity;
      this.stickX = clamp(this.stickX + e.movementX * s, -1, 1);
      this.stickY = clamp(this.stickY + e.movementY * s, -1, 1);
      const len = Math.hypot(this.stickX, this.stickY);
      if (len > 1) {
        this.stickX /= len;
        this.stickY /= len;
      }
      this.lastMouseMove = performance.now();
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.pressed.add('torpedo');
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestLock(): void {
    if (!this.locked) this.canvas.requestPointerLock()?.catch?.(() => undefined);
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  centerStick(): void {
    this.stickX = 0;
    this.stickY = 0;
  }

  /** Edge-triggered action query; consumes the press. */
  consume(action: Action): boolean {
    const had = this.pressed.has(action);
    this.pressed.delete(action);
    return had;
  }

  clearPresses(): void {
    this.pressed.clear();
  }

  private key(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  read(dt: number): FlightInput {
    // Slow re-centring of the virtual stick when the mouse is idle keeps control forgiving.
    if (performance.now() - this.lastMouseMove > 450) {
      const k = Math.exp(-0.7 * dt);
      this.stickX *= k;
      this.stickY *= k;
    }
    // Deadzone + expo curve: fine control near centre, full rate only at the rim.
    const shape = (v: number) => {
      const a = Math.abs(v) < 0.05 ? 0 : (Math.abs(v) - 0.05) / 0.95;
      return Math.sign(v) * (0.3 * a + 0.7 * a * a);
    };
    let pitch = -shape(this.stickY) * (this.invertY ? -1 : 1);
    let yaw = shape(this.stickX);
    // Keyboard axes ramp in/out instead of snapping to ±1.
    const ramp = (cur: number, target: number) => cur + clamp(target - cur, -dt * 3.5, dt * 3.5);
    const kp = (this.key('ArrowDown') ? 1 : 0) - (this.key('ArrowUp') ? 1 : 0);
    this.kb.pitch = ramp(this.kb.pitch, kp * (this.invertY ? -1 : 1));
    this.kb.yaw = ramp(this.kb.yaw, (this.key('ArrowRight') ? 1 : 0) - (this.key('ArrowLeft') ? 1 : 0));
    this.kb.roll = ramp(this.kb.roll, (this.key('KeyD', 'KeyE') ? 1 : 0) - (this.key('KeyA', 'KeyQ') ? 1 : 0));
    pitch += this.kb.pitch;
    yaw += this.kb.yaw;
    let roll = this.kb.roll;
    let throttle = 0;
    if (this.key('KeyW')) throttle += 1;
    if (this.key('KeyS', 'ControlLeft')) throttle -= 1;
    let fire = this.mouseFire || this.key('Space');
    // Torpedo is edge-triggered from key/mouse events so even sub-frame taps register.
    let torpedo = this.pressed.delete('torpedo');

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const ax = (i: number) => {
        const v = pad.axes[i] ?? 0;
        return Math.abs(v) < 0.12 ? 0 : v;
      };
      pitch += -ax(1) * (this.invertY ? -1 : 1);
      yaw += ax(0);
      roll += ax(2);
      throttle += -ax(3);
      fire ||= (pad.buttons[7]?.value ?? 0) > 0.4;
      const trigger = (pad.buttons[6]?.value ?? 0) > 0.4;
      torpedo ||= trigger && !this.triggerLatch;
      this.triggerLatch = trigger;
      for (const [action, idx] of Object.entries(GAMEPAD_ACTIONS) as [Action, number][]) {
        const down = !!pad.buttons[idx]?.pressed;
        if (down && !this.padPrev[idx]) this.pressed.add(action);
        this.padPrev[idx] = down;
      }
    }
    return {
      pitch: clamp(pitch, -1, 1),
      yaw: clamp(yaw, -1, 1),
      roll: clamp(roll, -1, 1),
      throttleDelta: clamp(throttle, -1, 1),
      fire,
      torpedo,
      lookBack: this.key('KeyB') || !!pad?.buttons[13]?.pressed,
      skipHeld: this.key('Enter', 'Space', 'NumpadEnter') || !!pad?.buttons[0]?.pressed,
      boost: this.key('ShiftLeft', 'ShiftRight') || !!pad?.buttons[12]?.pressed,
      stick: { x: this.stickX, y: this.stickY },
    };
  }
}
