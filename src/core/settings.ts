// Persisted player settings and campaign progress.
import type { Quality } from './engine';

export interface Settings {
  sensitivity: number;
  invertY: boolean;
  master: number;
  music: number;
  voices: boolean;
  quality: Quality;
  difficulty: Difficulty;
  /** Ids of missions completed at least once (all missions are always selectable). */
  completed: string[];
  /** Best result per mission id. */
  best: Record<string, { score: number; rank: string; difficulty: Difficulty }>;
  /** Difficulty-scaled aim assist (bolt magnetism + reticle friction). */
  aimAssist: boolean;
  /** Furthest checkpoint value reached per mission id (unlocks resuming from it). */
  checkpoints: Record<string, number>;
}

export const DIFFICULTIES = ['cadet', 'pilot', 'ace', 'jedi'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Global challenge multiplier: enemy accuracy/aggression, fire rates, wave sizes, and (^1.5) damage taken. */
export const DIFFICULTY_SCALE: Record<Difficulty, number> = { cadet: 0.5, pilot: 1, ace: 1.25, jedi: 1.5 };

/**
 * Automatic hull regeneration: Cadet regenerates continuously, Pilot only after `delay` s without damage.
 * Ace/Jedi rely on R2-D2's slow field repairs only.
 */
export const HULL_REGEN: Record<Difficulty, { rate: number; delay: number } | null> = {
  cadet: { rate: 4, delay: 0 },
  pilot: { rate: 3, delay: 4 },
  ace: null,
  jedi: null,
};

/**
 * Aim assist per difficulty. Only engages when the reticle is already near a target's lead point:
 * `coneDeg` is the base capture cone (plus the target's angular size, shrinking past ~800 m),
 * `friction` slows the stick while on target, `lockTime` is the proton torpedo lock time,
 * `lockSteer`: a completed lock also directs the laser cannons onto the target (Cadet only).
 */
export const AIM_ASSIST: Record<Difficulty, { coneDeg: number; range: number; friction: number; lockTime: number; lockSteer: boolean }> = {
  cadet: { coneDeg: 4.5, range: 1500, friction: 0.45, lockTime: 0.7, lockSteer: true },
  pilot: { coneDeg: 2.8, range: 1250, friction: 0.3, lockTime: 1.0, lockSteer: false },
  ace: { coneDeg: 1.6, range: 1000, friction: 0.15, lockTime: 1.3, lockSteer: false },
  jedi: { coneDeg: 0.7, range: 800, friction: 0, lockTime: 1.6, lockSteer: false },
};

const KEY = 'yavin.settings.v1';

const DEFAULTS: Settings = {
  sensitivity: 1,
  invertY: false,
  master: 0.8,
  music: 0.6,
  voices: false,
  quality: 'high',
  difficulty: 'pilot',
  completed: [],
  best: {},
  aimAssist: true,
  checkpoints: {},
};

export function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } as Settings;
    if (!DIFFICULTIES.includes(s.difficulty)) s.difficulty = 'pilot';
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
