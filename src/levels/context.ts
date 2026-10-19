// What a level script can touch. Created by Game for each level run.
import type * as THREE from 'three';
import type { AudioSystem, MusicMood } from '../audio/audio';
import type { Input } from '../core/input';
import type { Comms } from '../game/comms';
import type { Script } from '../game/script';
import type { Ship } from '../game/ship';
import type { World } from '../game/world';
import type { StringKey } from '../i18n/i18n';
import type { Objective, TargetingComputer } from '../ui/hud';

export interface LevelStats {
  kills: number;
  towers: number;
  shots: number;
  hits: number;
  time: number;
  forceUsed: boolean;
  score: number;
}

export interface LevelContext {
  readonly scene: THREE.Scene;
  readonly world: World;
  readonly audio: AudioSystem;
  readonly comms: Comms;
  readonly input: Input;
  readonly camera: THREE.PerspectiveCamera;
  readonly difficulty: number;
  readonly stats: LevelStats;
  /** Level start option (e.g. trench checkpoint). */
  readonly checkpoint: number;
  player: Ship | null;
  objectives: Objective[];
  markers: { pos: THREE.Vector3; key: StringKey }[];
  timer: { key: StringKey; seconds: number } | null;
  hint: StringKey | null;
  hintParams?: Record<string, string | number>;
  /** Shown above the HUD when non-null. */
  computer: TargetingComputer | null;
  computerAvailable: boolean;
  computerOff: boolean;
  /** Hide HUD (cinematics). */
  showHud: boolean;
  /** Player input disabled (autopilot / cinematic). */
  playerControl: boolean;
  torpedoes: number;
  /** Return true if the level handled the torpedo launch itself. */
  onTorpedo: (() => boolean) | null;
  /** Cinematic camera; return true when it set the camera this frame. */
  cameraOverride: ((cam: THREE.PerspectiveCamera, dt: number) => boolean) | null;
  /** Extra per-frame logic. */
  onUpdate: ((dt: number) => void) | null;
  /** Camera shake trauma 0..1 (decays). */
  shake: number;
  /** Screen flash 0..1 (decays). */
  flash: number;

  run(script: Script): void;
  music(mood: MusicMood): void;
  setObjective(i: number, patch: Partial<Objective>): void;
  /** R2-D2 slowly repairs the hull while alive. */
  r2Alive: boolean;
  complete(): void;
  fail(reason: StringKey): void;
  /** Pop a centred banner (title + subtitle). */
  banner(title: StringKey, sub?: StringKey, seconds?: number): void;
  /** Score + floating notification (kill feed / objective bonus). */
  award(points: number, label: StringKey, params?: Record<string, string | number>): void;
  /** Prompt the player for an action key press; resolves when pressed (or after timeout). */
  waitAction(action: 'confirm' | 'sfoils' | 'deflectors' | 'targetComputer', hint: StringKey, timeout?: number): () => boolean;
}

export interface LevelDef {
  id: string;
  /** mission = campaign flight; training = tutorial; cinematic = skippable non-interactive scene. */
  kind: 'mission' | 'training' | 'cinematic';
  /** Score needed for rank S (A ≥ 75 %, B ≥ 50 %). */
  par?: number;
  titleKey: StringKey;
  subKey: StringKey;
  /** Text card shown before the level. */
  introKey: StringKey;
  controlsKey?: StringKey;
  checkpoints?: { key: StringKey; value: number }[];
  setup(ctx: LevelContext): void;
}
