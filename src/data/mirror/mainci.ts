// Main-branch CI heads (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import type { HiddenRepos, LatestMainHead, MainHead, MainHeadRow } from "./types.ts";

/** Batched upsert keeping the state change time while the state is unchanged, plus a prune to the newest 50 heads per repo; returns the state per "repo@sha". The caller classifies the state. */
export async function saveMainHeads(db: Db, heads: MainHead[], at: string): Promise<Map<string, string>> {
  throw new Error("not built: mirror.saveMainHeads");
}

/** Every stored head per repo. */
export async function loadMainCi(db: Db, o?: { repos?: string[]; hiddenOk?: HiddenRepos }): Promise<Map<string, MainHeadRow[]>> {
  throw new Error("not built: mirror.loadMainCi");
}

/** Heads keyed "repo@sha". */
export async function loadMainCiAt(db: Db, pairs: { repo: string; sha: string }[]): Promise<Map<string, MainHeadRow>> {
  throw new Error("not built: mirror.loadMainCiAt");
}

/** The latest head per repo. */
export async function loadLatestMainHeads(db: Db, repos?: string[]): Promise<Map<string, LatestMainHead>> {
  throw new Error("not built: mirror.loadLatestMainHeads");
}
