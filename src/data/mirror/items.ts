// Item loaders (M01 mirror-a).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ItemFilter, ItemHit, ItemOf, ItemPreset, ItemShown, OpenPrRow, PrMirror, RefKey, HiddenRepos } from "./types.ts";

/** Rows of the preset's columns for each key; a missing key is absent. One statement (one per 10,000 refs for a list). With `alone` a whole-repo `text` or `full` load is never fused into a `together` wave. */
export async function loadItems<P extends ItemPreset>(db: Db, keys: KeySource, preset: P, opts?: { alone?: boolean }): Promise<Map<RefKey, ItemOf<P>>> {
  throw new Error("not built: mirror.loadItems");
}

/** Items matching the filter, ordered by repo and number; one statement. */
export async function listItems<P extends ItemPreset>(db: Db, filter: ItemFilter, preset: P): Promise<ItemOf<P>[]> {
  throw new Error("not built: mirror.listItems");
}

/** Open item numbers per repo. */
export async function loadOpenNumbers(db: Db, repos: string[], kind?: "pr" | "issue"): Promise<Map<string, number[]>> {
  throw new Error("not built: mirror.loadOpenNumbers");
}

/** The `pr` preset joined to `pr_checks`; `checks.checks` text only when `overall` is failure. */
export async function loadPrMirror(db: Db, keys: KeySource): Promise<Map<RefKey, PrMirror>> {
  throw new Error("not built: mirror.loadPrMirror");
}

/** Open PRs whose head is another open PR's base, keyed "repo headRef headRepoLower". */
export async function loadStackedHeads(db: Db, repos: string[]): Promise<Map<string, number[]>> {
  throw new Error("not built: mirror.loadStackedHeads");
}

/** Open PRs with author, closing issues and text refs; title and body only where `text_refs` is null. */
export async function loadOpenPrLinks(db: Db, repos?: string[]): Promise<OpenPrRow[]> {
  throw new Error("not built: mirror.loadOpenPrLinks");
}

/** Item counts grouped by one column (one total when `by` is omitted). */
export async function countItems(db: Db, filter: ItemFilter, by?: "repo" | "kind" | "state"): Promise<Map<string, number>> {
  throw new Error("not built: mirror.countItems");
}

/** Kind, state and title of the referenced items; no per-key fallback read. */
export async function loadShown(db: Db, keys: KeySource): Promise<Map<RefKey, ItemShown>> {
  throw new Error("not built: mirror.loadShown");
}

/** Full-text item search, best first. */
export async function searchItems(db: Db, search: string, opts: { repos?: string[]; kind?: "pr" | "issue"; limit?: number; hidden?: HiddenRepos; snippets?: boolean }): Promise<ItemHit[]> {
  throw new Error("not built: mirror.searchItems");
}
