// Agent runs and rates over JSON, and the usage pause and Jev switch. Everyone signed in reads; only operators change a setting.
import type { AgentRunFilter, AgentRunState, JevStatus, UsagePause } from "../../../web/src/api/types.ts";
import { jevEnabled, jevOutage, setJevEnabled } from "../../agents/jev.ts";
import { getRun, listRuns, rates as ratesOf, RunQueryError } from "../../agents/runs.ts";
import { loadLiveConfig, saveSettings } from "../../data/control/index.ts";
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

const validPct = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100;

export const getPause = async (db: Db): Promise<UsagePause> => (await loadLiveConfig(db)).usagePause;
export const putPause = async (db: Db, req: Req): Promise<UsagePause> => {
  const v = req.json as Partial<UsagePause> | null;
  if (!v || typeof v !== "object" || !validPct(v.fiveHour) || !validPct(v.weekly)) throw new HttpError(400, "pause levels must be whole numbers from 1 to 100");
  const was = await getPause(db), next = { fiveHour: v.fiveHour, weekly: v.weekly };
  if (next.fiveHour !== was.fiveHour || next.weekly !== was.weekly) {
    await saveSettings(db, [{ key: "usage_pause", value: JSON.stringify(next) }], req.user.login, { action: "account-change", target: "usage-pause", details: { ...next, was } });
  }
  return next;
};

export const getJev = async (db: Db): Promise<JevStatus> => {
  const o = await jevOutage(db);
  return { enabled: await jevEnabled(db), unavailable: o ? { reason: o.reason, since: o.since } : null };
};
export const putJev = async (db: Db, req: Req) => wrap(async () => {
  const enabled = (req.json as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  await setJevEnabled(db, enabled, req.user.login);
  return await getJev(db);
});

function intParam(req: Req, name: string): number | undefined {
  const v = req.query.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d{1,6}$/.test(v)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(v);
}

export const list = async (db: Db, req: Req) => wrap(async () => {
  const q = (k: string) => req.query.get(k) || undefined;
  const f: AgentRunFilter = {
    state: q("state") as AgentRunState | "recent" | undefined, step: q("step"), account: q("account"), repo: q("repo"), cursor: q("cursor"), limit: intParam(req, "limit"),
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
