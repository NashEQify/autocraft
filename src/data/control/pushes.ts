// Push outcomes (M06 control-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { NewPush, PushFacts, PushOutcomeRow } from "./types.ts";

/** Loads the "before" result in one wave, then one multi-row `INSERT ... SELECT ... WHERE NOT EXISTS` keeping the once-per `(repo, number, to_oid, action)` rule; actions without a push stage are skipped. */
export async function addPushOutcomes(db: Db, pushes: NewPush[]): Promise<void> {
  throw new Error("not built: control.addPushOutcomes");
}

/** Settles pending outcomes from freshly stored checks, closes those of closed or moved items, expires old ones, then evaluates the breakers. */
export async function resolvePushes(db: Db, rows: { repo: string; number: number; head_oid: string; checks: string }[], at?: string): Promise<void> {
  throw new Error("not built: control.resolvePushes");
}

/** The circuit breaker for a batch: three reads in one wave, the decision in memory, one `tripStage` call. */
export async function evaluatePushBreakers(db: Db, pairs: { stage: string; repo: string }[], at?: string): Promise<string[]> {
  throw new Error("not built: control.evaluatePushBreakers");
}

/** Unsettled pushes still waiting for required checks, per repo. */
export async function pushesUnsettled(db: Db, repos: string[], now?: number): Promise<Map<string, number>> {
  throw new Error("not built: control.pushesUnsettled");
}

/** Per PR: the heads we pushed or moved off, when each was moved off, and the head our latest push broke. */
export async function loadPushFacts(db: Db, keys: { repo: string; number: number }[] | KeySource): Promise<Map<string, PushFacts>> {
  throw new Error("not built: control.loadPushFacts");
}

/** Latest `to_oid` per `(ref, from_oid)`. */
export async function loadPushOutcomeEdges(db: Db, keys: { repo: string; number: number }[] | KeySource): Promise<Map<string, Map<string, string>>> {
  throw new Error("not built: control.loadPushOutcomeEdges");
}

/** Read model for the trace and activity pages. */
export async function listPushOutcomes(db: Db, f: { refs?: string[]; since?: string; limit?: number }): Promise<PushOutcomeRow[]> {
  throw new Error("not built: control.listPushOutcomes");
}

/** Counts per item. */
export async function countPushOutcomes(db: Db, refs: string[]): Promise<Map<string, { n: number; newest: number; done: boolean }>> {
  throw new Error("not built: control.countPushOutcomes");
}
