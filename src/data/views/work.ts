// reads: mirror.items, triage.item_rank, planner.item_plans
// The ranked work list: open items in work-score order with the parts of the score and the plan's next step and label.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { RankBreakdown } from "../triage/types.ts";
import type { WorkFilter } from "./types.ts";

export type WorkListRow = {
  repo: string; number: number; kind: "pr" | "issue"; title: string; score: number; breakdown: RankBreakdown; next: string | null; label: string | null; itemState: string | null;
};

/** One page and the total of the open ranked items of `f.repos`, one wave of 2 statements. Veiling for viewers stays with the handler. */
export async function loadWorkList(db: Db, f: WorkFilter): Promise<{ rows: WorkListRow[]; total: number }> {
  if (!f.repos.length) return { rows: [], total: 0 };
  const q = queryDb(db);
  const { k } = q;
  const base = () => k.selectFrom("main.items as i").innerJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
    .where("i.state", "=", "OPEN").where(kx.inList(db, "i.repo", f.repos)).$if(!!f.kind, (b) => b.where("i.kind", "=", f.kind!));
  const [total, rows] = await db.together(() => Promise.all([
    q.get(base().select((eb) => eb.fn.countAll<number>().as("n"))),
    q.all(base().leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
      .select(["i.repo", "i.number", "i.kind", "i.title", "r.score", "r.breakdown", kx.jsonText(db, "p.view", "$.next").as("next"), kx.jsonText(db, "p.view", "$.label").as("label"), "p.item_state"])
      .orderBy("r.score", "desc").orderBy("i.repo").orderBy("i.number").limit(f.limit).offset(f.offset ?? 0)),
  ]));
  return {
    total: Number(total?.n ?? 0),
    rows: rows.map((r) => ({
      repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", score: r.score, breakdown: JSON.parse(r.breakdown) as RankBreakdown,
      next: r.next, label: r.label, itemState: r.item_state,
    })),
  };
}

/** Every open ranked item of every repo in work-score order, without paging: the Queue page filters and counts them. 1 statement. */
export async function loadRankedOpen(db: Db): Promise<WorkListRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.items as i").innerJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
    .leftJoin("main.item_plans as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .select(["i.repo", "i.number", "i.kind", "i.title", "r.score", "r.breakdown", kx.jsonText(db, "p.view", "$.next").as("next"), kx.jsonText(db, "p.view", "$.label").as("label"), "p.item_state"])
    .where("i.state", "=", "OPEN").orderBy("r.score", "desc").orderBy("i.repo").orderBy("i.number"), { label: "views.loadRankedOpen" });
  return rows.map((r) => ({
    repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", title: r.title ?? "", score: r.score, breakdown: JSON.parse(r.breakdown) as RankBreakdown,
    next: r.next, label: r.label, itemState: r.item_state,
  }));
}
