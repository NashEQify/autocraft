// Protection of model spend from authors outside the team (docs/pipeline.md, "Outside authors"). The rules and every query live in
// src/data/intake; this file keeps the names feature code calls, and the one policy the module takes as an argument: which author
// accounts the Contributors rule whitelists.
import type { OutsideHoldInfo } from "./core/plan.ts";
import { tierOf } from "./whitelist.ts";
import type { Db } from "./db/index.ts";
import * as intake from "./data/intake/index.ts";
import type { HiddenRepos, Hold, OutsideLimits, OutsideState, WhitelistInput } from "./data/intake/index.ts";

export { OutsideError, OUTSIDE_SURGE } from "./data/intake/index.ts";
export type { Hold, OutsideLimits, OutsideState } from "./data/intake/index.ts";
export type OutsideRefresh = { holds: Hold[]; tripped: boolean; wakeAt: number | null };

/**
 * The whitelist verdicts of `input.authors`: the history and the allow override count for the account the author stands for (the id the
 * item carries, else the account the login is bound to); a deny holds for every account under the login.
 */
// NEEDS whitelist.verdict (C11): this is the pure policy of src/whitelist.ts `standings` and `whitelistedOf` over loaded data.
export function whitelistPolicy(input: WhitelistInput): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const a of input.authors) {
    const owner = input.bound.get(a.login);
    const account = a.id ?? owner ?? null;
    let merged = 0, closed = 0;
    if (account !== null) for (const h of input.history) if (h.login === a.login && (h.author_id === account || (h.author_id === null && owner === account))) { merged += h.merged; closed += h.closed; }
    const o = input.overrides.get(a.login.toLowerCase());
    const override = o?.status === "deny" ? "deny" : o?.status === "allow" && account !== null && o.githubId === account ? "allow" : null;
    out.set(`${a.login}\0${a.id ?? ""}`, override === "allow" || (override !== "deny" && tierOf(merged, closed, null, input.rule) === "whitelisted"));
  }
  return out;
}

export async function refreshOutsideHolds(db: Db, now: number = Date.now()): Promise<OutsideRefresh> {
  return await intake.recomputeHolds(db, { now, whitelist: whitelistPolicy });
}

/** Stores the three numbers (0 turns a protection off) and audits the change. */
export async function setOutsideLimits(db: Db, by: string, input: unknown): Promise<OutsideLimits> {
  return await intake.saveOutsideLimits(db, by, input);
}

export const holdWait = intake.holdWait;

/** The holds of the items the planner decides, as `repo#number` to their reason. */
// NEEDS intake.loadHolds all-rows form: the pass descriptor stands for every item the planner decides, which holds the in-scope items only.
export async function holdMap(db: Db): Promise<Map<string, OutsideHoldInfo>> {
  return await intake.loadHolds(db, { mode: "full" });
}

/** An operator exempts one held item from both holds. */
export async function releaseOutside(db: Db, by: string, repo: string, number: number): Promise<void> {
  await intake.releaseHeld(db, by, [{ repo, number }]);
}

/** An operator exempts every item now held for one author. Returns how many. */
export const releaseAuthor = intake.releaseAuthor;

export async function outsideState(db: Db, hidden: HiddenRepos = []): Promise<OutsideState> {
  return await intake.loadOutsideState(db, hidden);
}

/** Whether a PR or issue row is by an outside author. `inside` may be passed when many rows are judged. */
export async function isOutsideAuthor(db: Db, r: { author: string | null; author_association: string | null; author_type: string | null }, inside?: Set<string>): Promise<boolean> {
  return intake.isOutsideAuthor(r, inside ?? await intake.loadInsiders(db));
}
