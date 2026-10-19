// Skirmish arenas: orbital backdrops above famous planets. The battle sits at the world origin; each
// primary planet hangs large below and ahead of it, lit mostly from behind the player.
import * as THREE from 'three';
import type { ArenaSky, EnvOptions } from './environment';

export type ArenaId = 'yavin' | 'tatooine' | 'naboo' | 'alderaan' | 'coruscant' | 'hoth' | 'endor';

export const ARENA_IDS: readonly ArenaId[] = ['yavin', 'tatooine', 'naboo', 'alderaan', 'coruscant', 'hoth', 'endor'];

/** Centre `dist` metres away along `dir` (normalised here). */
function at(x: number, y: number, z: number, dist: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).normalize().multiplyScalar(dist);
}

const SKIES: Record<Exclude<ArenaId, 'yavin'>, ArenaSky> = {
  tatooine: {
    primary: { style: 'desert', radius: 5.6e7, pos: at(0.5, -0.45, -0.74, 0.95e8), seed: 3 },
    twinSun: true,
  },
  naboo: {
    primary: { style: 'swampTemperate', radius: 5.8e7, pos: at(0.45, -0.5, -0.74, 0.95e8), seed: 7 },
  },
  alderaan: {
    primary: { style: 'temperate', radius: 6.0e7, pos: at(0.52, -0.42, -0.74, 0.95e8), seed: 11 },
  },
  coruscant: {
    // Turned further toward the terminator so the night side's city lights show.
    primary: { style: 'ecumenopolis', radius: 6.0e7, pos: at(0.7, -0.4, -0.6, 0.95e8), seed: 5 },
  },
  hoth: {
    primary: { style: 'ice', radius: 5.4e7, pos: at(0.5, -0.48, -0.72, 0.92e8), seed: 13 },
    others: [
      { style: 'barren', radius: 2.4e6, pos: new THREE.Vector3(-2.0e7, 0.5e7, -6.0e7), seed: 1 },
      { style: 'barren', radius: 1.5e6, pos: new THREE.Vector3(3.6e7, 1.4e7, -8.5e7), seed: 2 },
    ],
  },
  endor: {
    primary: { style: 'forest', radius: 3.6e7, pos: at(0.5, -0.45, -0.74, 0.75e8), seed: 17 },
    // The gas giant Endor looms beyond its forest moon, partly hidden behind it.
    others: [{ style: 'gasGiant', radius: 1.5e8, pos: at(0.45, 0.2, -0.87, 5.0e8) }],
  },
};

/**
 * Extra buildEnvironment options for the arena. 'yavin' keeps the campaign's own Yavin sky, with the gas
 * giant moved below and ahead like the other primaries and its jungle moon off to the left.
 */
export function arenaEnv(id: ArenaId): Pick<EnvOptions, 'sky' | 'yavinPos' | 'yavin4Pos'> {
  if (id === 'yavin') return { yavinPos: at(0.5, -0.45, -0.74, 1.15e8), yavin4Pos: at(-0.6, 0.15, -0.8, 3.0e7) };
  return { sky: SKIES[id] };
}
