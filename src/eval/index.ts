// CLI of the self-evaluation: `autocraft-server eval repo [<name> | --clear]`, `eval run` and `eval status`.
// Operator only: the box's shell is the operator's.
import { CLI_BY } from "../core/gates.ts";
import { loadEvalCauses } from "../data/eval/index.ts";
import { openDb } from "../db/open.ts";
import { evalRepo, setEvalRepo } from "./schedule.ts";

const USAGE = "eval repo [<name> | --clear] | eval run | eval status";

export const commands = {
  eval: {
    summary: `${USAGE}: the hourly self-evaluation and the repo it files issues on`,
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      const db = await openDb();
      if (sub === "repo") {
        if (rest.length > 1) throw new Error(`usage: autocraft-server ${USAGE}`);
        if (rest[0] !== undefined) await setEvalRepo(db, rest[0] === "--clear" ? null : rest[0], "cli");
        console.log(`eval_repo ${await evalRepo(db) ?? "(off)"}`);
      } else if (sub === "run" && !rest.length) {
        const repo = await evalRepo(db);
        if (!repo) throw new Error("no eval repo is set: autocraft-server eval repo <name>");
        const { runEval } = await import("./run.ts");
        await runEval(db, { repo, by: CLI_BY });
      } else if (sub === "status" && !rest.length) {
        for (const c of [...(await loadEvalCauses(db)).values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))) {
          console.log(`${c.key}  ${c.state}${c.verdict ? ` ${c.verdict}` : ""}${c.issueNumber ? ` issue ${c.issueNumber}` : ""}  seen ${c.seen}  last ${c.lastSeen.slice(0, 16)}`);
        }
      } else throw new Error(`usage: autocraft-server ${USAGE}`);
    },
  },
};
