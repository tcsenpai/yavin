import * as THREE from 'three';

// Fully synthesized sound system: every sound and every note of music is generated
// at runtime with WebAudio oscillators, noise buffers and filters. No audio assets.

export type MusicMood = 'none' | 'menu' | 'briefing' | 'approach' | 'combat' | 'trench' | 'victory' | 'defeat';
type Mood = Exclude<MusicMood, 'none'>;

const MAX_VOICES = 24;
const REF_DIST = 30;
const MAX_DIST = 3000;
const LOOKAHEAD = 0.25; // seconds of music scheduled ahead of AudioContext time
const CROSSFADE = 2;
const MUSIC_SEED = 0x1977a;

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Connect nodes in series; the final element may be an AudioParam (modulation target). */
function wire(...n: (AudioNode | AudioParam)[]): void {
  for (let i = 0; i < n.length - 1; i++) {
    const a = n[i];
    const b = n[i + 1];
    if (!(a instanceof AudioNode)) continue;
    if (b instanceof AudioNode) a.connect(b);
    else a.connect(b);
  }
}

/** Percussive envelope: 0 → peak over `atk`, exponential decay to silence over `decay`. */
function perc(p: AudioParam, t: number, peak: number, atk: number, decay: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + atk);
  p.exponentialRampToValueAtTime(0.0001, t + atk + decay);
}

/** Sustained envelope: attack to peak, hold until `dur`, then exponential-ish release. */
function adsr(p: AudioParam, t: number, peak: number, atk: number, dur: number, rel: number): void {
  const hold = Math.max(atk, dur);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + atk);
  p.setValueAtTime(peak, t + hold);
  p.setTargetAtTime(0, t + hold, rel / 3);
}

const curveCache = new Map<number, Float32Array<ArrayBuffer>>();
function softClip(k: number): Float32Array<ArrayBuffer> {
  let c = curveCache.get(k);
  if (!c) {
    c = new Float32Array(1024);
    const norm = Math.tanh(k);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / norm;
    }
    curveCache.set(k, c);
  }
  return c;
}

function setPannerPos(p: PannerNode, v: THREE.Vector3): void {
  if (p.positionX) {
    p.positionX.value = v.x;
    p.positionY.value = v.y;
    p.positionZ.value = v.z;
  } else {
    p.setPosition(v.x, v.y, v.z);
  }
}

// ---------------------------------------------------------------------------
// Node bags: every one-shot sound/note owns its nodes and frees them when done.
// ---------------------------------------------------------------------------

class Bag {
  private readonly nodes: AudioNode[] = [];
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private live = 0;
  private armed = false;
  private freed = false;
  onFree: (() => void) | null = null;

  constructor(readonly ctx: AudioContext) {}

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  osc(type: OscillatorType, freq: number, t: number, detune = 0): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    o.start(t);
    this.srcs.push(o);
    return o;
  }

  noise(buf: AudioBuffer, t: number, rate = 1): AudioBufferSourceNode {
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * buf.duration * 0.9);
    this.srcs.push(s);
    return s;
  }

  gain(v = 1): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, f: number, q = 0.7, t?: number): BiquadFilterNode {
    const b = this.add(this.ctx.createBiquadFilter());
    b.type = type;
    b.Q.value = q;
    if (t === undefined) b.frequency.value = f;
    else b.frequency.setValueAtTime(f, t);
    return b;
  }

  shaper(k: number): WaveShaperNode {
    const s = this.add(this.ctx.createWaveShaper());
    s.curve = softClip(k);
    return s;
  }

  /** Schedule all sources to stop at `end`; nodes are disconnected once every source ended. */
  done(end: number): void {
    this.armed = true;
    this.live = this.srcs.length;
    if (this.live === 0) {
      this.free();
      return;
    }
    for (const s of this.srcs) {
      s.onended = () => {
        if (--this.live <= 0) this.free();
      };
      s.stop(end);
    }
  }

  /** Stop early (voice stealing, persistent loops). */
  kill(at: number): void {
    if (!this.armed) {
      this.done(at);
      return;
    }
    for (const s of this.srcs) {
      try {
        s.stop(at);
      } catch {
        /* already stopped */
      }
    }
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    for (const n of this.nodes) n.disconnect();
    this.onFree?.();
  }
}

class Voice extends Bag {
  readonly out: GainNode;
  constructor(
    ctx: AudioContext,
    readonly level: number,
    readonly prio: number,
    readonly start: number,
    readonly end: number,
  ) {
    super(ctx);
    this.out = this.gain(1);
  }

  /** Lower = better candidate for stealing (quiet, low priority, nearly finished). */
  score(now: number): number {
    const span = Math.max(0.01, this.end - this.start);
    return this.level * this.prio * Math.max(0.05, (this.end - now) / span);
  }

  steal(now: number): void {
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.04);
    this.kill(now + 0.05);
  }
}

interface VoiceOpts {
  prio?: number;
  wet?: number;
  pan?: number;
  hrtf?: boolean;
}

// ---------------------------------------------------------------------------
// Orchestra: synthesized instruments for the procedural score.
// ---------------------------------------------------------------------------

class Instruments {
  constructor(
    private readonly ctx: AudioContext,
    private readonly white: AudioBuffer,
    private readonly brown: AudioBuffer,
  ) {}

