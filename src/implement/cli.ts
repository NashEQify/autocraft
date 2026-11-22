// autocraft-server implement run <repo#n> --plan-only [--no-post] | show <repo#n> --call <id>
// `run` queues the implement job for the issue and waits for it: --plan-only stops after the plan (a ready plan is stored as
// `planned`; questions are posted or asked); with --no-post it is a dry run that stores and posts nothing. The plan and any
// question are printed here, never in the job log, which every signed-in user can read.
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";
import { CLI_QUEUE_BY, enqueue, JobError } from "../runner/jobs.ts";
import { parsePlanReply, planMarkdown, PLAN_PROMPT_ID } from "./plan.ts";
import { authorComment } from "./questions.ts";
import type { PlanReply } from "./types.ts";

const USAGE = "usage: implement run <repo#n> --plan-only [--no-post] | implement show <repo#n> --call <id>";
const die = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const POLL_MS = 5000;

function refOf(s: string | undefined): { repo: string; number: number } {
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

async function show(db: Db, ref: { repo: string; number: number }, callId: number): Promise<void> {
  const c = await db.get(db.k.selectFrom("remote_calls").select(["prompt_id", "items", "reply", "state"]).where("id", "=", callId));
  if (!c || c.prompt_id !== PLAN_PROMPT_ID || !(JSON.parse(c.items ?? "[]") as { repo: string; number: number }[]).some((r) => r.repo === ref.repo && r.number === ref.number)) die(`call ${callId} is not a plan call of ${ref.repo}#${ref.number}`);
  if (c!.reply === null) die(`call ${callId} has no reply (${c!.state})`);
  try {
    console.log(planReport(parsePlanReply(c!.reply!)));
  } catch (e) {
    console.log(`the reply does not parse: ${(e as Error).message}\n\n${c!.reply}`);
  }
}

async function run(args: string[]): Promise<void> {
  const [sub, target, ...rest] = args;
  const db = await openDb();
  const ref = refOf(target);
  if (sub === "show") {
    const i = rest.indexOf("--call");
    const call = Number(rest[i + 1]);
    if (i < 0 || !Number.isInteger(call) || call < 1) die(USAGE);
    return await show(db, ref, call);
  }
  if (sub !== "run") die(USAGE);
  if (!rest.includes("--plan-only")) die("only --plan-only is built: implement run <repo#n> --plan-only [--no-post]");
  const dry = rest.includes("--no-post");
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

export const commands = {
  implement: { summary: "implement queued issues: run <repo#n> --plan-only [--no-post] | show <repo#n> --call <id>", run },
};
