// autocraft-server implement run <repo#n> --plan-only [--no-post] | run <repo#n> --no-pr | show <repo#n> --call <id>
// `run --plan-only` queues the implement job's plan bucket for the issue and waits for it: a ready plan is stored as
// `planned`; questions are posted or asked; with --no-post it is a dry run that stores and posts nothing. The plan and any
// question are printed here, never in the job log, which every signed-in user can read.
// `run --no-pr` runs the build of the issue's current attempt in this process: the session in the attempt's workspace (on
// the queuer's Task Runner), AutoCraft's checks and the follow-up turns, until the attempt is ready for its PR or stuck.
// Nothing is written to GitHub; a stuck attempt still asks its decision.
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { unpackText } from "../agents/runs.ts";
import { CLI_QUEUE_BY, enqueue, JobError } from "../runner/jobs.ts";
import { runBuild } from "./build.ts";
import { parsePlanReply, planMarkdown, PLAN_PROMPT_ID } from "./plan.ts";
import { authorComment } from "./questions.ts";
import { currentImplementation } from "./store.ts";
import { BUILD_STATES, type PlanReply } from "./types.ts";

const USAGE = "usage: implement run <repo#n> --plan-only [--no-post] | implement run <repo#n> --no-pr | implement show <repo#n> --call <id>";
const die = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const POLL_MS = 5000;
/** Build units one command runs at most: the session, three follow-ups and their checks, with room for retries. */
const UNITS_MAX = 16;

type Ref = { repo: string; number: number };

function refOf(s: string | undefined): Ref {
  const m = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(s ?? "");
  return m ? { repo: m[1]!, number: Number(m[2]) } : die(USAGE);
}

/** The plan and its questions as the CLI prints them: the comment an author question posts, the decision a maintainer question asks. */
export function planReport(r: PlanReply): string {
  const out = [planMarkdown(r)];
  const author = r.questions.filter((q) => q.audience === "author");
  if (author.length) out.push(`--- comment to the author ---\n${authorComment(author)}`);
  for (const q of r.questions.filter((x) => x.audience === "maintainer")) {
    out.push(`--- decision for the maintainers${r.size === "XL" ? " (split)" : ""} ---\n${q.text}\n${q.options.map((o) => `  - ${o.label}${o.label === q.recommended ? " (recommended)" : ""}: ${o.hint}`).join("\n")}\n  - Backlog`);
  }
  return out.join("\n\n");
}

/**
 * The reply of a plan call: the call's raw reply is dropped once it is read (remote/calls.ts), so it comes from the agent
 * run's stored, scrubbed output, else from the plan round that recorded the call.
 */
async function replyOf(db: Db, callId: number, runId: number | null, raw: string | null): Promise<string | null> {
  if (raw !== null) return raw;
  if (runId !== null) {
    const t = await db.get(db.k.selectFrom("agent_run_texts").select("output").where("run_id", "=", runId));
    const out = unpackText(t?.output);
    if (out) return out;
  }
  const round = await db.get(db.k.selectFrom("main.implementation_rounds").select("result").where("kind", "=", "plan").where("call_id", "=", callId).orderBy("id", "desc").limit(1));
  return round?.result ?? null;
}

async function show(db: Db, ref: Ref, callId: number): Promise<void> {
  const c = await db.get(db.k.selectFrom("remote_calls").select(["prompt_id", "items", "reply", "state", "run_id"]).where("id", "=", callId));
  if (!c || c.prompt_id !== PLAN_PROMPT_ID || !(JSON.parse(c.items ?? "[]") as Ref[]).some((r) => r.repo === ref.repo && r.number === ref.number)) die(`call ${callId} is not a plan call of ${ref.repo}#${ref.number}`);
  const reply = await replyOf(db, callId, c!.run_id, c!.reply);
  if (reply === null) die(`call ${callId} has no stored reply (${c!.state})`);
  try {
    console.log(planReport(parsePlanReply(reply!)));
  } catch (e) {
    console.log(`the reply does not parse: ${(e as Error).message}\n\n${reply}`);
  }
}

