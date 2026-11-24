// The new Home's mock read: started items of several repos, so each role sees what it may act on.
import type { Api } from "../client";
import type { MaintainHome, MaintainRow, MaintainStats, User } from "../types";
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

export function createMaintainMock(me: User): Pick<Api, "maintain"> {
  return {
    maintain: {
      // designcraft is on the new workflow in the mock; the other repos use the classic routes.
      async queue() {
        return { newRepos: ["designcraft"], approvedBy: { "designcraft#307": "ochre-fox", "designcraft#744": "kiri-n", "designcraft#779": "ochre-fox" } };
      },
      async stats(period): Promise<MaintainStats> {
        const n = period === "30d" ? 30 : 7;
        const perDay = Array.from({ length: n }, (_, i) => ({ day: new Date(Date.now() - (n - 1 - i) * 86400_000).toISOString().slice(0, 10), n: [14, 22, 9, 17, 25, 6, 3, 19, 21, 12][i % 10]! }));
        const merged = perDay.reduce((a, d) => a + d.n, 0);
        return new Promise((r) => setTimeout(() => r({ period, merged, implemented: Math.round(merged / 6), reviewed: Math.round(merged * 1.4), backlog: 25308, backlogChange: period === "30d" ? -212 : -48, spend: period === "30d" ? 412 : 96, perDay }), 60));
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
