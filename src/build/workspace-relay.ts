// The relay between a session's workspace tools and the job that owns the workspace. The dashboard queues each tool call
// as a workspace_calls row and waits for its result; the job process waiting on the remote call (awaitCall) claims the
// rows and runs them on its WorkspaceSession, which settles each row (state and result). The rows are the record a resume reads; the wake only
// shortens the waits. On Postgres both sides wake on NOTIFY and poll slowly behind it; on SQLite both poll at the model
// queue's interval. workspace_calls is in no change topic, so the relay's writes never wake the planner.
import { allocation } from "../agents/call.ts";
import type { Db } from "../db/index.ts";
import { scaled } from "../remote/time-scale.ts";
import { inClusterApi } from "./kube-api.ts";
import { WorkspaceSession, type ToolImage, type WorkspaceToolResult } from "./workspace-tools.ts";
import { LIVE_STATES } from "./workspaces.ts";

/** Dashboard to job: a tool call was queued. Payload: the workspace id. */
export const CALL_CHANNEL = "workspace_call";
/** Job to dashboard: a tool call has its result. Payload: the workspace_calls id. */
export const REPLY_CHANNEL = "workspace_reply";

/** How often the waiting dashboard request calls `tick` (the HTTP layer writes a keep-alive byte). */
const TICK_MS = scaled(15_000);
/** The poll behind the wake on Postgres; a side whose listening connection failed polls at the model queue's interval. */
const SAFETY_POLL_MS = scaled(10_000);

/** What the job runs a tool call on: a WorkspaceSession, or a stand-in in tests. */
export type ToolSession = Pick<WorkspaceSession, "call">;

const refusal = (why: string): WorkspaceToolResult => ({ text: `refused: ${why}`, isError: true });
const iso = (): string => new Date().toISOString();

/** Resolves a waiter early: `poke` before `wait` makes the next wait return at once. */
class Waker {
  #poked = false;
  #fire: (() => void) | null = null;
  poke(): void {
    this.#poked = true;
    this.#fire?.();
  }
  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (!this.#poked && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(t);
          this.#fire = null;
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, ms);
        this.#fire = done;
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    this.#poked = false;
  }
}

/** The model-facing part of a settled row's result (the session's bookkeeping stays in the row). */
function parseResult(text: string): WorkspaceToolResult {
  try {
    const o = JSON.parse(text) as WorkspaceToolResult;
    if (typeof o?.text === "string") {
      const images = Array.isArray(o.images) ? o.images.filter((i): i is ToolImage => typeof i?.data === "string" && typeof i.mimeType === "string") : [];
      return { text: o.text, ...(o.isError === true && { isError: true }), ...(images.length && { images }) };
    }
  } catch { /* below */ }
  return { text: "the tool's result is unreadable", isError: true };
}

// ---- the dashboard's side -------------------------------------------------------

/**
 * Dashboard side: queues tool `name` of the lease's workspace, with the arguments whole, and waits for the row's result.
 * `live` says whether the lease still holds (checked on each poll; a call still queued when it ends is withdrawn, one
 * already running is left to finish in the job), `signal` is the client going away, `tick` is called about every 15 s
 * while waiting.
 */
export async function relayWorkspaceCall(db: Db, lease: { id: number; runId: number | null }, name: string, args: unknown,
  opts: { live: () => Promise<boolean>; signal?: AbortSignal; tick?: () => void }): Promise<WorkspaceToolResult> {
  const ws = await db.get(db.k.selectFrom("workspaces").select("id").where("remote_call_id", "=", lease.id).where("state", "in", LIVE_STATES));
  if (!ws) return refusal("this call has no live workspace");
  const waker = new Waker();
  let id = -1;
  const off = await db.listen(REPLY_CHANNEL, (p) => { if (p === null || p === String(id)) waker.poke(); });
  try {
    id = Number((await db.get(db.k.insertInto("workspace_calls").values({
      workspace_id: ws.id, run_id: lease.runId, tool: name, args: JSON.stringify(args ?? {}), state: "queued", created_at: iso(),
    }).returning("id")))!.id);
    await db.notify(CALL_CHANNEL, String(ws.id));
    const pollMs = off ? SAFETY_POLL_MS : allocation.pollMs;
    let lastTick = Date.now();
    for (;;) {
      await waker.wait(Math.min(pollMs, TICK_MS), opts.signal);
      const r = await db.get(db.k.selectFrom("workspace_calls").select(["state", "result"]).where("id", "=", id));
      if ((r?.state === "done" || r?.state === "failed") && r.result) return parseResult(r.result);
      const gone = opts.signal?.aborted ? "the request was cancelled" : !r ? "the call is gone" : !await opts.live() ? "the lease is gone" : null;
      if (gone) {
        const withdrawn = await db.run(db.k.updateTable("workspace_calls").set({ state: "failed", result: JSON.stringify(refusal(gone)), finished_at: iso() })
          .where("id", "=", id).where("state", "=", "queued"));
        return withdrawn.changes ? refusal(gone) : { text: `call ${id} did not finish before ${gone}; it runs on in the workspace (for a shell command: shell_status ${id})`, isError: true };
      }
      if (opts.tick && Date.now() - lastTick >= TICK_MS) {
        lastTick = Date.now();
        opts.tick();
      }
    }
  } finally {
    off?.();
  }
}