  /** Brass section: two detuned saws with an opening filter envelope. */
  brass(dest: AudioNode, t: number, midi: number, dur: number, vel: number, bright: number, atk = 0.05): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sawtooth', f, t, -6);
    const o2 = b.osc('sawtooth', f, t, 7);
    const lp = b.filter('lowpass', f * 0.8, 1.4, t);
    lp.frequency.linearRampToValueAtTime(Math.min(14000, f * (1.5 + 7 * bright * vel)), t + atk * 1.4);
    lp.frequency.setTargetAtTime(Math.min(10000, f * (1.2 + 3.5 * bright * vel)), t + atk * 1.5, 0.25);
    const g = b.gain(0);
    adsr(g.gain, t, 0.085 * vel, atk, dur, 0.2);
    o1.connect(lp);
    o2.connect(lp);
    wire(lp, g, dest);
    b.done(t + Math.max(atk, dur) + 0.45);
  }

  /** String section pad: chorused saws, soft lowpass, slow attack. */
  strings(dest: AudioNode, t: number, midi: number, dur: number, vel: number, atk: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sawtooth', f, t, -9);
    const o2 = b.osc('sawtooth', f, t, 10);
    const lp = b.filter('lowpass', Math.min(6000, Math.max(500, f * 4)), 0.5, t);
    const g = b.gain(0);
    adsr(g.gain, t, 0.05 * vel, atk, dur, 0.7);
    o1.connect(lp);
    o2.connect(lp);
    wire(lp, g, dest);
    b.done(t + Math.max(atk, dur) + 0.9);
  }

  /** Short bowed/staccato low strings for ostinati. */
  low(dest: AudioNode, t: number, midi: number, dur: number, vel: number, bright: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sawtooth', f, t, -4);
    const o2 = b.osc('sawtooth', f, t, 5);
    const lp = b.filter('lowpass', Math.min(12000, f * (2 + 6 * bright)), 0.9, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, f * 1.4), t + 0.14);
    const g = b.gain(0);
    const hold = Math.max(0.03, dur * 0.8);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.1 * vel, t + 0.008);
    g.gain.setTargetAtTime(0.06 * vel, t + 0.01, 0.08);
    g.gain.setTargetAtTime(0, t + hold, 0.03);
    o1.connect(lp);
    o2.connect(lp);
    wire(lp, g, dest);
    b.done(t + hold + 0.2);
  }

  harp(dest: AudioNode, t: number, midi: number, vel: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('triangle', f, t);
    const o2 = b.osc('sine', f * 2, t);
    const g1 = b.gain(0);
    const g2 = b.gain(0);
    perc(g1.gain, t, 0.09 * vel, 0.003, 1.4);
    perc(g2.gain, t, 0.035 * vel, 0.003, 0.4);
    wire(o1, g1, dest);
    wire(o2, g2, dest);
    b.done(t + 1.5);
  }

  timp(dest: AudioNode, t: number, midi: number, vel: number): void {
    const b = new Bag(this.ctx);
    const f = midiHz(midi);
    const o1 = b.osc('sine', f * 1.5, t);
    o1.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    const o2 = b.osc('sine', f * 1.51, t);
    const n = b.noise(this.white, t);
    const nlp = b.filter('lowpass', 500, 0.7);
    const g1 = b.gain(0);
    const g2 = b.gain(0);
    const gn = b.gain(0);
    perc(g1.gain, t, 0.5 * vel, 0.002, 1.6);
    perc(g2.gain, t, 0.15 * vel, 0.002, 0.5);
    perc(gn.gain, t, 0.25 * vel, 0.001, 0.07);
    wire(o1, g1, dest);
    wire(o2, g2, dest);
    wire(n, nlp, gn, dest);
    b.done(t + 1.75);
  }

  snare(dest: AudioNode, t: number, vel: number): void {
    const b = new Bag(this.ctx);
    const n = b.noise(this.white, t);
    const bp = b.filter('bandpass', 3000, 0.7);
    const gn = b.gain(0);
    perc(gn.gain, t, 0.28 * vel, 0.001, 0.16);
    const o = b.osc('triangle', 210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
    const go = b.gain(0);
    perc(go.gain, t, 0.16 * vel, 0.001, 0.08);
    wire(n, bp, gn, dest);
    wire(o, go, dest);
    b.done(t + 0.25);
  }

  bassDrum(dest: AudioNode, t: number, vel: number): void {
    const b = new Bag(this.ctx);
    const o = b.osc('sine', 75, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.3);
    const go = b.gain(0);
    perc(go.gain, t, 0.6 * vel, 0.003, 0.9);
    const n = b.noise(this.brown, t);
    const lp = b.filter('lowpass', 150, 0.7);
    const gn = b.gain(0);
    perc(gn.gain, t, 0.35 * vel, 0.003, 0.5);
    wire(o, go, dest);
    wire(n, lp, gn, dest);
    b.done(t + 1.0);
  }

  crash(dest: AudioNode, t: number, vel: number): void {
    const b = new Bag(this.ctx);
    const n = b.noise(this.white, t);
    const hp = b.filter('highpass', 4500, 0.6);
    const g = b.gain(0);
    perc(g.gain, t, 0.13 * vel, 0.004, 2.2);
    wire(n, hp, g, dest);
    b.done(t + 2.3);
  }

  /** Suspended-cymbal swell leading into the next section. */
  swell(dest: AudioNode, t: number, dur: number, vel: number): void {
    const b = new Bag(this.ctx);
    const n = b.noise(this.white, t);
    const hp = b.filter('highpass', 3500, 0.6);
    const g = b.gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1 * vel, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    wire(n, hp, g, dest);
    b.done(t + dur + 0.1);
  }
}

// ---------------------------------------------------------------------------
// Procedural score. Original material: chord progressions are generic diatonic
// motion and melodies are seeded random walks, so no existing theme is quoted.
// ---------------------------------------------------------------------------

type Chord = readonly [number, 'M' | 'm']; // semitone offset from key, quality

interface PatPart {
  pat: string; // 16 steps: '.' rest, digits = velocity or chord-tone index, '-' = tie
  vel: number;
  from: number; // first bar the layer plays
  oct: number;
  bright: number;
}
interface PercPart {
  pat: string;
  vel: number;
  from: number;
}
interface MelSpec {
  oct: number;
  vel: number;
  from: number;
  rhythm: number[]; // candidate note lengths in 16th steps
  leap: number;
  bias: number; // melodic direction tendency (-1 down … 1 up)
  inst: 'brass' | 'horn' | 'strings';
  restP: number;
  bright: number;
}
interface MoodSpec {
  bpm: number;
  key: number; // midi note of the tonic (bass register)
  progs: Chord[][];
  pad?: { oct: number; vel: number; atk: number; from: number };
  bass?: { vel: number; from: number };
  ost?: PatPart;
  ost2?: PatPart;
  harp?: PatPart;
  stabs?: PatPart;
  mel?: MelSpec;
  timp?: PercPart;
  snare?: PercPart;
  bd?: PercPart;
  crash?: number; // crash cymbal every N bars
  swell?: number; // cymbal swell on the last bar of every N bars
  rise?: { every: number; max: number }; // modulate up one semitone every N bars
}

