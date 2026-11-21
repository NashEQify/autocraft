// Parameter placeholders in SQLite-dialect statement text, for backends that number parameters themselves (Postgres
// `$n`). The binder follows node:sqlite's rules, so a statement binds the same values on both backends.
import type { NamedParams, Param } from "./index.ts";

/** Statement text split at its placeholders: `parts[0] slot[0] parts[1] ... parts[n]`. `index` is SQLite's parameter number. */
export interface ParsedParams {
  parts: string[];
  slots: { index: number; name?: string }[];
  /** Highest parameter number. */
  count: number;
  /** Parameter number of each named parameter, by its bare name. */
  names: Map<string, number>;
}

const ident = /[A-Za-z0-9_]/;

/** Finds the placeholders outside string literals, quoted identifiers and comments. */
export function parseParams(text: string): ParsedParams {
  const parts: string[] = [];
  const slots: ParsedParams["slots"] = [];
  const names = new Map<string, number>();
  let count = 0, start = 0, i = 0;
  const skipTo = (close: string, from: number): number => {
    const j = text.indexOf(close, from);
    return j < 0 ? text.length : j + close.length;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === "`") {
      // A doubled quote inside is an escaped quote: the scan just continues after it.
      i = skipTo(c, i + 1);
    } else if (c === "[") i = skipTo("]", i + 1);
    else if (c === "-" && text[i + 1] === "-") i = skipTo("\n", i + 2);
    else if (c === "/" && text[i + 1] === "*") i = skipTo("*/", i + 2);
    else if (c === ":" && text[i + 1] === ":") i += 2; // a Postgres cast
    else if (c === "?") {
      let j = i + 1;
      while (j < text.length && text[j]! >= "0" && text[j]! <= "9") j++;
      const index = j > i + 1 ? Number(text.slice(i + 1, j)) : count + 1;
      count = Math.max(count, index);
      parts.push(text.slice(start, i));
      slots.push({ index });
      start = i = j;
    } else if ((c === ":" || c === "@" || c === "$") && /[A-Za-z_]/.test(text[i + 1] ?? "") && !ident.test(text[i - 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && ident.test(text[j]!)) j++;
      const name = text.slice(i + 1, j);
      let index = names.get(name);
      if (index === undefined) names.set(name, (index = ++count));
      parts.push(text.slice(start, i));
      slots.push({ index, name });
      start = i = j;
    } else i++;
  }
  parts.push(text.slice(start));
  return { parts, slots, count, names };
}

/** The text with each placeholder replaced by `render(position)` (0-based, one per parameter number) and its values in that order. */
export function bindParams(p: ParsedParams, args: readonly (Param | NamedParams)[], render: (position: number) => string): { text: string; values: Param[] } {
  const values: Param[] = new Array<Param>(p.count).fill(null);
  const named = new Set(p.names.values());
  let rest = args;
  const first = args[0];
  if (first !== null && typeof first === "object" && !ArrayBuffer.isView(first)) {
    rest = args.slice(1);
    for (const [key, v] of Object.entries(first)) {
      const index = p.names.get(/^[:@$]/.test(key) ? key.slice(1) : key);
      if (index === undefined) throw new Error(`Unknown named parameter '${key}'`);
      values[index - 1] = v;
    }
  }
  // Anonymous values fill parameter numbers 1, 2, ... in order, skipping the named ones (node:sqlite's rule).
  let index = 1;
  for (const v of rest) {
    while (named.has(index)) index++;
    if (index > p.count) throw new RangeError("Too many parameters");
    values[index - 1] = v as Param;
    index++;
  }
  let text = p.parts[0]!;
  p.slots.forEach((s, k) => (text += render(s.index - 1) + p.parts[k + 1]!));
  return { text, values };
}

/** The text with string literals, quoted identifiers and comments blanked out (same length), for matching keywords in code only. */
function codeOnly(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const skipTo = (close: string, from: number): number => {
    const j = text.indexOf(close, from);
    return j < 0 ? text.length : j + close.length;
  };
  while (i < text.length) {
    const c = text[i]!;
    let end = -1;
    if (c === "'" || c === '"' || c === "`") end = skipTo(c, i + 1);
    else if (c === "[") end = skipTo("]", i + 1);
    else if (c === "-" && text[i + 1] === "-") end = skipTo("\n", i + 2);
    else if (c === "/" && text[i + 1] === "*") end = skipTo("*/", i + 2);
    if (end < 0) i++;
    else {
      blank(i + 1, end - 1 > i ? end - 1 : end);
      i = end;
    }
  }
  return out.join("");
}

/**
 * Rewrites SQLite-only statement text for Postgres: drops the `main.`/`temp.` schema prefixes and turns
 * `INSERT OR IGNORE INTO ...` into `INSERT INTO ... ON CONFLICT DO NOTHING` (before a trailing RETURNING).
 * `INSERT OR REPLACE` has no mechanical equivalent and throws.
 */
/**
 * `rewriteForPostgres` for each statement of a multi-statement script (statements split on `;` in code only). A script
 * with dollar-quoted bodies (plpgsql) is Postgres DDL already and passes through as written.
 */
export function rewriteScriptForPostgres(text: string): string {
  const code = codeOnly(text);
  if (/\$[A-Za-z_]*\$/.test(code)) return text;
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i <= code.length; i++) {
    if (i < code.length && code[i] !== ";") continue;
    const stmt = text.slice(from, i);
    parts.push(stmt.trim() ? rewriteForPostgres(stmt) : stmt);
    from = i + 1;
  }
  return parts.join(";");
}

export function rewriteForPostgres(text: string): string {
  const code = codeOnly(text);
  const edits: { from: number; to: number; with: string }[] = [];
  for (const m of code.matchAll(/(?<![A-Za-z0-9_.$])(?:main|temp)\s*\./gi)) edits.push({ from: m.index, to: m.index + m[0].length, with: "" });
  const head = /^\s*INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO\b/i.exec(code);
  const describe = () => text.replace(/\s+/g, " ").trim().slice(0, 120);
  if (head) {
    if (head[1]!.toUpperCase() === "REPLACE") throw new Error(`INSERT OR REPLACE is not supported on Postgres; rewrite it by hand: ${describe()}`);
    if (/\bON\s+CONFLICT\b/i.test(code)) throw new Error(`INSERT OR IGNORE with ON CONFLICT: ${describe()}`);
    const orAt = head[0].search(/\bOR\b/i);
    const intoAt = head[0].search(/\bINTO\b/i);
    edits.push({ from: orAt, to: intoAt, with: "" });
    const ret = [...code.matchAll(/\bRETURNING\b/gi)].at(-1);
    const at = (ret?.index ?? text.replace(/[\s;]+$/, "").length);
    edits.push({ from: at, to: at, with: ret ? "ON CONFLICT DO NOTHING " : " ON CONFLICT DO NOTHING" });
  }
  if (!edits.length) return text;
  edits.sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  for (const e of edits) out = out.slice(0, e.from) + e.with + out.slice(e.to);
  return out;
}
