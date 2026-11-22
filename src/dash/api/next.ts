// The Next page: per pipeline step, the items its next job will take, in the autopilot's own order (laneItems, stored by each planner pass), whether the step can run now, and the items waiting on something outside.
import type { NextItem, NextPage, NextStep, NextWaiting } from "../../../web/src/api/types.ts";
import { LANES, laneGate, stageStatus, storedLaneItems } from "../../runner/autopilot.ts";
import { lanesInOrder, STAGES } from "../../stages/registry.ts";
import { loadSteps } from "../../runner/steps.ts";
import { trackedNames } from "../../repos.ts";
import type { Req } from "../types.ts";
import { shownLookup } from "./shown.ts";
import { blankIfHidden, visibleRepos } from "./visible.ts";
import { readerOf, statusFor, veiledFor, type Reader } from "./reader.ts";
import { mapSeq } from "../../async-seq.ts";
import type { Db } from "../../db/index.ts";

const WAITING_LIMIT = 500;

const parseView = (view: string): { next?: string; scope?: true } => { try { return (JSON.parse(view) as { next?: string; scope?: true } | null) ?? {}; } catch { return {}; } };
const nextText = (view: string): string | null => parseView(view).next ?? null;

/** `reader`: what the requester may read of the stored texts; without one (tests), every repo outside `visibleNames` is hidden. */
export async function nextPage(db: Db, visibleNames: string[], opts: { nowMs?: number; reader?: Reader } = {}): Promise<NextPage> {
  const visible = new Set(visibleNames), ms = opts.nowMs ?? Date.now();
  const reader = opts.reader ?? { staff: true, quiet: new Set<string>(), hidden: Object.assign((await trackedNames(db)).filter((r) => !visible.has(r)), { visible: visibleNames }) };
  const hidden = reader.hidden;
  const stored = await storedLaneItems(db);
  const shown = shownLookup(db);
  const stepDefs = await loadSteps();
  const status = await stageStatus(db);
  const plan = async (repo: string, number: number) => await db.get(db.k.selectFrom("item_plans").select(["repo", "number", "wait", "view"]).where("repo", "=", repo).where("number", "=", number));
  const why = async (repo: string, number: number, action: string): Promise<string> =>
    (veiledFor(reader, repo, number) ? null : blankIfHidden(nextText((await plan(repo, number))?.view ?? "{}"), hidden) || null) ?? action;
  const stageOf = new Map(lanesInOrder().map((l) => [l.name, STAGES.find((s) => s.id === l.stage)?.title ?? l.stage]));
  const steps: NextStep[] = [];
  for (const lane of LANES) {
    const kept = stored[lane.name]?.items ?? [];
    const items: NextItem[] = await mapSeq(kept.filter((i) => visible.has(i.repo)), async (i) => ({ ...i, ...await shown(i.repo, i.number), why: await why(i.repo, i.number, i.action) }));
    const total = (stored[lane.name]?.total ?? 0) - (kept.length - items.length);
    const gate = await laneGate(db, lane, stepDefs, ms);
    const open = items.filter((i) => !i.blocked);
    // Every item blocked by a repo approval: the step cannot do its work although it could start.
    const refused = !open.length && items.length ? items[0]!.blocked : null;
    steps.push({
      lane: lane.name, title: stepDefs.get(lane.steps?.[0] ?? lane.name)?.title ?? lane.name, stage: stageOf.get(lane.name) ?? "", steps: lane.steps ?? [],
      canRun: gate.canRun && !refused, kind: refused && gate.canRun ? "approval" : gate.kind, why: blankIfHidden(gate.why, hidden) || refused,
      note: blankIfHidden((lane.steps ?? []).map((s) => status[s]).find(Boolean) ?? null, hidden) || null, total, items,
    });
  }
  const rows = await db.all(db.k.selectFrom("item_plans").select(["repo", "number", "wait", "view"]).where("wait", "is not", null).orderBy("repo").orderBy("number"));
  const scoped = rows.filter((r) => visible.has(r.repo) && parseView(r.view).scope);
  const waiting: NextWaiting[] = await mapSeq(scoped.slice(0, WAITING_LIMIT), async (r) => {
    const s = statusFor(reader, r.repo, r.number, { waiting: r.wait, next: nextText(r.view) });
    return { repo: r.repo, number: r.number, ...await shown(r.repo, r.number), wait: s.waiting ?? "", why: s.next };
  });
  return { steps, waiting, waitingTotal: scoped.length };
}

export async function next(db: Db, req: Req): Promise<NextPage> {
  return nextPage(db, await visibleRepos(db, req), { reader: await readerOf(db, req) });
}
