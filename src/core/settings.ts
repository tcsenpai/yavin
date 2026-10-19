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
}

export const DIFFICULTIES = ['cadet', 'pilot', 'ace', 'jedi'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Global challenge multiplier: enemy accuracy/aggression, fire rates, wave sizes, and (^1.5) damage taken. */
export const DIFFICULTY_SCALE: Record<Difficulty, number> = { cadet: 0.65, pilot: 1, ace: 1.25, jedi: 1.5 };

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
