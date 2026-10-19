// Persisted player settings and campaign progress.
import type { Quality } from './engine';

export interface Settings {
  sensitivity: number;
  invertY: boolean;
  master: number;
  music: number;
  voices: boolean;
  quality: Quality;
  difficulty: 'cadet' | 'pilot' | 'jedi';
  /** Ids of missions completed at least once (all missions are always selectable). */
  completed: string[];
}

export const DIFFICULTY_SCALE: Record<Settings['difficulty'], number> = { cadet: 0.7, pilot: 1, jedi: 1.35 };

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
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
