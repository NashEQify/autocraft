// The real dependencies of the security scan: the pinned checkout from the bare cache and `claude` in the read-only sandbox.
import { ownerOf } from "../owners.ts";
import { askClaude, saveUsage, type Usage } from "../classify/run.ts";
import { exec, fixupDir, Git } from "../fixup/git.ts";
import { checkoutForCommit, sandboxAvailable } from "../sandbox/index.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { cachedCrates, ghCrates } from "../verify/crates.ts";
import type { ScanDeps } from "./scan.ts";
import type { Db } from "../db/index.ts";

/** The token_usage run id of a scan: the job registers it with `usageRun`, so the spend shows in the job's usage and on the Cost page. */
export const usageRunId = (scanId: number): string => `security-${scanId}`;

/** `io.resumes`: the job's resume count (src/runner/resuming.ts); a resumed run's agent names differ from its earlier run's, whose usage rows stay. */
export function realDeps(db: Db, scanId: number, io: { cancelled: () => Promise<boolean>; log: (line: string) => void; progress: (line: string) => Promise<void>; resumes?: number }): ScanDeps {
  let dir = "";
  let seq = 0;
  const run = io.resumes ? `r${io.resumes}.` : "";
  // The checkout is read-only in bubblewrap; the CLI keeps its API access, the model gets Read, Grep and Glob and no web tool.
  // The cost is read from the agent runs the call made (a failed call and a fix turn cost money too), so the spend cap sees all of it.
  const send = async (id: "security.model" | "security.area" | "security.verify" | "security.scantest", input: { repo: string; number: number }) => {
    const before = (await db.get(db.k.selectFrom("agent_runs").select((eb) => eb.fn.coalesce(eb.fn.max("id"), eb.lit(0)).as("n"))))!.n;
    const start = new Date().toISOString();
    let text: string | null = null, usage: Usage | null = null;
    try {
      const r = await askClaude(id, "opus", [{ ...input, repo_dir: REPO_PATH }] as never, db, { checkout: dir });
      if (r) { text = r.text; usage = r.usage; }
    } catch (e) {
      io.log(`${id} failed: ${(e as Error).message}`.slice(0, 300));
    }
    const spent = (await db.get(db.k.selectFrom("agent_runs as r").innerJoin("agent_run_items as i", "i.run_id", "r.id")
        .select((eb) => eb.fn.sum<number | null>("r.cost_usd").as("c")).where("i.repo", "=", input.repo).where("i.number", "=", input.number).where("r.id", ">", before)))!.c;
    const cost = spent ?? usage?.cost ?? null;
    await saveUsage(db, usageRunId(scanId), `${id}#${run}${++seq}`, "security", "opus", 1, usage ? { ...usage, cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost }, start, new Date().toISOString());
    const runId = (await db.get(db.k.selectFrom("agent_runs as r").innerJoin("agent_run_items as i", "i.run_id", "r.id")
      .select((eb) => eb.fn.min<number | null>("r.id").as("id")).where("i.repo", "=", input.repo).where("i.number", "=", input.number).where("r.id", ">", before)))!.id;
    return { text, cost, runId };
  };
  return {
    ...io,
    checkout: async (repo, pin) => {
      if (!sandboxAvailable()) {
        io.log("the sandbox is not available on this machine");
        return null;
      }
      const branch = (await db.get(db.k.selectFrom("main.repos").select("default_branch").where("name", "=", repo)))?.default_branch ?? "main";
      const sha = pin ?? await new Git(exec, fixupDir(), repo).fetchBase(ownerOf(repo), repo, branch);
      const d = await checkoutForCommit(repo, branch, sha, io.log);
      if (!d) return null;
      dir = d;
      return { dir: d, sha };
    },
    ask: send as ScanDeps["ask"],
    // Used only while the scan-tests switch is on (the scan checks it).
    writeTest: (input) => send("security.scantest", input),
    crates: (repo, sha) => cachedCrates(repo, sha, ghCrates),
  };
}
