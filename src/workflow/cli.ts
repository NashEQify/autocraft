// `workflow status [repo]`: the live workflows, per tracked repo.
import { loadTrackedRepos } from "../data/control/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import { openDb } from "../db/open.ts";

const USAGE = "usage: workflow status [repo]";

async function status(repo: string | undefined): Promise<void> {
  const db = await openDb();
  const [tracked, live] = await db.together(() => Promise.all([loadTrackedRepos(db), listWorkflows(db, { live: true, ...(repo ? { repos: [repo] } : {}) })]));
  const repos = [...tracked.keys()].filter((r) => !repo || r === repo).sort();
  if (repo && !repos.length) throw new Error(`${repo} is not tracked`);
  for (const r of repos) {
    const mine = live.filter((w) => w.repo === r);
    if (!repo && !mine.length) continue;
    console.log(`${r}: ${mine.length} live workflow${mine.length === 1 ? "" : "s"}`);
    if (!repo) continue;
    for (const w of mine) {
      const approved = w.approvedBy ? `approved by ${w.approvedBy}` : "not approved";
      const blocker = w.blocker ? `, blocker ${w.blocker}` : "";
      console.log(`  #${w.number} ${w.kind} entry ${w.entry} ${w.state} weight ${w.weight}, started by ${w.startedBy}, ${approved}${blocker}`);
    }
  }
  if (!repo && !live.length) console.log("no live workflows");
}

export const commands = {
  workflow: {
    summary: "workflow status [repo]: the live workflows of each tracked repo",
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      if (sub !== "status" || rest.length > 1) {
        console.error(USAGE);
        process.exit(1);
      }
      try {
        await status(rest[0]);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    },
  },
};
