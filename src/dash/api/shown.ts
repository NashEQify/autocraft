// Kind, state and title of mirrored items, for rows that show an item reference.
import type { ItemRef, ItemShown, ItemState } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import { loadShown } from "../../data/mirror/index.ts";

const NONE: ItemShown = { kind: null, state: null, title: null };

const STATE: Record<string, ItemState> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };
export const itemState = (s: string | null | undefined): ItemState => STATE[s ?? ""] ?? "open";

/** One item's kind, state and title per call; the items of `preload` are read together, in one query, at the first call that needs one. */
export function shownLookup(db: Db, preload: readonly { repo: string; number: number }[] = []): (repo: string, number: number) => Promise<ItemShown> {
  const keys = new Set<string>();
  for (const r of preload) keys.add(`${r.repo}#${r.number}`);
  let known: Promise<Map<string, ItemShown>> | undefined;
  return async (repo, number) => {
    const key = `${repo}#${number}`;
    if (keys.has(key)) {
      known ??= shownMap(db, preload);
      return { ...((await known).get(key) ?? NONE) };
    }
    return (await loadShown(db, [{ repo, number }])).get(key) ?? { kind: null, state: null, title: null };
  };
}

/** Kind, state and title of many items in one read, by `repo#number`; items not mirrored are left out. */
export async function shownMap(db: Db, refs: Iterable<{ repo: string; number: number }>): Promise<Map<string, ItemShown>> {
  const keys = new Map<string, { repo: string; number: number }>();
  for (const r of refs) keys.set(`${r.repo}#${r.number}`, { repo: r.repo, number: r.number });
  return keys.size ? await loadShown(db, [...keys.values()]) : new Map();
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
