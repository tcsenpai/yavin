// DOM overlays: title, crawl, mission select, settings, controls, mission cards, pause, results, ending.
import { DIFFICULTIES, type Difficulty, type Settings } from '../core/settings';
import { LANGS, getLang, onLangChange, setLang, t, type Lang, type StringKey } from '../i18n/i18n';
import type { LevelDef, LevelStats } from '../levels/context';

type Render = () => void;
export type Rank = 'S' | 'A' | 'B' | 'C';

export interface MenuHandlers {
  startCampaign(): void;
  startLevel(id: string, checkpoint?: number): void;
  /** Resume the campaign from the furthest point reached. */
  continueCampaign(): void;
  /** Label of the resume point, or null when there's nothing to continue. */
  resumeInfo(): string | null;
  /** Change difficulty from a mission card (rebuilds the level behind it). */
  setDifficulty(d: Difficulty): void;
  settingsChanged(s: Settings): void;
  resume(): void;
  restart(checkpoint?: number): void;
  quit(): void;
  next(): void;
  uiSound(kind: 'select' | 'confirm'): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const DIFF_KEY: Record<Difficulty, StringKey> = {
  cadet: 'set.diff.cadet',
  pilot: 'set.diff.pilot',
  ace: 'set.diff.ace',
  jedi: 'set.diff.jedi',
};

export class Menus {
  readonly root: HTMLDivElement;
  private current: Render | null = null;
  private back: Render | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private levels: LevelDef[],
    private campaign: string[],
    private settings: Settings,
    private h: MenuHandlers,
  ) {
    this.root = el('div', 'overlay');
    parent.appendChild(this.root);
    onLangChange(() => this.current?.());
  }

  hide(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
    this.current = null;
    this.setKeys(null);
  }

  private show(render: Render): void {
    this.current = render;
    this.root.hidden = false;
    render();
  }

