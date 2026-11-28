// User-facing text keyed by its English wording. `t("Stopped by {login}.", { login })` returns the active locale's
// translation of the key, or the English key itself when there is none, with `{name}` placeholders filled in. Translations
// come from craft-i18n through setTranslations; this module holds none. Plain code with no imports, so the dashboard bundle
// and the server both load it.
//
// Keys are string literals at the call: `t("...")` where the text is shown, `tk("...")` where it is only stored (a help
// line in a table, rendered later through t()). extractKeys reads both from source text, so the catalogue for translators is
// built from the code and never drifts from it.

export type Params = Record<string, string | number>;

const tables = new Map<string, Record<string, string>>();
let active = "en";

/** Adds or replaces a locale's translations, keyed by the English text. */
export function setTranslations(locale: string, table: Record<string, string>): void {
  tables.set(locale, { ...tables.get(locale), ...table });
}

/** The locale t() translates into; English, or any locale without a table, shows the keys. */
export function setLocale(locale: string): void {
  active = locale;
}

export const locale = (): string => active;

const fill = (text: string, params?: Params): string =>
  params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : m)) : text;

/** The text for `key` in the active locale, with `{name}` placeholders replaced from `params`. */
export function t(key: string, params?: Params): string {
  const tr = tables.get(active)?.[key];
  return fill(tr ? tr : key, params);
}

/** Marks a literal as a translation key without translating it; the caller passes it to t() when showing it. */
export const tk = <S extends string>(key: S): S => key;

/**
 * The translation keys in source text: the literal first argument of each `t(...)` and `tk(...)` call, in single, double or
 * backtick quotes without `${}`. A key built at run time is not found, which is why keys stay literals.
 */
export function extractKeys(source: string): string[] {
  const out = new Set<string>();
  const re = /(?<![\w$.])tk?\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`)/g;
  for (const m of source.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    out.add(raw.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c)));
  }
  return [...out];
}

/** The catalogue for translators: every key found in the given sources, sorted, each mapped to itself (the English text). */
export function catalogue(sources: Iterable<string>): Record<string, string> {
  const keys = new Set<string>();
  for (const s of sources) for (const k of extractKeys(s)) keys.add(k);
  return Object.fromEntries([...keys].sort().map((k) => [k, k]));
}
