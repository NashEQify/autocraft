// Loaders of attempts and rounds.
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ImplementFacts, ImplementStamp, ImplementationView, RefKey, StuckStreakRow } from "./types.ts";

/**
 * The latest attempt per issue and per PR, question and answer state, revise heads and per-text attempt counts. Keys may be
 * issue refs or PR refs; the loader matches either. 3 statements in one `together` wave.
 */
export async function loadImplementFacts(db: Db, keys: KeySource, o?: { repos?: string[]; withPlans?: boolean }): Promise<ImplementFacts> { throw new Error("not built: implement.loadImplementFacts"); }
/** All attempts of the issue and the rounds of the latest one, for the item page and CLI. 2 statements in one wave. */
export async function loadImplementationView(db: Db, ref: RefKey): Promise<ImplementationView | null> { throw new Error("not built: implement.loadImplementationView"); }
/** The newest `plan` round's reply text with that `call_id`. */
export async function loadPlanReplyOfCall(db: Db, callId: number): Promise<string | null> { throw new Error("not built: implement.loadPlanReplyOfCall"); }
/** Fingerprints of attempts and rounds per item for the item page's "did anything change" probe. 2 statements. */
export async function loadImplementStamps(db: Db, keys: KeySource): Promise<Map<RefKey, ImplementStamp>> { throw new Error("not built: implement.loadImplementStamps"); }
/** The repo of each implementation id, for the visibility check of a screenshot. */
export async function loadImplementationRepos(db: Db, ids: number[]): Promise<Map<number, string>> { throw new Error("not built: implement.loadImplementationRepos"); }
/** Attempts not ended with a PR. */
export async function listLivePrs(db: Db): Promise<{ repo: string; number: number; prNumber: number }[]> { throw new Error("not built: implement.listLivePrs"); }
/** The newest `n` finished attempts per repo after the repo's `since` that ended in a PR or in `stuck`/`failed`. */
export async function loadStuckStreaks(db: Db, sinceByRepo: Map<string, string>, n: number): Promise<Map<string, StuckStreakRow[]>> { throw new Error("not built: implement.loadStuckStreaks"); }