  private setKeys(fn: ((e: KeyboardEvent) => void) | null): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = fn;
    if (fn) window.addEventListener('keydown', fn);
  }

  private button(label: string, onClick: () => void, primary = false, disabled = false): HTMLButtonElement {
    const b = el('button', primary ? 'btn primary' : 'btn', label);
    b.disabled = disabled;
    b.addEventListener('mouseenter', () => !disabled && this.h.uiSound('select'));
    b.addEventListener('click', () => {
      this.h.uiSound('confirm');
      onClick();
    });
    return b;
  }

  private langSwitch(): HTMLElement {
    const box = el('div', 'lang');
    for (const l of LANGS) {
      const b = el('button', l.id === getLang() ? 'chip active' : 'chip', l.label);
      b.addEventListener('click', () => setLang(l.id as Lang));
      box.appendChild(b);
    }
    return box;
  }

  /** Difficulty chips; `onPick` decides what a change does (save, or rebuild the level). */
  private difficultyChips(onPick: (d: Difficulty) => void): HTMLElement {
    const box = el('div', 'lang diff');
    for (const d of DIFFICULTIES) {
      const b = el('button', d === this.settings.difficulty ? 'chip active' : 'chip', t(DIFF_KEY[d]));
      b.title = t(`set.diff.${d}.desc` as StringKey);
      b.addEventListener('click', () => {
        if (d === this.settings.difficulty) return;
        this.h.uiSound('confirm');
        onPick(d);
      });
      box.appendChild(b);
    }
    return box;
  }

  showTitle(): void {
    this.back = null;
    this.setKeys(null);
    this.show(() => {
      const panel = el('div', 'title-screen');
      panel.append(el('div', 'pre', t('menu.pre')), el('h1', 'logo', t('menu.title')), el('div', 'subtitle', t('menu.subtitle')));
      const nav = el('div', 'nav');
      const resume = this.h.resumeInfo();
      if (resume) {
        const b = this.button(t('menu.continue'), () => this.h.continueCampaign(), true);
        b.append(el('span', 'btn-sub', resume));
        nav.append(b);
      }
      nav.append(
        this.button(t('menu.campaign'), () => this.h.startCampaign(), !resume),
        this.button(t('menu.training'), () => this.h.startLevel('training')),
        this.button(t('menu.select'), () => this.showLevelSelect()),
        this.button(t('menu.settings'), () => {
          this.back = () => this.showTitle();
          this.showSettings();
        }),
        this.button(t('menu.controls'), () => {
          this.back = () => this.showTitle();
          this.showControls();
        }),
      );
      panel.append(nav, this.langSwitch(), el('div', 'foot', t('menu.footer')));
      this.root.replaceChildren(panel);
    });
  }

  /** "A long time ago..." then the scrolling crawl. Skippable with any key / click. */
  showCrawl(onDone: () => void): void {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.setKeys(null);
      onDone();
    };
    this.setKeys((e) => {
      if (['Enter', 'Escape', 'Space', 'Backspace'].includes(e.code)) finish();
    });
    this.show(() => {
      const wrap = el('div', 'crawl-screen');
      wrap.addEventListener('click', finish);
      const crawl = el('div', 'crawl');
      const inner = el('div', 'crawl-inner');
      inner.append(el('div', 'episode', t('crawl.episode')), el('div', 'crawl-title', t('crawl.title')));
      for (const k of ['crawl.p1', 'crawl.p2', 'crawl.p3'] as StringKey[]) inner.append(el('p', '', t(k)));
      crawl.append(inner);
      wrap.append(el('div', 'ago', t('crawl.ago')), crawl, el('div', 'skip', t('menu.skip')));
      this.root.replaceChildren(wrap);
      inner.addEventListener('animationend', finish);
    });
  }

  private levelCard(lv: LevelDef, label: string): HTMLElement {
    const done = this.settings.completed.includes(lv.id);
    const best = this.settings.best[lv.id];
    const card = el('div', done ? 'level done' : 'level');
    const head = el('div', 'num', label);
    if (best) head.append(el('span', `rank rank-${best.rank}`, ` ${best.rank} · ${best.score}`));
    card.append(head, el('div', 'name', t(lv.titleKey)), el('div', 'desc', t(lv.subKey)));
    const row = el('div', 'row');
    row.append(this.button(t(lv.kind === 'cinematic' ? 'menu.watch' : 'menu.play'), () => this.h.startLevel(lv.id), true));
    // Checkpoints unlock once reached in play; locked ones are shown greyed out.
    const reached = this.settings.checkpoints[lv.id] ?? 0;
    for (const cp of lv.checkpoints?.slice(1) ?? []) {
      const open = cp.value <= reached;
      row.append(this.button(`${open ? '' : '🔒 '}${t(cp.key)}`, () => this.h.startLevel(lv.id, cp.value), false, !open));
    }
    card.append(row);
    return card;
  }

  showLevelSelect(): void {
    this.show(() => {
      const panel = el('div', 'panel wide');
      panel.append(el('h2', '', t('menu.select')));
      const section = (title: StringKey, items: [LevelDef, string][]) => {
        if (!items.length) return;
        panel.append(el('div', 'section', t(title)));
        const list = el('div', 'levels');
        for (const [lv, label] of items) list.append(this.levelCard(lv, label));
        panel.append(list);
      };
      const missions = this.campaign.map((id) => this.levels.find((l) => l.id === id)!).filter((l) => l.kind === 'mission');
      section('menu.sec.training', this.levels.filter((l) => l.kind === 'training').map((l) => [l, t('menu.training')]));
      section('menu.sec.campaign', missions.map((l, i) => [l, `${t('menu.mission')} ${i + 1}`]));
      section('menu.sec.extras', this.levels.filter((l) => l.kind === 'cinematic').map((l) => [l, t('menu.cinematic')]));
      panel.append(this.button(t('menu.back'), () => this.showTitle()));
      this.root.replaceChildren(panel);
    });
  }

  showSettings(): void {
    this.show(() => {
      const s = this.settings;
      const panel = el('div', 'panel');
      panel.append(el('h2', '', t('menu.settings')));
      const form = el('div', 'form');
      const row = (label: string, input: HTMLElement) => {
        const r = el('label', 'field');
        r.append(el('span', '', label), input);
        form.append(r);
      };
      const range = (v: number, min: number, max: number, step: number, set: (v: number) => void) => {
        const i = el('input');
        i.type = 'range';
        i.min = String(min);
        i.max = String(max);
        i.step = String(step);
        i.value = String(v);
        i.addEventListener('input', () => {
          set(Number(i.value));
          this.h.settingsChanged(s);
        });
        return i;
      };
      const check = (v: boolean, set: (v: boolean) => void) => {
        const i = el('input');
        i.type = 'checkbox';
        i.checked = v;
        i.addEventListener('change', () => {
          set(i.checked);
          this.h.settingsChanged(s);
        });
        return i;
      };
      const select = <T extends string>(v: T, opts: [T, StringKey][], set: (v: T) => void) => {
        const i = el('select');
        for (const [val, key] of opts) {
          const o = el('option', '', t(key));
          o.value = val;
          o.selected = val === v;
          i.append(o);
        }
        i.addEventListener('change', () => {
          set(i.value as T);
          this.h.settingsChanged(s);
        });
        return i;
      };
      row(t('set.language'), this.langSwitch());
      row(
        t('set.difficulty'),
        this.difficultyChips((d) => {
          s.difficulty = d;
          this.h.settingsChanged(s);
          this.current?.();
        }),
      );
      row(t('set.sensitivity'), range(s.sensitivity, 0.3, 2.5, 0.05, (v) => (s.sensitivity = v)));
      row(t('set.invert'), check(s.invertY, (v) => (s.invertY = v)));
      row(t('set.aimAssist'), check(s.aimAssist, (v) => (s.aimAssist = v)));
      row(t('set.master'), range(s.master, 0, 1, 0.01, (v) => (s.master = v)));
      row(t('set.music'), range(s.music, 0, 1, 0.01, (v) => (s.music = v)));
      row(t('set.voices'), check(s.voices, (v) => (s.voices = v)));
      row(t('set.quality'), select(s.quality, [['low', 'set.q.low'], ['medium', 'set.q.medium'], ['high', 'set.q.high']], (v) => (s.quality = v)));
      panel.append(form, this.button(t('menu.back'), () => (this.back ?? (() => this.showTitle()))()));
      this.root.replaceChildren(panel);
    });
  }

  showControls(): void {
    this.show(() => {
      const panel = el('div', 'panel');
      panel.append(el('h2', '', t('menu.controls')));
      const table = el('div', 'controls');
      const rows: [string, StringKey][] = [
        ['Mouse', 'ctl.mouse'],
        ['W / S · 1–4', 'ctl.throttle'],
        ['A / D · Q / E', 'ctl.roll'],
        ['↑ ↓ ← →', 'ctl.arrows'],
        ['Z', 'ctl.level'],
        ['LMB / Space', 'ctl.fire'],
        ['RMB / F', 'ctl.torpedo'],
        ['R', 'ctl.target'],
        ['G', 'ctl.targetAttacker'],
        ['X', 'ctl.sfoils'],
        ['V', 'ctl.deflectors'],
        ['T', 'ctl.computer'],
        ['B', 'ctl.lookBack'],
        ['C', 'ctl.camera'],
        ['H', 'ctl.hud'],
        ['Enter', 'ctl.confirm'],
        ['N', 'ctl.skipStep'],
        ['Esc / P', 'ctl.pause'],
        ['Gamepad', 'ctl.gamepad'],
      ];
      for (const [k, d] of rows) table.append(el('kbd', '', k), el('span', '', t(d)));
      panel.append(table, this.button(t('menu.back'), () => (this.back ?? (() => this.showTitle()))()));
      this.root.replaceChildren(panel);
    });
  }

  /** Mission card: briefing text, difficulty choice, launch. */
  showCard(level: LevelDef, difficulty: Difficulty, onGo: () => void): void {
    this.setKeys((e) => {
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this.setKeys(null);
        onGo();
      }
    });
    this.show(() => {
      const panel = el('div', 'panel card');
      const idx = this.campaign.filter((id) => this.levels.find((l) => l.id === id)?.kind === 'mission').indexOf(level.id);
      const pre = level.kind === 'training' ? t('menu.training') : `${t('menu.mission')} ${idx + 1}`;
      panel.append(el('div', 'pre', pre), el('h2', '', t(level.titleKey)), el('div', 'subtitle', t(level.subKey)), el('p', 'intro', t(level.introKey)));
      if (level.controlsKey) panel.append(el('p', 'tip', t(level.controlsKey)));
      const diff = el('div', 'field');
      diff.append(el('span', '', t('set.difficulty')), this.difficultyChips((d) => this.h.setDifficulty(d)));
      panel.append(diff, el('div', 'foot', t(`set.diff.${difficulty}.desc` as StringKey)));
      panel.append(
        this.button(
          t('menu.launch'),
          () => {
            this.setKeys(null);
            onGo();
          },
          true,
        ),
        el('div', 'foot', t('menu.launchHint')),
      );
      this.root.replaceChildren(panel);
    });
  }

  showPause(checkpoints: { key: StringKey; value: number }[] | undefined, current: number): void {
    this.back = () => this.showPause(checkpoints, current);
    this.show(() => {
      const panel = el('div', 'panel');
      panel.append(el('h2', '', t('menu.paused')));
      const nav = el('div', 'nav');
      nav.append(this.button(t('menu.resume'), () => this.h.resume(), true), this.button(t('menu.restart'), () => this.h.restart(current)));
      for (const cp of checkpoints ?? []) if (cp.value !== current) nav.append(this.button(t(cp.key), () => this.h.restart(cp.value)));
      nav.append(
        this.button(t('menu.settings'), () => this.showSettings()),
        this.button(t('menu.controls'), () => this.showControls()),
        this.button(t('menu.quit'), () => this.h.quit()),
      );
      panel.append(nav);
      this.root.replaceChildren(panel);
    });
  }

  private statsTable(s: LevelStats, extra: [StringKey, string][] = []): HTMLElement {
    const box = el('div', 'stats');
    const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
    const m = Math.floor(s.time / 60);
    const sec = Math.floor(s.time % 60);
    const rows: [StringKey, string][] = [
      ['res.time', `${m}:${String(sec).padStart(2, '0')}`],
      ['res.kills', String(s.kills)],
      ['res.towers', String(s.towers)],
      ['res.accuracy', `${acc}%`],
      ...extra,
    ];
    if (s.forceUsed) rows.push(['res.force', '✓']);
    rows.push(['res.score', String(s.score)]);
    for (const [k, v] of rows) box.append(el('span', '', t(k)), el('b', '', v));
    return box;
  }

  showResult(level: LevelDef, stats: LevelStats, r: { hull: number; bonus: number; rank: Rank; best: boolean }, hasNext: boolean): void {
    this.setKeys((e) => {
      if (e.code === 'Enter' && hasNext) {
        this.setKeys(null);
        this.h.next();
      }
    });
    this.show(() => {
      const panel = el('div', 'panel card');
      const head = el('div', 'result-head');
      head.append(el('div', `rank-big rank-${r.rank}`, r.rank));
      const titles = el('div');
      titles.append(el('div', 'pre', t('res.complete')), el('h2', '', t(level.titleKey)));
      if (r.best) titles.append(el('div', 'best', t('res.newBest')));
      head.append(titles);
      panel.append(head, this.statsTable(stats, [['res.hull', `${Math.round(r.hull)}%`], ['res.bonus', `+${r.bonus}`]]));
      const nav = el('div', 'nav');
      if (hasNext) nav.append(this.button(t('res.next'), () => this.h.next(), true));
      nav.append(this.button(t('menu.restart'), () => this.h.restart(0), !hasNext), this.button(t('menu.quit'), () => this.h.quit()));
      panel.append(nav);
      this.root.replaceChildren(panel);
    });
  }

  showFail(reason: StringKey, checkpoints: { key: StringKey; value: number }[] | undefined, current: number): void {
    this.setKeys((e) => {
      if (e.code === 'Enter') {
        this.setKeys(null);
        this.h.restart(current);
      }
    });
    this.show(() => {
      const panel = el('div', 'panel card fail');
      panel.append(el('div', 'pre', t('res.failed')), el('h2', '', t(reason)));
      const nav = el('div', 'nav');
      nav.append(this.button(t('res.retry'), () => this.h.restart(current), true));
      for (const cp of checkpoints ?? []) if (cp.value !== current) nav.append(this.button(t(cp.key), () => this.h.restart(cp.value)));
      nav.append(this.button(t('menu.quit'), () => this.h.quit()));
      panel.append(nav);
      this.root.replaceChildren(panel);
    });
  }

  showEnding(total: LevelStats, rank: Rank): void {
    this.setKeys(null);
    this.show(() => {
      const panel = el('div', 'panel card ending');
      const head = el('div', 'result-head');
      const titles = el('div');
      titles.append(el('div', 'pre', t('end.pre')), el('h2', '', t('end.title')));
      head.append(el('div', `rank-big rank-${rank}`, rank), titles);
      panel.append(head, el('p', 'intro', t('end.ceremony')), el('p', 'intro', t('end.medal')), this.statsTable(total));
      panel.append(el('p', 'tip', t('end.thanks')), this.button(t('menu.quit'), () => this.h.quit(), true));
      this.root.replaceChildren(panel);
    });
  }

  /** Loading notice while a level builds. */
  showLoading(): void {
    this.show(() => this.root.replaceChildren(el('div', 'loading', t('menu.loading'))));
  }
}
