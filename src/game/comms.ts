// Radio chatter: subtitle queue with optional speech synthesis, all text via i18n keys.
import type { AudioSystem } from '../audio/audio';
import { speechLang, t, type StringKey } from '../i18n/i18n';

export type Speaker =
  | 'luke'
  | 'biggs'
  | 'wedge'
  | 'porkins'
  | 'redLeader'
  | 'red10'
  | 'red7'
  | 'red9'
  | 'red11'
  | 'goldLeader'
  | 'gold5'
  | 'gold2'
  | 'vader'
  | 'wingman'
  | 'obiwan'
  | 'han'
  | 'base'
  | 'officer'
  | 'tarkin'
  | 'dodonna'
  | 'r2'
  | 'instructor';

export const SPEAKER_NAME: Record<Speaker, StringKey> = {
  luke: 'spk.luke',
  biggs: 'spk.biggs',
  wedge: 'spk.wedge',
  porkins: 'spk.porkins',
  redLeader: 'spk.redLeader',
  red10: 'spk.red10',
  red7: 'spk.red7',
  red9: 'spk.red9',
  red11: 'spk.red11',
  goldLeader: 'spk.goldLeader',
  gold5: 'spk.gold5',
  gold2: 'spk.gold2',
  vader: 'spk.vader',
  wingman: 'spk.wingman',
  obiwan: 'spk.obiwan',
  han: 'spk.han',
  base: 'spk.base',
  officer: 'spk.officer',
  tarkin: 'spk.tarkin',
  dodonna: 'spk.dodonna',
  r2: 'spk.r2',
  instructor: 'spk.instructor',
};

/** Subtitle colour per allegiance. */
export const SPEAKER_COLOR: Record<Speaker, string> = {
  luke: '#ffd27a',
  biggs: '#ff9a7a',
  wedge: '#ff9a7a',
  porkins: '#ff9a7a',
  redLeader: '#ff7a6a',
  red10: '#ff9a7a',
  red7: '#ff9a7a',
  red9: '#ff9a7a',
  red11: '#ff9a7a',
  goldLeader: '#ffd84a',
  gold5: '#ffd84a',
  gold2: '#ffd84a',
  vader: '#9fff9f',
  wingman: '#9fff9f',
  obiwan: '#9fd8ff',
  han: '#ffffff',
  base: '#9ad0ff',
  officer: '#9fff9f',
  tarkin: '#9fff9f',
  dodonna: '#9ad0ff',
  r2: '#7ab8ff',
  instructor: '#8fe3c8',
};

// Voice character for optional speech synthesis.
const VOICE: Record<Speaker, { pitch: number; rate: number }> = {
  luke: { pitch: 1.15, rate: 1.08 },
  biggs: { pitch: 0.95, rate: 1.05 },
  wedge: { pitch: 1.05, rate: 1.1 },
  porkins: { pitch: 0.75, rate: 0.95 },
  redLeader: { pitch: 0.85, rate: 1.0 },
  red10: { pitch: 1, rate: 1.1 },
  red7: { pitch: 0.9, rate: 1.1 },
  red9: { pitch: 1.1, rate: 1.1 },
  red11: { pitch: 0.95, rate: 1.1 },
  goldLeader: { pitch: 0.8, rate: 1.0 },
  gold5: { pitch: 0.7, rate: 0.95 },
  gold2: { pitch: 1.0, rate: 1.1 },
  vader: { pitch: 0.3, rate: 0.85 },
  wingman: { pitch: 0.9, rate: 1.1 },
  obiwan: { pitch: 0.75, rate: 0.85 },
  han: { pitch: 1.0, rate: 1.12 },
  base: { pitch: 0.95, rate: 1.0 },
  officer: { pitch: 0.85, rate: 1.0 },
  tarkin: { pitch: 0.7, rate: 0.9 },
  dodonna: { pitch: 0.7, rate: 0.92 },
  r2: { pitch: 2, rate: 1.5 },
  instructor: { pitch: 0.9, rate: 1.0 },
};

export interface CommLine {
  speaker: Speaker;
  key: StringKey;
  params?: Record<string, string | number>;
  /** Telepathic (Obi-Wan) lines skip the radio squelch. */
  ghost: boolean;
  duration: number;
  elapsed: number;
}

export class Comms {
  voices = false;
  current: CommLine | null = null;
  private queue: CommLine[] = [];
  /** Recent lines for the HUD log. */
  readonly history: CommLine[] = [];

  constructor(private audio: AudioSystem) {}

  /** Queue a line; returns a predicate that becomes true when the line has finished. */
  say(speaker: Speaker, key: StringKey, params?: Record<string, string | number>): () => boolean {
    const text = t(key, params);
    const line: CommLine = {
      speaker,
      key,
      params,
      ghost: speaker === 'obiwan',
      duration: Math.min(7, 1.4 + text.length * 0.055),
      elapsed: 0,
    };
    this.queue.push(line);
    return () => this.current !== line && !this.queue.includes(line);
  }

  /** Interrupt everything (critical moments). */
  interrupt(speaker: Speaker, key: StringKey, params?: Record<string, string | number>): () => boolean {
    this.queue.length = 0;
    if (this.current) this.finish();
    return this.say(speaker, key, params);
  }

  get busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  clear(): void {
    this.queue.length = 0;
    this.current = null;
    this.history.length = 0;
    if (this.voices) speechSynthesis.cancel();
  }

  private start(line: CommLine): void {
    this.current = line;
    if (line.speaker === 'r2') this.audio.r2(line.key === 'r2.scream' ? 'scream' : line.key === 'r2.worried' ? 'worried' : 'happy');
    else if (!line.ghost) this.audio.radio(true);
    this.history.push(line);
    if (this.history.length > 6) this.history.shift();
    if (this.voices && line.speaker !== 'r2' && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(t(line.key, line.params));
      u.lang = speechLang();
      const v = VOICE[line.speaker];
      u.pitch = v.pitch;
      u.rate = v.rate;
      u.volume = line.ghost ? 0.7 : 0.9;
      const voice = speechSynthesis.getVoices().find((x) => x.lang.replace('_', '-').startsWith(u.lang.slice(0, 2)));
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    }
  }

  private finish(): void {
    if (this.current && this.current.speaker !== 'r2' && !this.current.ghost) this.audio.radio(false);
    this.current = null;
  }

  update(dt: number): void {
    if (this.current) {
      this.current.elapsed += dt;
      const speaking = this.voices && speechSynthesis.speaking;
      if (this.current.elapsed >= this.current.duration && !(speaking && this.current.elapsed < this.current.duration + 4)) {
        this.finish();
      }
    }
    if (!this.current && this.queue.length) this.start(this.queue.shift()!);
  }
}
