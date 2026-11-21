// Kind, state and title of mirrored items, for rows that show an item reference.
import type { ItemRef, ItemShown, ItemState } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import { inTuples } from "../../db/portable.ts";

const STATE: Record<string, ItemState> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };
export const itemState = (s: string | null | undefined): ItemState => STATE[s ?? ""] ?? "open";

export function shownLookup(db: Db): (repo: string, number: number) => Promise<ItemShown> {
  const q = db.prepare("SELECT kind, state, title FROM items WHERE repo = ? AND number = ?");
  return async (repo, number) => {
    const r = await q.get(repo, number) as { kind: string; state: string; title: string | null } | undefined;
    return r ? { kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state), title: r.title } : { kind: null, state: null, title: null };
  };
}

const NONE: ItemShown = { kind: null, state: null, title: null };

/** Kind, state and title of many items in one read, by `repo#number`; items not mirrored are left out. */
export async function shownMap(db: Db, refs: Iterable<{ repo: string; number: number }>): Promise<Map<string, ItemShown>> {
  const keys = new Map<string, [string, number]>();
  for (const r of refs) keys.set(`${r.repo}#${r.number}`, [r.repo, r.number]);
  const out = new Map<string, ItemShown>();
  if (!keys.size) return out;
  const rows = await db.prepare(`SELECT repo, number, kind, state, title FROM items WHERE ${inTuples(db, ["repo", "number"], "?", ["text", "bigint"])}`)
    .all(JSON.stringify([...keys.values()])) as { repo: string; number: number; kind: string; state: string; title: string | null }[];
  for (const r of rows) out.set(`${r.repo}#${r.number}`, { kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state), title: r.title });
  return out;
}

/**
 * Item references whose kind, state and title are read in one query: `item` returns the reference at once with empty fields,
 * and `fill` sets them on every reference handed out so far. Call `fill` before the references are read.
 */
export function shownLater(db: Db): { item: (repo: string, number: number) => ItemRef & ItemShown; fill: () => Promise<void> } {
  const made: (ItemRef & ItemShown)[] = [];
  return {
    item: (repo, number) => {
      const r = { repo, number, ...NONE };
      made.push(r);
      return r;
    },
    fill: async () => {
      const got = await shownMap(db, made);
      for (const r of made) Object.assign(r, got.get(`${r.repo}#${r.number}`) ?? NONE);
    },
  };
}

export const withShown = async (db: Db, refs: ItemRef[], known?: Map<string, ItemShown>): Promise<(ItemRef & ItemShown)[]> => {
  const got = known ?? await shownMap(db, refs);
  return refs.map((r) => ({ ...r, ...(got.get(`${r.repo}#${r.number}`) ?? NONE) }));
};