const MOODS: Record<Mood, MoodSpec> = {
  menu: {
    bpm: 76,
    key: 50,
    progs: [
      [[0, 'M'], [10, 'M'], [5, 'M'], [0, 'M'], [8, 'M'], [10, 'M'], [7, 'M'], [7, 'M']],
      [[0, 'M'], [9, 'm'], [5, 'M'], [7, 'M'], [0, 'M'], [4, 'm'], [5, 'M'], [7, 'M']],
    ],
    pad: { oct: 1, vel: 0.55, atk: 0.8, from: 0 },
    bass: { vel: 0.6, from: 0 },
    harp: { pat: '0.1.2.3.4.3.2.1.', vel: 0.5, from: 0, oct: 0, bright: 0 },
    mel: { oct: 1, vel: 0.85, from: 2, rhythm: [4, 4, 8, 6, 2, 8, 4, 12], leap: 2, bias: 0.2, inst: 'brass', restP: 0.04, bright: 0.6 },
    timp: { pat: '7.......4.......', vel: 0.7, from: 0 },
    crash: 8,
  },
  briefing: {
    bpm: 64,
    key: 45,
    progs: [
      [[0, 'm'], [0, 'm'], [8, 'M'], [8, 'M'], [5, 'm'], [5, 'm'], [1, 'M'], [7, 'M']],
      [[0, 'm'], [3, 'M'], [8, 'M'], [7, 'M']],
    ],
    pad: { oct: 0, vel: 0.6, atk: 1.5, from: 0 },
    bass: { vel: 0.7, from: 0 },
    ost: { pat: '0..0............', vel: 0.45, from: 2, oct: -1, bright: 0.15 },
    mel: { oct: 0, vel: 0.5, from: 4, rhythm: [8, 8, 12, 4, 16, 6, 2], leap: 0.6, bias: -0.2, inst: 'horn', restP: 0.3, bright: 0.3 },
    timp: { pat: '5...............', vel: 0.5, from: 4 },
    swell: 8,
  },
  approach: {
    bpm: 104,
    key: 48,
    progs: [
      [[0, 'm'], [0, 'm'], [8, 'M'], [10, 'M'], [0, 'm'], [3, 'M'], [5, 'm'], [7, 'M']],
      [[0, 'm'], [10, 'M'], [8, 'M'], [7, 'M']],
    ],
    pad: { oct: 1, vel: 0.35, atk: 0.4, from: 0 },
    bass: { vel: 0.5, from: 4 },
    ost: { pat: '0.00.0.00.0.2.1.', vel: 0.6, from: 0, oct: -1, bright: 0.4 },
    stabs: { pat: '..............6.', vel: 0.6, from: 8, oct: 0, bright: 0.7 },
    mel: { oct: 1, vel: 0.8, from: 4, rhythm: [3, 1, 4, 4, 2, 2, 4, 6, 2, 4], leap: 1.5, bias: 0.1, inst: 'brass', restP: 0.08, bright: 0.7 },
    snare: { pat: '7..37..37.3.7.33', vel: 0.7, from: 2 },
    bd: { pat: '7.......6.......', vel: 0.8, from: 4 },
    timp: { pat: '7...........5...', vel: 0.8, from: 6 },
    crash: 8,
    swell: 8,
  },
  combat: {
    bpm: 148,
    key: 50,
    progs: [
      [[0, 'm'], [10, 'M'], [8, 'M'], [10, 'M']],
      [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']],
      [[0, 'm'], [5, 'm'], [8, 'M'], [7, 'M']],
    ],
    pad: { oct: 1, vel: 0.3, atk: 0.2, from: 0 },
    bass: { vel: 0.5, from: 0 },
    ost: { pat: '0030003000300230', vel: 0.55, from: 0, oct: -1, bright: 0.55 },
    ost2: { pat: '3.3.3.3.4.4.5.5.', vel: 0.25, from: 4, oct: 1, bright: 0.3 },
    stabs: { pat: '8.....7.....7...', vel: 0.65, from: 0, oct: 0, bright: 0.8 },
    mel: { oct: 1, vel: 0.9, from: 2, rhythm: [2, 2, 4, 2, 2, 4, 1, 1, 2, 6, 2, 4], leap: 1.5, bias: 0.15, inst: 'brass', restP: 0.05, bright: 0.85 },
    timp: { pat: '8..6..6...8..6.6', vel: 0.8, from: 0 },
    snare: { pat: '....7.......7.45', vel: 0.75, from: 0 },
    bd: { pat: '8.....6...8.....', vel: 0.8, from: 0 },
    crash: 8,
  },
  trench: {
    bpm: 164,
    key: 52,
    progs: [
      [[0, 'm'], [1, 'M'], [0, 'm'], [1, 'M'], [0, 'm'], [8, 'M'], [10, 'M'], [7, 'M']],
      [[0, 'm'], [1, 'M'], [3, 'M'], [1, 'M']],
    ],
    pad: { oct: 1, vel: 0.3, atk: 0.15, from: 0 },
    bass: { vel: 0.55, from: 0 },
    ost: { pat: '00b000b000b00b0b', vel: 0.6, from: 0, oct: -1, bright: 0.6 },
    ost2: { pat: '2222222222222222', vel: 0.18, from: 2, oct: 1, bright: 0.35 },
    stabs: { pat: '7.......7.....7.', vel: 0.55, from: 8, oct: 0, bright: 0.85 },
    mel: { oct: 1, vel: 0.9, from: 4, rhythm: [4, 2, 2, 4, 4, 8, 4, 4], leap: 1.2, bias: 0.3, inst: 'brass', restP: 0.03, bright: 0.9 },
    timp: { pat: '8...6...8...6.66', vel: 0.85, from: 0 },
    snare: { pat: '5.4.5.4.5.4.7.7.', vel: 0.7, from: 0 },
    bd: { pat: '8.......8.......', vel: 0.85, from: 0 },
    crash: 4,
    swell: 4,
    rise: { every: 4, max: 5 },
  },
  victory: {
    bpm: 116,
    key: 53,
    progs: [
      [[0, 'M'], [5, 'M'], [7, 'M'], [0, 'M'], [8, 'M'], [10, 'M'], [0, 'M'], [0, 'M']],
      [[0, 'M'], [9, 'm'], [5, 'M'], [7, 'M'], [0, 'M'], [5, 'M'], [7, 'M'], [0, 'M']],
    ],
    pad: { oct: 1, vel: 0.45, atk: 0.25, from: 0 },
    bass: { vel: 0.55, from: 0 },
    harp: { pat: '0.1.2.3.4.5.4.3.', vel: 0.45, from: 2, oct: 0, bright: 0 },
    stabs: { pat: '8..6.8..........', vel: 0.7, from: 0, oct: 0, bright: 0.9 },
    mel: { oct: 1, vel: 0.95, from: 0, rhythm: [3, 1, 4, 3, 1, 4, 4, 4, 8], leap: 2.5, bias: 0.35, inst: 'brass', restP: 0.02, bright: 0.85 },
    timp: { pat: '8...6...8.6.8...', vel: 0.8, from: 0 },
    snare: { pat: '............5.5.', vel: 0.6, from: 0 },
    bd: { pat: '8.......7.......', vel: 0.8, from: 0 },
    crash: 4,
  },
  defeat: {
    bpm: 54,
    key: 47,
    progs: [[[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M'], [5, 'm'], [0, 'm'], [7, 'M'], [0, 'm']]],
    pad: { oct: 0, vel: 0.5, atk: 1.8, from: 0 },
    bass: { vel: 0.55, from: 0 },
    mel: { oct: 1, vel: 0.6, from: 2, rhythm: [8, 4, 4, 12, 4, 16, 8], leap: 0.5, bias: -0.4, inst: 'horn', restP: 0.15, bright: 0.25 },
    timp: { pat: '4...............', vel: 0.6, from: 4 },
  },
};

const MOOD_LIST: Mood[] = ['menu', 'briefing', 'approach', 'combat', 'trench', 'victory', 'defeat'];
const SCALE_MAJ = [0, 2, 4, 5, 7, 9, 11];
const SCALE_MIN = [0, 2, 3, 5, 7, 8, 10];

/** Fold a semitone offset into -5..6 so chord roots stay near the key center. */
const normSemi = (r: number): number => {
  const m = ((r % 12) + 12) % 12;
  return m > 6 ? m - 12 : m;
};
const degSemi = (deg: number, scale: number[]): number =>
  12 * Math.floor(deg / 7) + scale[((deg % 7) + 7) % 7];
const nearestPc = (pc: number, target: number): number => pc + 12 * Math.round((target - pc) / 12);

function snapToChord(m: number, root: number, third: number): number {
  let best = m;
  let bd = Infinity;
  for (const iv of [0, third, 7]) {
    const n = nearestPc(root + iv, m);
    const d = Math.abs(n - m);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

interface MotifNote {
  len: number;
  deg: number | null;
  last: boolean;
}

function stepDeg(rng: () => number, deg: number, m: MelSpec): number {
  const w = [5, 3, m.leap, m.leap * 0.7, m.leap * 0.4];
  let r = rng() * w.reduce((a, b) => a + b, 0);
  let mag = 1;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) {
      mag = i + 1;
      break;
    }
  }
  let up = 0.5 + m.bias * 0.35;
  if (deg > 6) up -= 0.35;
  if (deg < -1) up += 0.35;
  let nd = deg + (rng() < up ? mag : -mag);
  if (nd > 9) nd = deg - mag;
  if (nd < -3) nd = deg + mag;
  return nd;
}

/** Two-bar (32 step) motif: seeded rhythm + scale-degree random walk, resolving to a chord tone. */
function genMotif(rng: () => number, m: MelSpec): Map<number, MotifNote> {
  const map = new Map<number, MotifNote>();
  let at = 0;
  let deg = rng() < 0.6 ? 0 : 4;
  while (at < 28) {
    let len = m.rhythm[Math.floor(rng() * m.rhythm.length)];
    if (at + len > 28) len = 28 - at;
    const rest = at > 0 && rng() < m.restP;
    map.set(at, { len, deg: rest ? null : deg, last: false });
    at += len;
    if (!rest) deg = stepDeg(rng, deg, m);
  }
  const tones = [0, 2, 4, 7];
  let fin = 0;
  for (const c of tones) if (Math.abs(c - deg) < Math.abs(fin - deg)) fin = c;
  map.set(at, { len: 32 - at, deg: fin, last: true });
  return map;
}

class Track {
  readonly out: GainNode;
  stopAt = Infinity;
  private readonly spec: MoodSpec;
  private readonly stepDur: number;
  private readonly prog: Chord[];
  private readonly motA: Map<number, MotifNote>;
  private readonly motB: Map<number, MotifNote>;
  private step = 0;
  private next: number;

  constructor(
    private readonly ins: Instruments,
    mood: Mood,
    ctx: AudioContext,
    dest: AudioNode,
    start: number,
    seed: number,
  ) {
    const sp = MOODS[mood];
    this.spec = sp;
    this.stepDur = 60 / sp.bpm / 4;
    const rng = mulberry32(seed);
    this.prog = sp.progs[Math.floor(rng() * sp.progs.length)];
    this.motA = sp.mel ? genMotif(rng, sp.mel) : new Map();
    this.motB = sp.mel ? genMotif(rng, sp.mel) : new Map();
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, start);
    this.out.gain.linearRampToValueAtTime(1, start + CROSSFADE);
    this.out.connect(dest);
    this.next = start;
  }

  fadeOut(now: number): void {
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + CROSSFADE);
    this.stopAt = now + CROSSFADE;
  }

  schedule(now: number, until: number): void {
    // After a stall (background tab), skip ahead instead of bursting missed notes.
    if (this.next < now - 0.1) {
      const skip = Math.ceil((now - this.next) / this.stepDur);
      this.step += skip;
      this.next += skip * this.stepDur;
    }
    while (this.next < until && this.next < this.stopAt) {
      this.play(this.step, this.next);
      this.step++;
      this.next += this.stepDur;
    }
  }

  private chordAt(bar: number): Chord {
    return this.prog[bar % this.prog.length];
  }

  private play(step: number, t: number): void {
    const sp = this.spec;
    const ins = this.ins;
    const out = this.out;
    const sd = this.stepDur;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const [cr, cq] = this.chordAt(bar);
    const rise = sp.rise ? Math.floor(bar / sp.rise.every) % (sp.rise.max + 1) : 0;
    const key = sp.key + rise;
    const r = normSemi(cr);
    const third = cq === 'M' ? 4 : 3;
    const root = key + r;
    const tones = [0, third, 7, 12, 12 + third, 19];
    const barLen = 16 * sd;

    if (s === 0) {
      if (sp.pad && bar >= sp.pad.from) {
        const center = key + 12 * sp.pad.oct + 2;
        const pcs = [0, third, 7, 12];
        for (let i = 0; i < 4; i++) {
          ins.strings(out, t, nearestPc(root + pcs[i], center + (i - 1.5) * 5), barLen, sp.pad.vel, sp.pad.atk);
        }
      }
      if (sp.bass && bar >= sp.bass.from) ins.strings(out, t, root - 12, barLen, sp.bass.vel * 1.6, 0.25);
      if (sp.crash && bar > 0 && bar % sp.crash === 0) ins.crash(out, t, 0.9);
      if (sp.swell && bar % sp.swell === sp.swell - 1) ins.swell(out, t, barLen, 0.8);
    }

    const tonal = (p: PatPart | undefined, fn: (m: number, len: number, v: number) => void): void => {
      if (!p || bar < p.from) return;
      const ch = p.pat[s];
      if (ch === '.' || ch === '-' || ch === undefined) return;
      let len = 1;
      while (s + len < 16 && p.pat[s + len] === '-') len++;
      const iv = ch === 'b' ? 1 : tones[Number(ch) % tones.length];
      fn(root + 12 * p.oct + iv, len * sd, p.vel);
    };
    tonal(sp.ost, (m, len, v) => ins.low(out, t, m, len * 0.9, v, sp.ost?.bright ?? 0.5));
    tonal(sp.ost2, (m, len, v) => ins.low(out, t, m, len * 0.9, v, sp.ost2?.bright ?? 0.5));
    tonal(sp.harp, (m, _len, v) => ins.harp(out, t, m, v));

    if (sp.stabs && bar >= sp.stabs.from) {
      const ch = sp.stabs.pat[s];
      if (ch && ch !== '.') {
        const v = (sp.stabs.vel * Number(ch)) / 9;
        const base = root + 12 * sp.stabs.oct;
        for (const iv of [0, third, 7]) ins.brass(out, t, base + iv, sd * 1.6, v, sp.stabs.bright, 0.015);
      }
    }

    const hit = (p: PercPart | undefined, fn: (v: number) => void): void => {
      if (!p || bar < p.from) return;
      const ch = p.pat[s];
      if (ch && ch !== '.') fn((p.vel * Number(ch)) / 9);
    };
    const timpPitch = 38 + ((((root - 38) % 12) + 12) % 12);
    hit(sp.timp, (v) => ins.timp(out, t, timpPitch, v));
    hit(sp.snare, (v) => ins.snare(out, t, v));
    hit(sp.bd, (v) => ins.bassDrum(out, t, v));

    const mel = sp.mel;
    if (mel && bar >= mel.from) {
      const mb = bar - mel.from;
      const phrase = Math.floor(mb / 2) % 4; // A A B A(cadence)
      const off = (mb % 2) * 16 + s;
      const n = (phrase === 2 ? this.motB : this.motA).get(off);
      if (n && n.deg !== null) {
        const [pr, pq] = this.chordAt(bar - (mb % 2));
        let m = key + 12 * mel.oct + normSemi(pr) + degSemi(n.deg, pq === 'M' ? SCALE_MAJ : SCALE_MIN);
        if (phrase === 3 && n.last) m = nearestPc(root, m);
        else if (off % 8 === 0 || n.last) m = snapToChord(m, root, third);
        const dur = n.len * sd * 0.95;
        if (mel.inst === 'brass') ins.brass(out, t, m, dur, mel.vel, mel.bright, 0.04);
        else if (mel.inst === 'horn') ins.brass(out, t, m, dur, mel.vel * 0.85, mel.bright * 0.5, 0.1);
        else ins.strings(out, t, m, dur, mel.vel * 1.6, 0.12);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SFX tables
// ---------------------------------------------------------------------------

interface LaserSpec {
  f0: number;
  f1: number;
  dur: number;
  w1: OscillatorType;
  w2: OscillatorType;
  ratio: number;
  bp0: number;
  bp1: number;
  q: number;
  noise: number;
  level: number;
  drive: number;
  body: number;
  shots: number;
}

const LASERS: Record<'xwing' | 'tie' | 'turbolaser' | 'falcon', LaserSpec> = {
  xwing: { f0: 1650, f1: 190, dur: 0.24, w1: 'sawtooth', w2: 'square', ratio: 1.505, bp0: 2600, bp1: 600, q: 2.2, noise: 0.5, level: 0.5, drive: 0, body: 0, shots: 1 },
  tie: { f0: 2700, f1: 520, dur: 0.16, w1: 'square', w2: 'sawtooth', ratio: 1.41, bp0: 4200, bp1: 1100, q: 1.6, noise: 0.6, level: 0.42, drive: 3, body: 0, shots: 1 },
  turbolaser: { f0: 760, f1: 70, dur: 0.6, w1: 'sawtooth', w2: 'square', ratio: 0.5, bp0: 1800, bp1: 180, q: 1.2, noise: 0.4, level: 0.85, drive: 1.5, body: 1, shots: 1 },
  falcon: { f0: 1200, f1: 150, dur: 0.2, w1: 'sawtooth', w2: 'sawtooth', ratio: 1.33, bp0: 2200, bp1: 400, q: 1.8, noise: 0.5, level: 0.6, drive: 1.2, body: 0.5, shots: 2 },
};

interface ExplSpec {
  dur: number;
  level: number;
  lp0: number;
  lp1: number;
  crack: number;
  sub0: number;
  sub1: number;
  subLv: number;
  booms: number;
  crackles: number;
  wet: number;
  drive: number;
}

const EXPLOSIONS: Record<'small' | 'medium' | 'large' | 'deathstar', ExplSpec> = {
  small: { dur: 0.9, level: 0.55, lp0: 4500, lp1: 250, crack: 0.08, sub0: 120, sub1: 45, subLv: 0.6, booms: 0, crackles: 4, wet: 0.08, drive: 0 },
  medium: { dur: 1.7, level: 0.75, lp0: 3800, lp1: 180, crack: 0.12, sub0: 100, sub1: 38, subLv: 0.8, booms: 1, crackles: 10, wet: 0.18, drive: 0 },
  large: { dur: 3.0, level: 0.95, lp0: 3200, lp1: 110, crack: 0.18, sub0: 85, sub1: 30, subLv: 1.0, booms: 3, crackles: 18, wet: 0.3, drive: 1.5 },
  deathstar: { dur: 7.5, level: 1.0, lp0: 5000, lp1: 60, crack: 0.35, sub0: 60, sub1: 20, subLv: 1.1, booms: 7, crackles: 40, wet: 0.5, drive: 2 },
};

interface Core {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  music: GainNode;
  musicVol: GainNode;
  verb: GainNode;
  white: AudioBuffer;
  brown: AudioBuffer;
  ins: Instruments;
}

interface Engine {
  bag: Bag;
  out: GainNode;
  nlp: BiquadFilterNode;
  gN: GainNode;
  s1: OscillatorNode;
  s2: OscillatorNode;
  slp: BiquadFilterNode;
  whine: OscillatorNode;
  gW: GainNode;
  gB: GainNode;
  boostOsc: OscillatorNode;
}

interface Chirp {
  t: number;
  d: number;
  f0: number;
  f1: number;
  wf: number;
  wd: number;
}

export class AudioSystem {
  private c: Core | null = null;
  private initing: Promise<void> | null = null;
  private paused = false;
  private masterVolume = 0.8;
  private musicVolume = 0.6;
  private readonly lpos = new THREE.Vector3();
  private readonly voices: Voice[] = [];
  private tracks: Track[] = [];
  private wantMood: MusicMood = 'none';
  private curMood: MusicMood = 'none';
  private engine: Engine | null = null;
  private lock: { bag: Bag; out: GainNode } | null = null;
  private alarmOn = false;
  private alarmNext = 0;
  private wing = 1;
  private sweepClock = 0;

  get ready(): boolean {
    return this.c !== null;
  }

  init(): Promise<void> {
    if (!this.initing) this.initing = this.create();
    return this.initing.then(() => this.unlock());
  }

  private async create(): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const sr = ctx.sampleRate;

    const white = ctx.createBuffer(1, Math.floor(sr * 2), sr);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const brown = ctx.createBuffer(1, Math.floor(sr * 4), sr);
    const bd = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bd.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      bd[i] = last * 3.5;
    }

    // Procedural reverb impulse: decaying noise that darkens over time.
    const irLen = Math.floor(sr * 2.6);
    const ir = ctx.createBuffer(2, irLen, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const x = i / irLen;
        const k = 0.9 - 0.85 * x;
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.pow(1 - x, 3);
      }
    }

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.4;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    wire(master, comp, makeup, limiter, ctx.destination);

    const sfx = ctx.createGain();
    sfx.gain.value = 0.9;
    sfx.connect(master);

    const verb = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.6;
    wire(verb, conv, verbOut, master);

    const music = ctx.createGain();
    music.gain.value = 0.55;
    const musicVol = ctx.createGain();
    musicVol.gain.value = this.musicVolume;
    wire(music, musicVol, master);
    const musicSend = ctx.createGain();
    musicSend.gain.value = 0.4;
    wire(musicVol, musicSend, verb);

    this.c = { ctx, master, sfx, music, musicVol, verb, white, brown, ins: new Instruments(ctx, white, brown) };
    // Background scheduler so music keeps flowing when the game loop does not call update().
    setInterval(() => this.pump(), 100);

    // Browsers may keep the context suspended until a gesture; resume on the next one.
    const kick = (): void => {
      if (!this.paused && ctx.state === 'suspended') void ctx.resume();
      if (ctx.state === 'running') {
        window.removeEventListener('pointerdown', kick);
        window.removeEventListener('keydown', kick);
      }
    };
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);

    const want = this.wantMood;
    this.wantMood = 'none';
    this.setMusic(want);
  }

  private async unlock(): Promise<void> {
    const c = this.c;
    if (!c || this.paused || c.ctx.state !== 'suspended') return;
    // resume() can stay pending without a user gesture: never block the caller on it.
    await Promise.race([c.ctx.resume(), new Promise<void>((r) => setTimeout(r, 400))]);
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    const c = this.c;
    if (c) c.master.gain.setTargetAtTime(this.masterVolume, c.ctx.currentTime, 0.05);
  }

  setMusicVolume(v: number): void {
    this.musicVolume = clamp01(v);
    const c = this.c;
    if (c) c.musicVol.gain.setTargetAtTime(this.musicVolume, c.ctx.currentTime, 0.05);
  }

  setListener(pos: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void {
    this.lpos.copy(pos);
    const c = this.c;
    if (!c) return;
    const l = c.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  // ---- voice allocation -------------------------------------------------

  private voice(c: Core, level: number, dur: number, pos?: THREE.Vector3, o: VoiceOpts = {}): Voice | null {
    if (this.paused) return null;
    const now = c.ctx.currentTime;
    let eff = level;
    if (pos) {
      const d = pos.distanceTo(this.lpos);
      if (d >= MAX_DIST) return null;
      eff *= REF_DIST / (REF_DIST + Math.max(0, d - REF_DIST));
      if (eff < 0.004) return null;
    }
    const prio = o.prio ?? 1;
    if (this.voices.length >= MAX_VOICES) {
      let vi = -1;
      let vs = Infinity;
      for (let i = 0; i < this.voices.length; i++) {
        const s = this.voices[i].score(now);
        if (s < vs) {
          vs = s;
          vi = i;
        }
      }
      if (vi < 0 || eff * prio < vs) return null;
      const victim = this.voices[vi];
      this.voices.splice(vi, 1);
      victim.steal(now);
    }
    const v = new Voice(c.ctx, eff, prio, now, now + dur);
    v.out.gain.value = level;
    let tail: AudioNode = v.out;
    if (pos) {
      const p = v.add(c.ctx.createPanner());
      p.panningModel = o.hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = REF_DIST;
      p.maxDistance = MAX_DIST;
      p.rolloffFactor = 1;
      setPannerPos(p, pos);
      v.out.connect(p);
      tail = p;
    } else if (o.pan) {
      const sp = v.add(c.ctx.createStereoPanner());
      sp.pan.value = o.pan;
      v.out.connect(sp);
      tail = sp;
    }
    tail.connect(c.sfx);
    if (o.wet) {
      const w = v.gain(o.wet);
      tail.connect(w);
      w.connect(c.verb);
    }
    v.onFree = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
    };
    this.voices.push(v);
    return v;
  }

  // ---- weapons ------------------------------------------------------------

  laser(kind: 'xwing' | 'tie' | 'turbolaser' | 'falcon', pos?: THREE.Vector3): void {
    const c = this.c;
    if (!c) return;
    const L = LASERS[kind];
    let pan = 0;
    if (!pos && kind === 'xwing') {
      this.wing = -this.wing; // alternating wingtip cannons
      pan = 0.35 * this.wing;
    }
    const total = L.dur + (L.shots - 1) * 0.06 + 0.08;
    const v = this.voice(c, L.level, total, pos, { pan, prio: pos ? 1 : 2 });
    if (!v) return;
    const t0 = c.ctx.currentTime;
    for (let k = 0; k < L.shots; k++) {
      const t = t0 + k * 0.06;
      const j = rand(0.94, 1.06);
      const f0 = L.f0 * j;
      const f1 = L.f1 * j;
      const end = t + L.dur;
      // Pitch-dropping oscillator pair + ring modulation: the twangy "tension wire" bolt.
      const o1 = v.osc(L.w1, f0, t);
      o1.frequency.exponentialRampToValueAtTime(f1, end);
      const o2 = v.osc(L.w2, f0 * L.ratio, t);
      o2.frequency.exponentialRampToValueAtTime(f1 * L.ratio, t + L.dur * 0.8);
      const o3 = v.osc('sine', f0 * 0.71, t);
      o3.frequency.exponentialRampToValueAtTime(f1 * 0.71, end);
      const rm = v.gain(0);
      o3.connect(rm.gain);
      o1.connect(rm);
      const g1 = v.gain(0.4);
      const g2 = v.gain(0.2);
      const g3 = v.gain(0.45);
      o1.connect(g1);
      o2.connect(g2);
      rm.connect(g3);
      const bp = v.filter('bandpass', L.bp0, L.q, t);
      bp.frequency.exponentialRampToValueAtTime(L.bp1, end);
      g1.connect(bp);
      g2.connect(bp);
      g3.connect(bp);
      const env = v.gain(0);
      perc(env.gain, t, 1.6, 0.003, L.dur);
      if (L.drive) wire(bp, v.shaper(L.drive), env);
      else bp.connect(env);
      env.connect(v.out);
      // Transient click.
      const n = v.noise(c.white, t);
      const hp = v.filter('highpass', 3000, 0.7);
      const ng = v.gain(0);
      perc(ng.gain, t, L.noise, 0.001, 0.03);
      wire(n, hp, ng, v.out);
      if (L.body) {
        const bn = v.noise(c.brown, t);
        const lp = v.filter('lowpass', 700, 0.8);
        const bg = v.gain(0);
        perc(bg.gain, t, 0.9 * L.body, 0.002, L.dur);
        wire(bn, lp, bg, v.out);
        const so = v.osc('sine', 110, t);
        so.frequency.exponentialRampToValueAtTime(40, end);
        const sg = v.gain(0);
        perc(sg.gain, t, 0.8 * L.body, 0.003, L.dur * 0.8);
        wire(so, sg, v.out);
      }
    }
    v.done(t0 + total);
  }

  torpedo(pos?: THREE.Vector3): void {
    const c = this.c;
    if (!c) return;
    const v = this.voice(c, 0.7, 1.45, pos, { prio: 3, wet: 0.1 });
    if (!v) return;
    const t = c.ctx.currentTime;
    // Launch thump.
    const th = v.osc('sine', 140, t);
    th.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    const tg = v.gain(0);
    perc(tg.gain, t, 1, 0.003, 0.3);
    wire(th, tg, v.out);
    // Rising whoosh.
    const n = v.noise(c.white, t);
    const bp = v.filter('bandpass', 400, 1, t);
    bp.frequency.exponentialRampToValueAtTime(2500, t + 1.2);
    const ng = v.gain(0);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.7, t + 0.05);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.35);
    wire(n, bp, ng, v.out);
    // Sizzling proton warble.
    const s = v.osc('sawtooth', 300, t);
    s.frequency.exponentialRampToValueAtTime(900, t + 1.2);
    const lfo = v.osc('sine', 18, t);
    const lg = v.gain(40);
    wire(lfo, lg, s.frequency);
    const lp = v.filter('lowpass', 2000, 2);
    const sg = v.gain(0);
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.25, t + 0.08);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    wire(s, lp, sg, v.out);
    v.done(t + 1.45);
  }

  explosion(size: 'small' | 'medium' | 'large' | 'deathstar', pos?: THREE.Vector3): void {
    const c = this.c;
    if (!c) return;
    const E = EXPLOSIONS[size];
    const end = E.dur + 0.15;
    const v = this.voice(c, E.level, end, pos, { wet: E.wet, prio: size === 'deathstar' ? 10 : 1.5 });
    if (!v) return;
    const t = c.ctx.currentTime;
    // Initial crack.
    const cn = v.noise(c.white, t);
    const chp = v.filter('highpass', 1200, 0.7);
    const cg = v.gain(0);
    perc(cg.gain, t, 0.7, 0.002, E.crack);
    wire(cn, chp, cg, v.out);
    // Body: brown noise through a closing lowpass, plus secondary booms.
    const bn = v.noise(c.brown, t, rand(0.8, 1.15));
    const lp = v.filter('lowpass', E.lp0, 0.9, t);
    lp.frequency.exponentialRampToValueAtTime(E.lp1, t + E.dur * 0.85);
    const bg = v.gain(0);
    perc(bg.gain, t, 1, 0.006, E.dur);
    wire(bn, bg, lp);
    for (let i = 0; i < E.booms; i++) {
      const tb = t + rand(0.15, E.dur * 0.55);
      const g2 = v.gain(0);
      perc(g2.gain, tb, rand(0.4, 0.8), 0.01, Math.min(E.dur * 0.4, t + E.dur - tb));
      wire(bn, g2, lp);
    }
    if (E.drive) wire(lp, v.shaper(E.drive), v.out);
    else lp.connect(v.out);
    // Sub thump.
    const so = v.osc('sine', E.sub0, t);
    so.frequency.exponentialRampToValueAtTime(E.sub1, t + E.dur * 0.5);
    const sg = v.gain(0);
    perc(sg.gain, t, E.subLv, 0.005, E.dur * 0.6);
    wire(so, sg, v.out);
    // Debris crackle.
    if (E.crackles) {
      const dn = v.noise(c.white, t);
      const bp = v.filter('bandpass', 2800, 0.9);
      const dg = v.gain(0);
      const times: number[] = [];
      for (let i = 0; i < E.crackles; i++) times.push(t + 0.05 + Math.random() * E.dur * 0.7);
      times.sort((a, b) => a - b);
      for (const tp of times) {
        dg.gain.setValueAtTime(rand(0.1, 0.35), tp);
        dg.gain.setTargetAtTime(0, tp + 0.002, 0.012);
      }
      wire(dn, bp, dg, v.out);
    }
    if (size === 'deathstar') {
      // Long trembling planetary-scale rumble.
      const ro = v.osc('sine', 48, t);
      ro.frequency.exponentialRampToValueAtTime(18, t + E.dur * 0.9);
      const trem = v.gain(0.7);
      const lfo = v.osc('sine', 2.3, t);
      const lg = v.gain(0.3);
      wire(lfo, lg, trem.gain);
      const rg = v.gain(0);
      rg.gain.setValueAtTime(0, t);
      rg.gain.linearRampToValueAtTime(1, t + 0.6);
      rg.gain.exponentialRampToValueAtTime(0.001, t + E.dur);
      wire(ro, trem, rg, v.out);
      const rn = v.noise(c.brown, t, 0.5);
      const rlp = v.filter('lowpass', 220, 0.7);
      const rng = v.gain(0);
      rng.gain.setValueAtTime(0, t);
      rng.gain.linearRampToValueAtTime(0.9, t + 1.2);
      rng.gain.exponentialRampToValueAtTime(0.001, t + E.dur);
      wire(rn, rlp, rng, v.out);
    }
    v.done(t + end);
  }

  playerHit(): void {
    const c = this.c;
    if (!c) return;
    const v = this.voice(c, 0.8, 0.85, undefined, { prio: 5 });
    if (!v) return;
    const t = c.ctx.currentTime;
    const th = v.osc('sine', 150, t);
    th.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    const tg = v.gain(0);
    perc(tg.gain, t, 1, 0.002, 0.3);
    wire(th, tg, v.out);
    // Crunch.
    const n = v.noise(c.white, t);
    const bp = v.filter('bandpass', 900, 0.9);
    const cg = v.gain(0);
    perc(cg.gain, t, 0.9, 0.001, 0.25);
    wire(n, bp, v.shaper(4), cg, v.out);
    // Metallic hull clang.
    for (const f of [520, 1370, 2210]) {
      const o = v.osc('sine', f * rand(0.97, 1.03), t);
      const g = v.gain(0);
      perc(g.gain, t, 0.12, 0.001, 0.4);
      wire(o, g, v.out);
    }
    // Sparks crackle.
    const sn = v.noise(c.white, t);
    const hp = v.filter('highpass', 4000, 0.7);
    const sg = v.gain(0);
    let tp = t + 0.04;
    for (let i = 0; i < 14 && tp < t + 0.75; i++) {
      sg.gain.setValueAtTime(rand(0.15, 0.45), tp);
      sg.gain.setTargetAtTime(0, tp + 0.002, 0.008);
      tp += rand(0.015, 0.07);
    }
    wire(sn, hp, sg, v.out);
    v.done(t + 0.85);
  }

  tieFlyby(pos: THREE.Vector3): void {
    const c = this.c;
    if (!c) return;
    const v = this.voice(c, 0.75, 1.85, pos, { hrtf: true, prio: 1.5 });
    if (!v) return;
    const t = c.ctx.currentTime;
    const mid = t + 0.75;
    const end = t + 1.8;
    const k = rand(0.92, 1.08);
    // Elephant-like roar: saws with a doppler-shaped pitch arc through vocal formants.
    const roar = v.gain(0.6);
    const am = v.osc('square', 32, t);
    const amg = v.gain(0.35);
    wire(am, amg, roar.gain);
    for (const det of [-12, 14]) {
      const o = v.osc('sawtooth', 140 * k, t, det);
      o.frequency.exponentialRampToValueAtTime(420 * k, mid);
      o.frequency.exponentialRampToValueAtTime(130 * k, end);
      o.connect(roar);
    }
    const env = v.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, mid);
    env.gain.linearRampToValueAtTime(0, end);
    for (const [f, q, lv] of [
      [800, 4, 0.9],
      [1400, 5, 0.6],
    ] as const) {
      const bp = v.filter('bandpass', f * 0.7, q, t);
      bp.frequency.exponentialRampToValueAtTime(f * 1.3, mid);
      bp.frequency.exponentialRampToValueAtTime(f * 0.6, end);
      const g = v.gain(lv);
      wire(roar, bp, g, env);
    }
    // Jet wash.
    const n = v.noise(c.white, t);
    const nbp = v.filter('bandpass', 900, 1.2, t);
    nbp.frequency.exponentialRampToValueAtTime(3500, mid);
    nbp.frequency.exponentialRampToValueAtTime(700, end);
    const ng = v.gain(0.7);
    wire(n, nbp, ng, env);
    env.connect(v.out);
    v.done(end + 0.05);
  }

  // ---- engine -------------------------------------------------------------

  setEngine(throttle01: number, boosting: boolean): void {
    const c = this.c;
    if (!c) return;
    const th = clamp01(throttle01);
    const now = c.ctx.currentTime;
    if (!this.engine) {
      const bag = new Bag(c.ctx);
      const out = bag.gain(0);
      out.gain.setTargetAtTime(0.5, now, 0.15);
      out.connect(c.sfx);
      const n = bag.noise(c.white, now);
      const nlp = bag.filter('lowpass', 600, 0.8);
      const gN = bag.gain(0.15);
      wire(n, nlp, gN, out);
      const rn = bag.noise(c.brown, now);
      const rlp = bag.filter('lowpass', 200, 0.7);
      const gR = bag.gain(0.5);
      wire(rn, rlp, gR, out);
      const s1 = bag.osc('sawtooth', 48, now, -8);
      const s2 = bag.osc('sawtooth', 48, now, 9);
      const slp = bag.filter('lowpass', 300, 1.2);
      const gS = bag.gain(0.2);
      s1.connect(slp);
      s2.connect(slp);
      wire(slp, gS, out);
      const whine = bag.osc('sine', 600, now);
      const gW = bag.gain(0.02);
      wire(whine, gW, out);
      const bn = bag.noise(c.white, now, 0.9);
      const bbp = bag.filter('bandpass', 1600, 0.7);
      const boostOsc = bag.osc('sawtooth', 96, now);
      const blp = bag.filter('lowpass', 900, 1);
      const gB = bag.gain(0);
      wire(bn, bbp, gB);
      wire(boostOsc, blp, gB);
      gB.connect(out);
      this.engine = { bag, out, nlp, gN, s1, s2, slp, whine, gW, gB, boostOsc };
    }
    const e = this.engine;
    const b = boosting ? 1 : 0;
    const tau = 0.12;
    e.nlp.frequency.setTargetAtTime(500 + 2500 * th + 1500 * b, now, tau);
    e.gN.gain.setTargetAtTime(0.1 + 0.2 * th, now, tau);
    const sf = 45 * (1 + 0.8 * th) * (1 + 0.1 * b);
    e.s1.frequency.setTargetAtTime(sf, now, tau);
    e.s2.frequency.setTargetAtTime(sf, now, tau);
    e.slp.frequency.setTargetAtTime(250 + 600 * th + 400 * b, now, tau);
    e.whine.frequency.setTargetAtTime(500 + 500 * th + 200 * b, now, tau);
    e.gW.gain.setTargetAtTime(0.02 + 0.03 * th, now, tau);
    e.boostOsc.frequency.setTargetAtTime(sf * 2, now, tau);
    e.gB.gain.setTargetAtTime(0.35 * b, now, boosting ? 0.08 : 0.25);
  }

  stopEngine(): void {
    const c = this.c;
    const e = this.engine;
    if (!c || !e) return;
    const now = c.ctx.currentTime;
    e.out.gain.cancelScheduledValues(now);
    e.out.gain.setTargetAtTime(0, now, 0.1);
    e.bag.kill(now + 0.6);
    this.engine = null;
  }

  // ---- cockpit / comms ----------------------------------------------------

  radio(open: boolean): void {
    const c = this.c;
    if (!c) return;
    const dur = open ? 0.2 : 0.3;
    const v = this.voice(c, 0.35, dur + 0.05, undefined, { prio: 4 });
    if (!v) return;
    const t = c.ctx.currentTime;
    const click = (at: number): void => {
      const o = v.osc('square', 1800, at);
      const g = v.gain(0);
      perc(g.gain, at, 0.5, 0.0005, 0.008);
      wire(o, g, v.out);
    };
    const n = v.noise(c.white, t);
    const bp = v.filter('bandpass', 2200, 1.5);
    const g = v.gain(0);
    if (open) {
      click(t);
      g.gain.setValueAtTime(0, t + 0.01);
      g.gain.linearRampToValueAtTime(0.6, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
    } else {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.7, t + 0.01);
      g.gain.setValueAtTime(0.7, t + 0.2);
      g.gain.linearRampToValueAtTime(0, t + 0.22); // squelch tail cut
      click(t + 0.23);
    }
    wire(n, bp, v.shaper(2), g, v.out);
    v.done(t + dur + 0.05);
  }

  r2(mood: 'happy' | 'worried' | 'scream'): void {
    const c = this.c;
    if (!c) return;
    const t0 = c.ctx.currentTime + 0.02;
    const chirps: Chirp[] = [];
    let t = t0;
    if (mood === 'happy') {
      const n = 5 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        const d = rand(0.04, 0.11);
        const f0 = rand(1400, 3600);
        const wf = Math.random() < 0.3 ? rand(20, 40) : 0;
        chirps.push({ t, d, f0, f1: f0 * rand(0.75, 1.7), wf, wd: wf ? rand(150, 450) : 0 });
        t += d + rand(0.015, 0.06);
      }
    } else if (mood === 'worried') {
      const n = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        const d = rand(0.14, 0.3);
        const f0 = rand(1500, 2400);
        chirps.push({ t, d, f0, f1: f0 * rand(0.45, 0.7), wf: rand(7, 9), wd: rand(40, 90) });
        t += d + rand(0.06, 0.12);
      }
      chirps.push({ t, d: 0.45, f0: 1300, f1: 520, wf: 6, wd: 50 });
      t += 0.45;
    } else {
      chirps.push({ t, d: 1.35, f0: 4400, f1: 520, wf: 28, wd: 700 });
      t += 1.35;
    }
    const dur = t - t0 + 0.08;
    const v = this.voice(c, 0.3, dur + 0.02, undefined, { prio: 4 });
    if (!v) return;
    const o = v.osc('sine', chirps[0].f0, t0);
    const mod = v.osc('sine', 1, t0);
    const md = v.gain(0);
    wire(mod, md, o.frequency);
    const g = v.gain(0);
    for (const ch of chirps) {
      o.frequency.setValueAtTime(ch.f0, ch.t);
      o.frequency.exponentialRampToValueAtTime(ch.f1, ch.t + ch.d);
      mod.frequency.setValueAtTime(Math.max(1, ch.wf), ch.t);
      md.gain.setValueAtTime(ch.wd, ch.t);
      g.gain.setValueAtTime(0, ch.t);
      g.gain.linearRampToValueAtTime(1, ch.t + 0.008);
      g.gain.setValueAtTime(1, ch.t + ch.d - 0.01);
      g.gain.linearRampToValueAtTime(0, ch.t + ch.d);
    }
    wire(o, v.shaper(1.8), g, v.out);
    if (mood === 'scream') {
      const ch = chirps[0];
      md.gain.linearRampToValueAtTime(150, ch.t + ch.d);
      // Raspy second voice + hiss.
      const o2 = v.osc('sawtooth', ch.f0 * 1.01, ch.t);
      o2.frequency.exponentialRampToValueAtTime(ch.f1 * 1.01, ch.t + ch.d);
      md.connect(o2.frequency);
      const lp = v.filter('lowpass', 3500, 1);
      const g2 = v.gain(0.12);
      wire(o2, lp, g2, g);
      const n = v.noise(c.white, ch.t);
      const bp = v.filter('bandpass', 3000, 1.2);
      const gn = v.gain(0);
      perc(gn.gain, ch.t, 0.12, 0.02, ch.d);
      wire(n, bp, gn, v.out);
    }
    v.done(t0 + dur);
  }

  alarm(on: boolean): void {
    if (on && !this.alarmOn && this.c) this.alarmNext = this.c.ctx.currentTime + 0.02;
    this.alarmOn = on;
    if (on) this.pump();
  }

  private alarmBeep(c: Core, t: number): void {
    const v = this.voice(c, 0.18, t + 0.3 - c.ctx.currentTime, undefined, { prio: 4 });
    if (!v) return;
    const o = v.osc('square', 1000, t);
    o.frequency.setValueAtTime(750, t + 0.12);
    const lp = v.filter('lowpass', 3000, 0.7);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.005);
    g.gain.setValueAtTime(1, t + 0.235);
    g.gain.linearRampToValueAtTime(0, t + 0.245);
    wire(o, lp, g, v.out);
    v.done(t + 0.26);
  }

  lockTone(on: boolean): void {
    const c = this.c;
    if (!c) return;
    const now = c.ctx.currentTime;
    if (on && !this.lock && !this.paused) {
      const bag = new Bag(c.ctx);
      const out = bag.gain(0);
      out.gain.setTargetAtTime(0.12, now, 0.02);
      out.connect(c.sfx);
      const o1 = bag.osc('sine', 1250, now);
      const o2 = bag.osc('square', 1250, now);
      const g2 = bag.gain(0.15);
      const gate = bag.gain(0.5);
      const lfo = bag.osc('square', 7, now);
      const lg = bag.gain(0.5);
      wire(lfo, lg, gate.gain);
      o1.connect(gate);
      wire(o2, g2, gate);
      gate.connect(out);
      this.lock = { bag, out };
    } else if (!on && this.lock) {
      this.lock.out.gain.cancelScheduledValues(now);
      this.lock.out.gain.setTargetAtTime(0, now, 0.02);
      this.lock.bag.kill(now + 0.15);
      this.lock = null;
    }
  }

  sfoils(): void {
    const c = this.c;
    if (!c) return;
    const v = this.voice(c, 0.6, 1.05, undefined, { prio: 4 });
    if (!v) return;
    const t = c.ctx.currentTime;
    const tc = t + 0.65;
    // Servo whine.
    const s = v.osc('sawtooth', 220, t);
    s.frequency.linearRampToValueAtTime(640, tc - 0.05);
    const bp = v.filter('bandpass', 900, 3);
    const sg = v.gain(0);
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.5, t + 0.05);
    sg.gain.setValueAtTime(0.5, tc - 0.06);
    sg.gain.linearRampToValueAtTime(0, tc);
    wire(s, bp, sg, v.out);
    // Gear grit.
    const n = v.noise(c.white, t);
    const nbp = v.filter('bandpass', 1800, 2);
    const ng = v.gain(0);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.15, t + 0.05);
    ng.gain.setValueAtTime(0.15, tc - 0.05);
    ng.gain.linearRampToValueAtTime(0, tc);
    wire(n, nbp, ng, v.out);
    // Lock clunk.
    const k = v.osc('sine', 180, tc);
    k.frequency.exponentialRampToValueAtTime(60, tc + 0.15);
    const kg = v.gain(0);
    perc(kg.gain, tc, 1, 0.002, 0.2);
    wire(k, kg, v.out);
    const kn = v.noise(c.white, tc);
    const kbp = v.filter('bandpass', 1200, 1);
    const kng = v.gain(0);
    perc(kng.gain, tc, 0.6, 0.001, 0.06);
    wire(kn, kbp, kng, v.out);
    for (const f of [890, 1530, 2480]) {
      const o = v.osc('sine', f, tc);
      const g = v.gain(0);
      perc(g.gain, tc, 0.1, 0.001, 0.35);
      wire(o, g, v.out);
    }
    v.done(t + 1.05);
  }

  ui(kind: 'select' | 'confirm' | 'objective' | 'fail'): void {
    const c = this.c;
    if (!c) return;
    const t = c.ctx.currentTime;
    const note = (v: Voice, at: number, f: number, d: number, type: OscillatorType, lv: number, bell = false): void => {
      const o = v.osc(type, f, at);
      const g = v.gain(0);
      perc(g.gain, at, lv, 0.004, d);
      wire(o, g, v.out);
      if (bell) {
        const o2 = v.osc('sine', f * 2.76, at);
        const g2 = v.gain(0);
        perc(g2.gain, at, lv * 0.3, 0.002, d * 0.4);
        wire(o2, g2, v.out);
      }
    };
    if (kind === 'select') {
      const v = this.voice(c, 0.25, 0.1, undefined, { prio: 5 });
      if (!v) return;
      note(v, t, 1400, 0.06, 'triangle', 0.8);
      v.done(t + 0.1);
    } else if (kind === 'confirm') {
      const v = this.voice(c, 0.25, 0.3, undefined, { prio: 5 });
      if (!v) return;
      note(v, t, 880, 0.1, 'triangle', 0.8);
      note(v, t + 0.08, 1320, 0.18, 'triangle', 0.8);
      v.done(t + 0.3);
    } else if (kind === 'objective') {
      const v = this.voice(c, 0.25, 0.85, undefined, { prio: 5 });
      if (!v) return;
      [784, 988, 1175, 1568].forEach((f, i) => note(v, t + i * 0.09, f, 0.5, 'sine', 0.7, true));
      v.done(t + 0.85);
    } else {
      const v = this.voice(c, 0.3, 0.5, undefined, { prio: 5 });
      if (!v) return;
      const lp = v.filter('lowpass', 1200, 0.8);
      lp.connect(v.out);
      [330, 220].forEach((f, i) => {
        const at = t + i * 0.18;
        const o = v.osc('sawtooth', f, at);
        const g = v.gain(0);
        perc(g.gain, at, 0.7, 0.005, 0.2);
        wire(o, g, lp);
      });
      v.done(t + 0.5);
    }
  }

  // ---- music --------------------------------------------------------------

  setMusic(mood: MusicMood): void {
    const c = this.c;
    if (!c) {
      this.wantMood = mood;
      return;
    }
    if (mood === this.curMood) return;
    this.curMood = mood;
    const now = c.ctx.currentTime;
    for (const tr of this.tracks) if (tr.stopAt === Infinity) tr.fadeOut(now);
    if (mood !== 'none') {
      const seed = MUSIC_SEED + MOOD_LIST.indexOf(mood) * 7919;
      this.tracks.push(new Track(c.ins, mood, c.ctx, c.music, now + 0.05, seed));
    }
    this.pump();
  }

  update(dt: number): void {
    if (!this.c) return;
    this.pump();
    this.sweepClock += dt;
    if (this.sweepClock > 1) {
      this.sweepClock = 0;
      // Safety net: release voices whose onended never fired (e.g. context closed mid-sound).
      const now = this.c.ctx.currentTime;
      for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end < now - 2) this.voices[i].free();
    }
  }

  /** Lookahead scheduler: music notes and alarm beeps on AudioContext time. */
  private pump(): void {
    const c = this.c;
    if (!c || this.paused || c.ctx.state !== 'running') return;
    const now = c.ctx.currentTime;
    const until = now + LOOKAHEAD;
    for (const tr of this.tracks) tr.schedule(now, until);
    if (this.tracks.some((tr) => now > tr.stopAt + 1)) {
      this.tracks = this.tracks.filter((tr) => {
        if (now <= tr.stopAt + 1) return true;
        tr.out.disconnect();
        return false;
      });
    }
    if (this.alarmOn) {
      if (this.alarmNext < now) this.alarmNext = now + 0.02;
      while (this.alarmNext < until) {
        this.alarmBeep(c, this.alarmNext);
        this.alarmNext += 0.55;
      }
    }
  }

  suspend(): void {
    this.paused = true;
    const c = this.c;
    if (c && c.ctx.state === 'running') void c.ctx.suspend();
  }

  resume(): void {
    this.paused = false;
    const c = this.c;
    if (c && c.ctx.state === 'suspended') void c.ctx.resume().then(() => this.pump());
  }
}
