// The sessions of workspaces with the cost and reply of their model calls, for the Workspaces list and page.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";

export type SessionCostRow = { workspaceId: number; item: number | null; usage: string | null };
export type SessionDetailRow = {
  id: number; kind: string | null; item: number; state: string; outcome: string | null; forLogin: string | null; requestedBy: string | null; createdAt: string;
  endedAt: string | null; jobId: number | null; prompt: string | null; reply: string | null; usage: string | null;
};

// NEEDS runners.loadCallUsage: the usage and reply of the remote calls bound to sessions; the joins below read remote_calls until it exists.

/** Only what the cost needs, oldest session first: the list never reads prompts or replies. 1 statement. */
export async function loadSessionCosts(db: Db, workspaceIds: number[]): Promise<Map<number, SessionCostRow[]>> {
  const out = new Map<number, SessionCostRow[]>();
  if (!workspaceIds.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workspace_sessions as s").leftJoin("main.remote_calls as c", "c.id", "s.remote_call_id")
    .select(["s.workspace_id", "s.item", "c.usage"]).where(kx.inList(db, "s.workspace_id", workspaceIds, "bigint")).orderBy("s.id"));
  for (const r of rows) {
    const id = Number(r.workspace_id);
    (out.get(id) ?? out.set(id, []).get(id)!).push({ workspaceId: id, item: r.item === null ? null : Number(r.item), usage: r.usage });
  }
  return out;
}

/** One workspace's sessions with prompt, reply and usage, oldest first. 1 statement. */
export async function loadSessionDetails(db: Db, workspaceId: number): Promise<SessionDetailRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.workspace_sessions as s").leftJoin("main.remote_calls as c", "c.id", "s.remote_call_id")
    .select(["s.id", "s.kind", "s.item", "s.state", "s.outcome", "s.for_login", "s.requested_by", "s.created_at", "s.ended_at", "s.job_id", "s.prompt", "c.reply", "c.usage"])
    .where("s.workspace_id", "=", workspaceId).orderBy("s.id"), { alone: true });
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind, item: Number(r.item), state: r.state, outcome: r.outcome, forLogin: r.for_login, requestedBy: r.requested_by, createdAt: r.created_at,
    endedAt: r.ended_at, jobId: r.job_id === null ? null : Number(r.job_id), prompt: r.prompt, reply: r.reply, usage: r.usage,
  }));
}
