// The `check` tool of a remote call. The harness calls it on the dashboard, but the call's CheckTool lives in the job
// process that waits for the call (askRemote's awaitCall), which keeps its call count, time limit and `ran` set. The
// dashboard inserts a request row and polls for its result; the job's poll loop takes requested rows of its call and
// runs them on the CheckTool. Polling only: both sides use the model queue's poll interval.
import { allocation } from "../agents/call.ts";
import { scaled } from "./time-scale.ts";
import type { CheckResult, CheckTool } from "../checktool/index.ts";
import type { Db } from "../db/index.ts";

/** How often the waiting dashboard request calls `tick` (the HTTP layer writes a keep-alive byte). */
const TICK_MS = scaled(15_000);

const over = async (db: Db, id: number, r: CheckResult, nowMs = Date.now()): Promise<void> => {
  await db.run(db.k.updateTable("main.remote_checks").set({ state: "done", result: JSON.stringify(r), ended_at: nowMs }).where("id", "=", id).where("state", "!=", "done"));
};

/** Job side, on each poll of a leased call: starts the call's requested checks on `tool`, each recorded under the run the request names. A request made under an earlier lease's run is stale and left alone. */
export async function serveChecks(db: Db, callId: number, tool: Pick<CheckTool, "run">): Promise<void> {
  const rows = await db.all(db.k.selectFrom("main.remote_checks").select(["id", "run_id", "input"]).where("call_id", "=", callId).where("state", "=", "requested")
    .where((eb) => eb("run_id", "is not distinct from", eb.selectFrom("main.remote_calls").select("run_id").where("id", "=", callId)))
    .orderBy("id"));
  for (const r of rows) {
    if (Number((await db.run(db.k.updateTable("main.remote_checks").set({ state: "running" }).where("id", "=", r.id).where("state", "=", "requested"))).changes) !== 1) continue;
    let input: unknown;
    try { input = JSON.parse(r.input); } catch { input = null; }
    void tool.run(input, r.run_id).then(
      async (res) => await over(db, r.id, res),
      async (e) => await over(db, r.id, { text: `the check could not run: ${String((e as Error).message ?? e).slice(0, 200)}`, isError: true }),
    ).catch(() => { /* the database is closed: the process is ending */ });
  }
}

/** Job side, when the call has ended: requests nobody will run get an answer. */
export async function endChecks(db: Db, callId: number): Promise<void> {
  await db.run(db.k.updateTable("main.remote_checks").set({ state: "done", result: JSON.stringify({ text: "refused: the model call is over", isError: true }), ended_at: Date.now() })
    .where("call_id", "=", callId).where("state", "=", "requested"));
}

/**
 * Dashboard side: queues one check for the call and waits for its result. `live` says whether the lease still holds (checked
 * on each poll; a request still waiting when it ends is withdrawn), `signal` is the client going away, `tick` is called about
 * every 15 s while waiting.
 */
export async function relayCheck(db: Db, call: { id: number; runId: number | null }, input: unknown, opts: { live: () => Promise<boolean>; signal?: AbortSignal; tick?: () => void }): Promise<CheckResult> {
  const id = Number((await db.get(db.k.insertInto("main.remote_checks").values({ call_id: call.id, run_id: call.runId, input: JSON.stringify(input ?? null), state: "requested", requested_at: Date.now() }).returning("id")))!.id);
  let lastTick = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, allocation.pollMs));
    const r = await db.fresh(() => db.get(db.k.selectFrom("main.remote_checks").select(["state", "result"]).where("id", "=", id)));
    if (r?.state === "done" && r.result) return JSON.parse(r.result) as CheckResult;
    const gone = opts.signal?.aborted ? "the request was cancelled" : !await opts.live() ? "the lease is gone" : null;
    if (gone || !r) {
      // A running check is left to finish on the job side; only a request nobody took is withdrawn.
      await db.run(db.k.updateTable("main.remote_checks").set({ state: "done", result: JSON.stringify({ text: `refused: ${gone}`, isError: true }), ended_at: Date.now() }).where("id", "=", id).where("state", "=", "requested"));
      return { text: `the check did not run to the end: ${gone ?? "the request is gone"}`, isError: true };
    }
    if (opts.tick && Date.now() - lastTick >= TICK_MS) {
      lastTick = Date.now();
      opts.tick();
    }
  }
}
