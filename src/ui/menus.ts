// DOM overlays: title, crawl, level select, settings, controls, level cards, pause, results, ending.
import { LANGS, getLang, onLangChange, setLang, t, type Lang, type StringKey } from '../i18n/i18n';
import type { Settings } from '../core/settings';
import type { LevelDef, LevelStats } from '../levels/context';

type Render = () => void;

export interface MenuHandlers {
  startCampaign(): void;
  startLevel(index: number, checkpoint?: number): void;
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

export class Menus {
  readonly root: HTMLDivElement;
  private current: Render | null = null;
  private back: Render | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private levels: LevelDef[],
    private settings: Settings,
    private h: MenuHandlers,
  ) {
    this.root = el('div', 'overlay');
    parent.appendChild(this.root);
    onLangChange(() => this.current?.());
  }

  get visible(): boolean {
    return !this.root.hidden;
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

  showTitle(): void {
    this.back = null;
    this.setKeys(null);
    this.show(() => {
      const panel = el('div', 'title-screen');
      panel.append(el('div', 'pre', t('menu.pre')), el('h1', 'logo', t('menu.title')), el('div', 'subtitle', t('menu.subtitle')));
      const nav = el('div', 'nav');
      nav.append(
        this.button(t('menu.campaign'), () => this.h.startCampaign(), true),
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

  /** "A long time ago..." then the scrolling crawl. Skippable. */
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
      const ago = el('div', 'ago', t('crawl.ago'));
      const crawl = el('div', 'crawl');
      const inner = el('div', 'crawl-inner');
      inner.append(el('div', 'episode', t('crawl.episode')), el('div', 'crawl-title', t('crawl.title')));
      for (const k of ['crawl.p1', 'crawl.p2', 'crawl.p3'] as StringKey[]) inner.append(el('p', '', t(k)));
      crawl.append(inner);
      wrap.append(ago, crawl, el('div', 'skip', t('menu.skip')));
      this.root.replaceChildren(wrap);
      inner.addEventListener('animationend', finish);
    });
  }

  showLevelSelect(): void {
    this.show(() => {
      const panel = el('div', 'panel wide');
      panel.append(el('h2', '', t('menu.select')));
      const list = el('div', 'levels');
      this.levels.forEach((lv, i) => {
        const done = this.settings.completed.includes(lv.id);
        const card = el('div', done ? 'level done' : 'level');
        card.append(el('div', 'num', `${i}${done ? ` · ✓ ${t('menu.completed')}` : ''}`), el('div', 'name', t(lv.titleKey)), el('div', 'desc', t(lv.subKey)));
        const row = el('div', 'row');
        row.append(this.button(t('menu.play'), () => this.h.startLevel(i), true));
        for (const cp of lv.checkpoints?.slice(1) ?? []) row.append(this.button(t(cp.key), () => this.h.startLevel(i, cp.value)));
        card.append(row);
        list.append(card);
      });
      panel.append(list, this.button(t('menu.back'), () => this.showTitle()));
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
      row(t('set.difficulty'), select(s.difficulty, [['cadet', 'set.diff.cadet'], ['pilot', 'set.diff.pilot'], ['jedi', 'set.diff.jedi']], (v) => (s.difficulty = v)));
      row(t('set.sensitivity'), range(s.sensitivity, 0.3, 2.5, 0.05, (v) => (s.sensitivity = v)));
      row(t('set.invert'), check(s.invertY, (v) => (s.invertY = v)));
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
        ['W / S', 'ctl.throttle'],
        ['A / D · Q / E', 'ctl.roll'],
        ['↑ ↓ ← →', 'ctl.arrows'],
        ['LMB / Space', 'ctl.fire'],
        ['RMB / F', 'ctl.torpedo'],
        ['R', 'ctl.target'],
        ['X', 'ctl.sfoils'],
        ['V', 'ctl.deflectors'],
        ['T', 'ctl.computer'],
        ['C', 'ctl.camera'],
        ['Enter', 'ctl.confirm'],
        ['Esc / P', 'ctl.pause'],
        ['Gamepad', 'ctl.gamepad'],
      ];
      for (const [k, d] of rows) table.append(el('kbd', '', k), el('span', '', t(d)));
      panel.append(table, this.button(t('menu.back'), () => (this.back ?? (() => this.showTitle()))()));
      this.root.replaceChildren(panel);
    });
  }

  /** Mission card before a level. */
  showCard(level: LevelDef, index: number, onGo: () => void): void {
    this.setKeys((e) => {
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this.setKeys(null);
        onGo();
      }
    });
    this.show(() => {
      const panel = el('div', 'panel card');
      panel.append(el('div', 'pre', `${t('menu.mission')} ${index}`), el('h2', '', t(level.titleKey)), el('div', 'subtitle', t(level.subKey)), el('p', 'intro', t(level.introKey)));
      if (level.controlsKey) panel.append(el('p', 'tip', t(level.controlsKey)));
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

  showPause(): void {
    this.back = () => this.showPause();
    this.show(() => {
      const panel = el('div', 'panel');
      panel.append(el('h2', '', t('menu.paused')));
      const nav = el('div', 'nav');
      nav.append(
        this.button(t('menu.resume'), () => this.h.resume(), true),
        this.button(t('menu.restart'), () => this.h.restart()),
        this.button(t('menu.settings'), () => this.showSettings()),
        this.button(t('menu.controls'), () => this.showControls()),
        this.button(t('menu.quit'), () => this.h.quit()),
      );
      panel.append(nav);
      this.root.replaceChildren(panel);
    });
  }

  private statsTable(s: LevelStats, hull: number): HTMLElement {
    const box = el('div', 'stats');
    const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
    const m = Math.floor(s.time / 60);
    const sec = Math.floor(s.time % 60);
    const rows: [StringKey, string][] = [
      ['res.time', `${m}:${String(sec).padStart(2, '0')}`],
      ['res.kills', String(s.kills)],
      ['res.towers', String(s.towers)],
      ['res.accuracy', `${acc}%`],
      ['res.hull', `${Math.max(0, Math.round(hull))}%`],
    ];
    if (s.forceUsed) rows.push(['res.force', '✓']);
    for (const [k, v] of rows) box.append(el('span', '', t(k)), el('b', '', v));
    return box;
  }

  showResult(level: LevelDef, stats: LevelStats, hull: number, hasNext: boolean): void {
    this.setKeys((e) => {
      if (e.code === 'Enter' && hasNext) {
        this.setKeys(null);
        this.h.next();
      }
    });
    this.show(() => {
      const panel = el('div', 'panel card');
      panel.append(el('div', 'pre', t('res.complete')), el('h2', '', t(level.titleKey)), this.statsTable(stats, hull));
      const nav = el('div', 'nav');
      if (hasNext) nav.append(this.button(t('res.next'), () => this.h.next(), true));
      nav.append(this.button(t('menu.restart'), () => this.h.restart()), this.button(t('menu.quit'), () => this.h.quit()));
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
      if (checkpoints) for (const cp of checkpoints) if (cp.value !== current) nav.append(this.button(t(cp.key), () => this.h.restart(cp.value)));
      nav.append(this.button(t('menu.quit'), () => this.h.quit()));
      panel.append(nav);
      this.root.replaceChildren(panel);
    });
  }

  showEnding(total: LevelStats): void {
    this.setKeys(null);
    this.show(() => {
      const panel = el('div', 'panel card ending');
      panel.append(el('div', 'pre', t('end.pre')), el('h2', '', t('end.title')), el('p', 'intro', t('end.ceremony')), el('p', 'intro', t('end.medal')));
      panel.append(this.statsTable(total, 100));
      panel.append(el('p', 'tip', t('end.thanks')));
      panel.append(this.button(t('menu.quit'), () => this.h.quit(), true));
      this.root.replaceChildren(panel);
    });
  }

  /** Loading notice while a level builds. */
  showLoading(): void {
    this.show(() => {
      this.root.replaceChildren(el('div', 'loading', t('menu.loading')));
    });
  }
}
