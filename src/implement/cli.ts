// Operator tool: run the build of an issue's current implementation attempt from the command line, in this process:
// the session in the attempt's workspace (on the queuer's Task Runner), AutoCraft's checks and the follow-up turns, until
// the attempt is ready for its PR or stuck. With --no-pr nothing is written to GitHub; a stuck attempt still asks its decision.
//
//   autocraft-server implement run REPO#N --no-pr
import { openDb } from "../db/open.ts";
import { runBuild } from "./build.ts";
import { currentImplementation } from "./store.ts";
import { BUILD_STATES } from "./types.ts";

const USAGE = "usage: implement run REPO#N --no-pr";
/** Units one command runs at most: the session, three follow-ups and their checks, with room for retries. */
const UNITS_MAX = 16;

function parseArgs(args: string[]): { repo: string; number: number; noPr: boolean } {
  if (args[0] !== "run") throw new Error(USAGE);
  let ref: string | undefined, noPr = false;
  for (const a of args.slice(1)) {
    if (a === "--no-pr") noPr = true;
    else if (!ref && !a.startsWith("--")) ref = a;
    else throw new Error(`unknown argument ${a}; ${USAGE}`);
  }
  const m = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(ref ?? "");
  if (!m) throw new Error(USAGE);
  return { repo: m[1]!, number: Number(m[2]), noPr };
}

export const commands = {
  implement: {
    summary: "implement run REPO#N --no-pr: run the session, AutoCraft's checks and the follow-up turns of the issue's current attempt (its plan must be stored) until it is ready for its PR or stuck; writes nothing to GitHub",
    async run(args: string[]): Promise<void> {
      const a = parseArgs(args);
      if (!a.noPr) throw new Error(`opening the PR from the command line is not offered; ${USAGE}`);
      const db = await openDb();
      const cur = await currentImplementation(db, a.repo, a.number);
      if (!cur) throw new Error(`${a.repo}#${a.number} has no current implementation attempt`);
      if (!cur.plan) throw new Error(`${a.repo}#${a.number}: attempt ${cur.attempt} has no stored plan (state ${cur.state}); plan it first`);
      const run = {
        db, log: (l: string) => console.log(l), progress: async (t: string) => console.log(`… ${t}`),
        cancelled: async () => false, stopping: async () => false, startedMs: Date.now(), noPr: true,
      };
      for (let n = 0; n < UNITS_MAX; n++) {
        const r = await runBuild({ ...run, startedMs: Date.now() }, a.repo, a.number);
        console.log(r.summary);
        const now = await currentImplementation(db, a.repo, a.number);
        if (!now || now.state === "opening" || !BUILD_STATES.has(now.state) || !r.moved) {
          process.exitCode = now?.state === "opening" ? 0 : 2;
          return;
        }
      }
      console.log(`stopped after ${UNITS_MAX} steps`);
      process.exitCode = 2;
    },
  },
};
