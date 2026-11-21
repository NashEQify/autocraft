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
