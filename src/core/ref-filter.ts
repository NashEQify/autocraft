import type { Dialect } from "../db/index.ts";

// Item filters by "repo#number" refs as a row-value IN over a JSON list of [repo, number] pairs, so SQLite looks the few refs
// up through the (repo, number) keys instead of comparing a built string on every row.

/** The JSON list of [repo, number] pairs for `refs` ("repo#number"); unreadable refs are left out. */
export function refPairs(refs: Iterable<string>): string {
  const out: [string, number][] = [];
  for (const ref of refs) {
    const i = ref.lastIndexOf("#");
    const n = Number(ref.slice(i + 1));
    if (i > 0 && Number.isInteger(n)) out.push([ref.slice(0, i), n]);
  }
  return JSON.stringify(out);
}

/**
 * A FROM item over the pairs bound to `param` (a refPairs list), named `alias`, with the SQL for each pair's repo and
 * number. Postgres reads the elements as JSON values, so `->>` applies to them as SQLite's json_each values.
 */
export function pairsFrom(d: Dialect | { readonly dialect: Dialect }, param: string, alias: string): { from: string; repo: string; number: string } {
  const pg = (typeof d === "string" ? d : d.dialect) === "postgres";
  return pg
    ? { from: `json_array_elements((${param})::json) AS ${alias}(value)`, repo: `${alias}.value ->> 0`, number: `(${alias}.value ->> 1)::bigint` }
    : { from: `json_each(${param}) ${alias}`, repo: `${alias}.value ->> 0`, number: `${alias}.value ->> 1` };
}

/** SQL condition: the row of alias `a` is one of the pairs bound to `param` (a refPairs list). */
export function refIn(d: Dialect | { readonly dialect: Dialect }, a: string, param = ":refs"): string {
  if ((typeof d === "string" ? d : d.dialect) !== "postgres") return `(${a}.repo, ${a}.number) IN (SELECT value ->> 0, value ->> 1 FROM json_each(${param}))`;
  const p = pairsFrom(d, param, "rp");
  return `(${a}.repo, ${a}.number) IN (SELECT ${p.repo}, ${p.number} FROM ${p.from})`;
}
