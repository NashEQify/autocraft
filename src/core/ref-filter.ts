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

/** SQL condition: the row of alias `a` is one of the pairs bound to `param` (a refPairs list). */
export const refIn = (a: string, param = ":refs"): string => `(${a}.repo, ${a}.number) IN (SELECT value ->> 0, value ->> 1 FROM json_each(${param}))`;
