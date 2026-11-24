// Calls for work a person started or approved in the maintainer workflow (src/workflow): every item a queued call names has a
// live workflow in a repo on that workflow whose starter or approver is the person, or is the PR of an issue whose live
// implement workflow they started or approved. Their own Task Runners take such a call first, ahead of automatic work, in
// a slot that counts toward their Max calls at once, and not held back by their cool-off; while one of their runners is
// fresh and offers the call's tier, other users' runners pass the call over (calls.ts claimOrder, takers.ts sweepTakers).
// When none is, any runner takes it under all its own limits.
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { LIVE_STATES } from "../workflow/store.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { acceptedModels, familyOf, isTier } from "./mode.ts";
import type { Tier } from "./protocol.ts";

export type StartedCalls = {
  /** The lowercase logins whose call one with these items is: those that started or approved work on every one of them. */
  owners: (refs: readonly ItemRef[]) => ReadonlySet<string>;
  /** The tiers the lowercase login's fresh Task Runners offer (empty: none is fresh). */
  tiersOf: (login: string) => ReadonlySet<Tier>;
};

const NONE: ReadonlySet<never> = new Set();

/** Reads the live workflows' starters and approvers and the fresh runners' tiers. */
export async function readStartedCalls(db: Db, nowMs: number): Promise<StartedCalls> {
  const [live, prs, runners, accepted] = await Promise.all([
    db.all(db.k.selectFrom("main.item_workflows as w").innerJoin("main.tracked_repos as r", "r.name", "w.repo")
      .select(["w.repo", "w.number", "w.started_by", "w.approved_by"]).where("r.workflow", "=", "new").where("w.state", "in", LIVE_STATES)),
    db.all(db.k.selectFrom("main.implementations as i").innerJoin("main.item_workflows as w", (j) => j.onRef("w.repo", "=", "i.repo").onRef("w.number", "=", "i.number"))
      .innerJoin("main.tracked_repos as r", "r.name", "w.repo")
      .select(["i.repo", "i.pr_number", "w.started_by", "w.approved_by"]).where("i.pr_number", "is not", null).where("w.entry", "=", "implement")
      .where("r.workflow", "=", "new").where("w.state", "in", LIVE_STATES)),
    // A runner cooled off still takes calls for its user's started work, so it counts here.
    db.all(db.k.selectFrom("main.remote_helpers as h").innerJoin("main.mcp_tokens as t", "t.id", "h.token_id").select(["h.login", "h.models"])
      .where("t.kind", "=", "runner").where("t.expires_at", ">", new Date(nowMs).toISOString()).where("h.reported_at", ">=", nowMs - STATUS_FRESH_MS)
      .where("h.readiness", "in", ["ready", "cooled-off"])),
    acceptedModels(db),
  ]);
  const byItem = new Map<string, Set<string>>();
  const add = (key: string, logins: (string | null)[]) => {
    let s = byItem.get(key);
    if (!s) byItem.set(key, (s = new Set()));
    for (const l of logins) if (l) s.add(l.toLowerCase());
  };
  for (const w of live) add(`${w.repo}#${w.number}`, [w.started_by, w.approved_by]);
  for (const p of prs) add(`${p.repo}#${p.pr_number}`, [p.started_by, p.approved_by]);
  const tiers = new Map<string, Set<Tier>>();
  for (const r of runners) {
    let models: Record<string, unknown> = {};
    try { models = JSON.parse(r.models) as Record<string, unknown>; } catch { /* no models */ }
    const login = r.login.toLowerCase();
    const s = tiers.get(login) ?? new Set<Tier>();
    for (const [t, m] of Object.entries(models)) if (isTier(t) && typeof m === "string" && familyOf(m, accepted[t]) !== null) s.add(t);
    tiers.set(login, s);
  }
  return {
    owners: (refs) => {
      if (!refs.length || !byItem.size) return NONE;
      const [first, ...rest] = refs.map((r) => byItem.get(`${r.repo}#${r.number}`));
      if (!first || rest.some((s) => !s)) return NONE;
      return new Set([...first].filter((l) => rest.every((s) => s!.has(l))));
    },
    tiersOf: (login) => tiers.get(login.toLowerCase()) ?? NONE,
  };
}

/**
 * Whether a queued call is held for an owner other than `login` (null: anyone): one whose fresh runner offers its tier and who
 * may take it (not a judging call on an item they authored). A call bound to a user is never one of these.
 */
export function heldForOwner(s: StartedCalls, c: { forLogin: string | null; refs: readonly ItemRef[]; tier: Tier; authors: ReadonlySet<string>; judging: boolean }, login: string | null): boolean {
  if (c.forLogin !== null) return false;
  const self = login?.toLowerCase() ?? null;
  for (const o of s.owners(c.refs)) if (o !== self && s.tiersOf(o).has(c.tier) && !(c.judging && c.authors.has(o))) return true;
  return false;
}
