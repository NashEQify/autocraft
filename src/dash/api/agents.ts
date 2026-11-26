// Agent runs and rates over JSON; everyone signed in reads. Refused runs and their counts are for operators and maintainers.
import type { AgentRunFilter, AgentRunState, RefusalWindow } from "../../../web/src/api/types.ts";
import { getRun, listRuns, rates as ratesOf, refusals as refusalsOf, RunQueryError } from "../../agents/runs.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { hiddenRepos } from "./visible.ts";
import { canSeeInternals } from "./staff.ts";
import { SECURITY_STEP } from "../../security/rules.ts";
import type { Db } from "../../db/index.ts";

const wrap = async <T>(f: () => Promise<T | Promise<T>>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RunQueryError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

function intParam(req: Req, name: string): number | undefined {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d{1,6}$/.test(v)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(v);
}

export const list = async (db: Db, req: Req) => wrap(async () => {
  const q = (k: string) => req.query.get(k) || undefined;
  const f: AgentRunFilter = {
    state: q("state") as AgentRunState | "recent" | undefined, step: q("step"), repo: q("repo"), cursor: q("cursor"), limit: intParam(req, "limit"),
    refused: req.query.get("refused") === "1" || undefined, window: q("window") as RefusalWindow | undefined,
  };
  return await listRuns(db, f, await hiddenRepos(db, req), canSeeInternals(req));
});

// The prompt and output texts hold item and comment text verbatim: operators and maintainers only.
export const detail = async (db: Db, req: Req) => wrap(async () => {
  if (!/^\d{1,15}$/.test(req.params.id ?? "")) throw new HttpError(400, "not a run id");
  return await getRun(db, Number(req.params.id), { hidden: await hiddenRepos(db, req), texts: canSeeInternals(req) });
});

export const rates = async (db: Db, req: Req) => wrap(async () => {
  const r = await ratesOf(db, req.query.get("window") ?? "24h", Date.now(), await hiddenRepos(db, req));
  return canSeeInternals(req) ? r : { ...r, stages: r.stages.filter((s) => s.step !== SECURITY_STEP) };
});

// Which runs a safety filter declined, by whom and on what: operators and maintainers only, like the errors themselves.
export const refusals = async (db: Db, req: Req) => wrap(async () => {
  if (!canSeeInternals(req)) throw new HttpError(403, "operators and maintainers only");
  return await refusalsOf(db, req.query.get("window") ?? "7d", await hiddenRepos(db, req));
});