/** Queues the plan bucket and waits for its job, then prints the plan call it ended on. */
async function planOnly(db: Db, ref: Ref, dry: boolean): Promise<void> {
  let id: number;
  try {
    id = (await enqueue(db, "implement", { repo: ref.repo, number: ref.number, bucket: "plan", mode: dry ? "dry" : "normal" }, CLI_QUEUE_BY)).id;
  } catch (e) {
    if (e instanceof JobError) die(`not queued: ${e.message}`);
    throw e;
  }
  console.log(`job ${id} queued${dry ? " (dry run: nothing is stored or posted)" : ""}; waiting for it to end`);
  for (;;) {
    const j = await db.get(db.k.selectFrom("jobs").select(["state", "summary", "error"]).where("id", "=", id));
    if (!j) die(`job ${id} is gone`);
    if (j!.state === "done" || j!.state === "failed" || j!.state === "cancelled") {
      console.log(`job ${id} ${j!.state}: ${j!.summary ?? j!.error ?? ""}`);
      if (j!.state !== "done") process.exit(1);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  // The plan call the job ended on: its newest implement.plan call for the issue.
  const call = await db.get(db.k.selectFrom("workspace_sessions as s").innerJoin("remote_calls as c", "c.id", "s.remote_call_id").select("c.id")
    .where("s.job_id", "=", id).where("s.kind", "=", "implement").where("c.prompt_id", "=", PLAN_PROMPT_ID).orderBy("c.id", "desc").limit(1));
  if (call) await show(db, ref, Number(call.id));
}

/** Runs the build units of the current attempt in this process until it is ready for its PR, stuck or no longer moving. */
async function buildNoPr(db: Db, ref: Ref): Promise<void> {
  const cur = await currentImplementation(db, ref.repo, ref.number);
  if (!cur) return die(`${ref.repo}#${ref.number} has no current implementation attempt`);
  if (!cur.plan) return die(`${ref.repo}#${ref.number}: attempt ${cur.attempt} has no stored plan (state ${cur.state}); plan it first`);
  const run = {
    db, log: (l: string) => console.log(l), progress: async (t: string) => console.log(`… ${t}`),
    cancelled: async () => false, stopping: async () => false, noPr: true,
  };
  for (let n = 0; n < UNITS_MAX; n++) {
    const r = await runBuild({ ...run, startedMs: Date.now() }, ref.repo, ref.number);
    console.log(r.summary);
    const now = await currentImplementation(db, ref.repo, ref.number);
    if (!now || now.state === "opening" || !BUILD_STATES.has(now.state) || !r.moved) {
      process.exitCode = now?.state === "opening" ? 0 : 2;
      return;
    }
  }
  console.log(`stopped after ${UNITS_MAX} steps`);
  process.exitCode = 2;
}

async function run(args: string[]): Promise<void> {
  const [sub, target, ...rest] = args;
  const ref = refOf(target);
  const db = await openDb();
  if (sub === "show") {
    const i = rest.indexOf("--call");
    const call = Number(rest[i + 1]);
    if (i < 0 || !Number.isInteger(call) || call < 1) die(USAGE);
    return await show(db, ref, call);
  }
  if (sub !== "run") die(USAGE);
  const extra = rest.find((a) => !["--plan-only", "--no-post", "--no-pr"].includes(a));
  if (extra !== undefined) die(`unknown argument ${extra}; ${USAGE}`);
  const plan = rest.includes("--plan-only"), noPr = rest.includes("--no-pr");
  if (plan === noPr) die(`give either --plan-only or --no-pr (opening the PR from the command line is not offered); ${USAGE}`);
  if (noPr && rest.includes("--no-post")) die(`--no-post goes with --plan-only; ${USAGE}`);
  if (plan) return await planOnly(db, ref, rest.includes("--no-post"));
  return await buildNoPr(db, ref);
}

export const commands = {
  implement: {
    summary: "implement queued issues: run <repo#n> --plan-only [--no-post] (stop after the plan; --no-post stores and posts nothing) | run <repo#n> --no-pr (the session, AutoCraft's checks and follow-up turns of the current attempt; nothing to GitHub) | show <repo#n> --call <id>",
    run,
  },
};
