// The new Home's mock read: started items of several repos, so each role sees what it may act on.
import type { Api } from "../client";
import type { MaintainHome, MaintainRepo, MaintainRow, User } from "../types";
import { requestProject } from "../scope";
import { NOW } from "./fixtures";

const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const row = (r: Partial<MaintainRow> & Pick<MaintainRow, "repo" | "number" | "title" | "line">): MaintainRow => ({
  kind: "pr", author: "pixel-wrangler", entry: "review", waits: false, blocked: false, weight: null, startedBy: "kiri-n", approvedBy: null, stoppedBy: null, updatedAt: ago(5), ...r,
});

const ROWS: MaintainRow[] = [
  row({ repo: "photocraft", number: 812, title: "Crop handles snap past the canvas edge", author: "larkspur-dev", line: "Fix both problems, then merge?", waits: true, entry: "fixup", updatedAt: ago(3) }),
  row({ repo: "photocraft", number: 798, title: "Layer panel keeps the selection after undo", author: "quietgrid", line: "Review the author's new commits, fix what it finds, then merge?", waits: true, blocked: true, approvedBy: "ochre-fox", updatedAt: ago(9) }),
  row({ repo: "designcraft", number: 455, title: "Snap guides ignore hidden layers", author: "sable-ui", line: "Waiting for a clear answer", waits: true, startedBy: "ochre-fox", updatedAt: ago(21) }),
  row({ repo: "wordcraft", number: 233, title: "Tracked changes lose the author on paste", author: "rhea-m", line: "Merge as it is?", waits: true, startedBy: "ochre-fox", updatedAt: ago(40) }),
  row({ repo: "deckcraft", number: 77, kind: "issue", title: "Export speaker notes", author: "brushstroke42", line: "Running: implement", entry: "implement", weight: "high", startedBy: "kiri-n", updatedAt: ago(12) }),
  row({ repo: "photocraft", number: 840, title: "Selection tools: four changes", author: "pixel-wrangler", line: "Waiting: batch", entry: "merge", startedBy: "ochre-fox", approvedBy: "ochre-fox", updatedAt: ago(30) }),
];

const REPOS: MaintainRepo[] = [
  { name: "photocraft", workflow: "new", automatic: true, canRun: false, open: 186, started: 9, waiting: 3, mergedWeek: 31, trips: [{ key: "cifix:photocraft", text: "CI fixes paused on photocraft: failed 5 times in an hour", since: ago(95), canResume: false }] },
  { name: "designcraft", workflow: "new", automatic: true, canRun: false, open: 94, started: 3, waiting: 1, mergedWeek: 12, trips: [] },
  { name: "wordcraft", workflow: "legacy", automatic: false, canRun: false, open: 41, started: 0, waiting: 0, mergedWeek: 6, trips: [] },
  { name: "deckcraft", workflow: "legacy", automatic: false, canRun: false, open: 32, started: 1, waiting: 0, mergedWeek: 3, trips: [] },
];

export function createMaintainMock(me: User): Pick<Api, "maintain"> {
  const repos = structuredClone(REPOS);
  return {
    maintain: {
      async repos(): Promise<MaintainRepo[]> {
        const mine = repos.map((r) => ({ ...r, canRun: me.runRepos.includes(r.name), trips: r.trips.map((t) => ({ ...t, canResume: me.runRepos.includes(r.name) })) }));
        return new Promise((res) => setTimeout(() => res(structuredClone(mine)), 60));
      },
      async control(input) {
        if (input.control === "set-automatic") {
          const r = repos.find((x) => x.name === input.repo);
          if (r) r.automatic = input.on;
          return { ok: true, line: `Automatic work is ${input.on ? "on" : "off"} for ${input.repo}.` };
        }
        for (const r of repos) r.trips = r.trips.filter((t) => t.key !== input.key);
        return { ok: true, line: `Resumed ${input.key}.` };
      },
      async home(): Promise<MaintainHome> {
        const repo = requestProject();
        const rows = ROWS.filter((r) => !repo || r.repo === repo);
        const attention: MaintainHome["attention"] = (!repo || repo === "photocraft") ? [{ kind: "stopped", title: "Fix-up stopped by the breaker in photocraft", detail: me.role === "viewer" ? "" : "3 pushes in a row broke CI on photocraft; resume after a look.", to: "/needs/stopped" }] : [];
        const by = (l: string | null) => l === me.login;
        const home: MaintainHome =
          me.role === "viewer"
            ? { needs: [], mine: [], waiting: rows.filter((r) => r.waits), running: rows.filter((r) => !r.waits), runner: null, attention }
            : {
                needs: rows.filter((r) => r.waits && me.runRepos.includes(r.repo)),
                mine: rows.filter((r) => !(r.waits && me.runRepos.includes(r.repo)) && (by(r.startedBy) || by(r.approvedBy) || by(r.stoppedBy))),
                waiting: [], running: [],
                runner: me.role === "operator" ? { mine: [{ name: "laptop", online: true, running: 1 }], others: 2 } : { mine: [], others: 3 },
                attention,
              };
        return new Promise((r) => setTimeout(() => r(structuredClone(home)), 60));
      },
    },
  };
}
