// GET /api/flow: the pipeline as a flowchart for the home page. Adds up the
// per-repo summary rows (src/flow/summary.ts), which the runner keeps current,
// and shapes them into nodes and edges (src/flow/shape.ts). Read-only, anyone signed in.
import type { Flow } from "../../../web/src/api/types.ts";
import { classifyRun as latestRun } from "../../data/triage/index.ts";
import { branchMembers, type Refs } from "../../flow/count.ts";
import { buildFlow } from "../../flow/shape.ts";
import { readSummary } from "../../flow/summary.ts";
import type { Req } from "../types.ts";
import { needVisible, visibleRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";

export async function flow(db: Db, req: Req): Promise<Flow> {
  const repo = req.query.get("repo") || null;
  if (repo) await needVisible(db, req, repo);
  const { counts, countedAt, uncounted } = await readSummary(db, repo, undefined, await visibleRepos(db, req));
  const lastSync = (await db.get(db.k.selectFrom("sync_runs").select((eb) => eb.fn.max<string | null>("ended_at").as("t")).where("error", "is", null)))!.t
    ?? (await db.get(db.k.selectFrom("settings").select("value as t").where("key", "=", "org_high_water")))?.t ?? null;
  return buildFlow(counts, { repo, now: new Date().toISOString(), lastSync, run: await latestRun(db), countedAt, uncounted: uncounted.length });
}

// The Items browser asks for the same branch page after page; its refs are kept briefly.
const picks = new WeakMap<Db, { key: string; at: number; refs: Refs | null }>();
const PICK_MAX_AGE = 30_000;

/** The refs a `flow=<node>.<branch>` filter of the Items browser picks, or null for a key that names no item-backed branch. */
export async function flowMembers(db: Db, key: string): Promise<Refs | null> {
  const hit = picks.get(db);
  if (hit && hit.key === key && Date.now() - hit.at < PICK_MAX_AGE) return hit.refs;
  const refs = await branchMembers(db, key);
  picks.set(db, { key, at: Date.now(), refs });
  return refs;
}
