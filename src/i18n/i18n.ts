// Minimal i18n layer. `en` is the source dictionary: its keys define StringKey,
// and every other language must provide the exact same key set (enforced by type).
// Adding a language = add a dictionary file typed as `Dictionary` and register it in LANGS.
import { en } from './en';
import { it } from './it';

export type StringKey = keyof typeof en;
export type Dictionary = Record<StringKey, string>;

export const LANGS = [
  { id: 'en', label: 'English', speech: 'en-US', dict: en as Dictionary },
  { id: 'it', label: 'Italiano', speech: 'it-IT', dict: it },
] as const;

export type Lang = (typeof LANGS)[number]['id'];

const STORAGE_KEY = 'yavin.lang';

function detect(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (LANGS.some((l) => l.id === saved)) return saved as Lang;
  const nav = navigator.language.slice(0, 2).toLowerCase();
  return LANGS.some((l) => l.id === nav) ? (nav as Lang) : 'en';
}

let current: Lang = detect();
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  for (const l of listeners) l(lang);
}

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** BCP-47 tag for speech synthesis of the current language. */
export function speechLang(): string {
  return LANGS.find((l) => l.id === current)!.speech;
}

/** Translate `key`, substituting `{name}` placeholders from `params`. Falls back to English. */
export function t(key: StringKey, params?: Record<string, string | number>): string {
  const dict = LANGS.find((l) => l.id === current)!.dict;
  let s = dict[key] ?? en[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m: string, p: string) => (p in params ? String(params[p]) : m));
  return s;
}

document.documentElement.lang = current;