// ---- the job's side -------------------------------------------------------------

const sessions = new WeakMap<Db, Map<number, ToolSession>>();

/**
 * The job process's session on a workspace, kept for the process's life so its limits and queue span every turn. A
 * runner outside the cluster cannot exec in the pod and refuses every call.
 */
export function jobSession(db: Db, workspaceId: number): ToolSession {
  let m = sessions.get(db);
  if (!m) sessions.set(db, m = new Map());
  let s = m.get(workspaceId);
  if (!s) {
    const api = inClusterApi();
    s = api ? new WorkspaceSession(db, api, workspaceId) : { call: async () => refusal("this runner is not in the cluster, so it cannot reach the workspace") };
    m.set(workspaceId, s);
  }
  return s;
}

/**
 * Job side: serves the workspace bound to one remote call while the job waits for that call. `serve` claims the queued
 * calls that came under the call's current lease and runs them side by side on the session (which queues beyond its own
 * limit and settles each row); a call from an earlier lease is left for its dashboard request to withdraw. The first
 * serve also hands back the rows of the lease still running from an earlier process of the job (a runner restart): the
 * session re-attaches a command it started instead of running it again. `end` answers what is still queued.
 */
export class WorkspaceServer {
  readonly db: Db;
  readonly callId: number;
  readonly workspaceId: number;
  readonly session: ToolSession;
  #off: (() => void) | null = null;
  /** Rows this process handed to the session and that have not settled. */
  readonly #running = new Set<number>();
  #adopted = false;

  private constructor(db: Db, callId: number, workspaceId: number, session: ToolSession) {
    this.db = db;
    this.callId = callId;
    this.workspaceId = workspaceId;
    this.session = session;
  }

  /** The server of the workspace bound to `callId`, listening for its calls; null when no live workspace is bound to it. */
  static async open(db: Db, callId: number, sessionOf: (db: Db, workspaceId: number) => ToolSession = jobSession): Promise<WorkspaceServer | null> {
    const ws = await db.get(db.k.selectFrom("workspaces").select("id").where("remote_call_id", "=", callId).where("state", "in", LIVE_STATES));
    if (!ws) return null;
    const s = new WorkspaceServer(db, callId, ws.id, sessionOf(db, ws.id));
    s.#off = await db.listen(CALL_CHANNEL, (p) => { if (p === null || p === String(ws.id)) void s.serve().catch(() => { /* the next poll serves */ }); });
    return s;
  }

  /** Calls still running on the session. */
  get running(): number {
    return this.#running.size;
  }

  async serve(): Promise<void> {
    const { db } = this;
    const adopt = !this.#adopted;
    this.#adopted = true;
    const rows = await db.all(db.k.selectFrom("workspace_calls").select(["id", "tool", "args", "state"]).where("workspace_id", "=", this.workspaceId)
      .where("state", "in", adopt ? ["queued", "running"] : ["queued"])
      .where((eb) => eb("run_id", "=", eb.selectFrom("remote_calls").select("run_id").where("id", "=", this.callId)))
      .orderBy("id"));
    for (const r of rows) {
      if (this.#running.has(r.id)) continue;
      this.#running.add(r.id);
      if (r.state === "queued" && Number((await db.run(db.k.updateTable("workspace_calls").set({ state: "running", started_at: iso() }).where("id", "=", r.id).where("state", "=", "queued"))).changes) !== 1) {
        this.#running.delete(r.id);
        continue;
      }
      let args: unknown;
      try { args = JSON.parse(r.args); } catch { args = null; }
      void this.session.call(r.tool, args, r.id)
        .catch(async (e: unknown) => await this.#fail(r.id, e))
        .then(async () => await db.notify(REPLY_CHANNEL, String(r.id)))
        .catch(() => { /* the database is closed: the process is ending */ })
        .finally(() => this.#running.delete(r.id));
    }
  }

  /** Settles a row whose session call threw (it never throws for a tool error), so its dashboard request gets an answer. */
  async #fail(id: number, e: unknown): Promise<void> {
    const { db } = this;
    await db.run(db.k.updateTable("workspace_calls").set({ state: "failed", result: JSON.stringify({ text: `failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, isError: true }), finished_at: iso() })
      .where("id", "=", id).where("state", "in", ["queued", "running"]));
  }

  /** The call has ended: stops listening and refuses its calls nobody will run. Calls running on the session finish and store their reply. */
  async end(): Promise<void> {
    this.#off?.();
    this.#off = null;
    const { db } = this;
    const refused = await db.all(db.k.updateTable("workspace_calls").set({ state: "failed", result: JSON.stringify(refusal("the model call is over")), finished_at: iso() })
      .where("workspace_id", "=", this.workspaceId).where("state", "=", "queued")
      .where((eb) => eb("run_id", "=", eb.selectFrom("remote_calls").select("run_id").where("id", "=", this.callId)))
      .returning("id"));
    for (const r of refused) await db.notify(REPLY_CHANNEL, String(r.id));
  }
}
