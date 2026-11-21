// Operator switches for the build features. Stored in settings as `build_feature:<f>` and, for repo-scoped
// features, `build_feature:<f>:<repo>`; a missing row means off.
import { audit } from "../dash/audit.ts";
import { TERMINAL, cancelTask } from "./tasks.ts";
import { setting } from "../settings-read.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export const BUILD_FEATURES = ["screenshots", "push-tests", "batch-build", "scan-tests", "nightly", "pr-builds"] as const;
export type BuildFeature = (typeof BUILD_FEATURES)[number];

/** Repo-scoped features need the global switch and the repo's own switch. */
export const REPO_SCOPED: Record<BuildFeature, boolean> = {
  screenshots: true, "push-tests": true, "batch-build": true, "scan-tests": false, nightly: true, "pr-builds": true,
};

export const isFeature = (s: unknown): s is BuildFeature => typeof s === "string" && (BUILD_FEATURES as readonly string[]).includes(s);

const keyOf = (f: BuildFeature, repo?: string): string => (repo ? `build_feature:${f}:${repo}` : `build_feature:${f}`);

const read = async (db: Db, key: string): Promise<boolean> =>
  await setting(db, key) === "on";

/** Without `repo` a repo-scoped feature reports its global switch; callers that loop repos must pass the repo. */
export async function featureOn(db: Db, f: BuildFeature, repo?: string): Promise<boolean> {
  if (!await read(db, keyOf(f))) return false;
  if (!REPO_SCOPED[f] || repo === undefined) return true;
  return await read(db, keyOf(f, repo));
}

export async function setFeature(db: Db, f: BuildFeature, on: boolean, by: string, repo?: string): Promise<void> {
  const scoped = REPO_SCOPED[f] ? repo : undefined;
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(keyOf(f, scoped), on ? "on" : "off");
  await audit(db, by, "build-feature", f, { feature: f, on, repo: scoped ?? null });
  if (!on) await stopQueuedTasks(db, f, by, scoped);
}

/** Build tasks of the features whose untrusted work is queued by the pipeline; a switch turned off stops them. */
const FEATURE_STEP: Partial<Record<BuildFeature, string>> = { "pr-builds": "pr-build", nightly: "nightly", screenshots: "screenshot" };

/** Cancels the queued and running tasks of a feature that was switched off (for one repo, or every repo), and marks the PR builds stale. */
async function stopQueuedTasks(db: Db, f: BuildFeature, by: string, repo?: string): Promise<void> {
  const step = FEATURE_STEP[f];
  if (!step) return;
  const open = TERMINAL.map((s) => `'${s}'`).join(", ");
  const rows = await db.prepare(`SELECT id FROM build_tasks WHERE step = ? AND state NOT IN (${open}) ${repo ? "AND repo = ?" : ""}`).all(...(repo ? [step, repo] : [step])) as { id: number }[];
  for (const r of rows) await cancelTask(db, r.id, by);
  if (f === "screenshots") {
    await db.prepare(`UPDATE main.screenshot_runs SET state = 'skipped', reason = 'screenshots switched off', finished_at = ? WHERE state IN ('planned', 'running') ${repo ? "AND repo = ?" : ""}`).run(...(repo ? [new Date().toISOString(), repo] : [new Date().toISOString()]));
  }
  if (f === "pr-builds") {
    await db.prepare(`UPDATE main.pr_builds SET state = 'stale', finished_at = ? WHERE state = 'queued' ${repo ? "AND repo = ?" : ""}`).run(...(repo ? [new Date().toISOString(), repo] : [new Date().toISOString()]));
  }
}

export async function featureStates(db: Db): Promise<{ feature: BuildFeature; on: boolean; repos: string[] }[]> {
  return await mapSeq(BUILD_FEATURES, async (feature) => {
    const repos = REPO_SCOPED[feature]
      ? (await db.prepare("SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\' AND value = 'on'").all(`build\\_feature:${feature}:%`) as { key: string }[])
        .map((r) => r.key.slice(`build_feature:${feature}:`.length)).sort()
      : [];
    return { feature, on: await read(db, keyOf(feature)), repos };
  });
}
