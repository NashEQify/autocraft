// Switches for the build features. A repo-scoped feature has one switch per repo, `build_feature:<f>:<repo>`; scan-tests
// has one instance-wide switch, `build_feature:scan-tests`. A missing row means off. The pipeline switch stops them all,
// since every feature step runs in a pipeline job.
import { audit } from "../dash/audit.ts";
import { TERMINAL, cancelTask } from "./tasks.ts";
import { setting } from "../settings-read.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { like, likeEscape, excluded } from "../db/kx.ts";

export const BUILD_FEATURES = ["screenshots", "push-tests", "batch-build", "scan-tests", "nightly", "pr-builds", "implement"] as const;
export type BuildFeature = (typeof BUILD_FEATURES)[number];

/** Features switched per repo; the rest have one instance-wide switch. */
export const REPO_SCOPED: Record<BuildFeature, boolean> = {
  screenshots: true, "push-tests": true, "batch-build": true, "scan-tests": false, nightly: true, "pr-builds": true, implement: true,
};

/**
 * The features whose switches the dashboard shows: those whose build tasks the cluster's build pods can run today. The others
 * keep their code and stored state. Screenshots need a display, which build pods do not offer (kubeCapabilities); the nightly
 * checks need the rust-audit, rust-cross and rust-nightly toolchain images; PR builds wait while CI stays in GitHub Actions;
 * scan tests need a confidential build environment.
 */
export const SHOWN_FEATURES: readonly BuildFeature[] = ["push-tests", "batch-build", "implement"];

export const isFeature = (s: unknown): s is BuildFeature => typeof s === "string" && (BUILD_FEATURES as readonly string[]).includes(s);

const keyOf = (f: BuildFeature, repo?: string): string => (repo ? `build_feature:${f}:${repo}` : `build_feature:${f}`);

const read = async (db: Db, key: string): Promise<boolean> =>
  await setting(db, key) === "on";

/** A repo-scoped feature reads the repo's switch (off without a repo); scan-tests reads its instance-wide switch. */
export async function featureOn(db: Db, f: BuildFeature, repo?: string): Promise<boolean> {
  if (!REPO_SCOPED[f]) return await read(db, keyOf(f));
  return repo !== undefined && await read(db, keyOf(f, repo));
}

/** The repos a repo-scoped feature is on for, sorted. */
export async function featureRepos(db: Db, f: BuildFeature): Promise<string[]> {
  if (!REPO_SCOPED[f]) return [];
  const prefix = `build_feature:${f}:`;
  return (await db.all(db.k.selectFrom("settings").select("key")
    .where((eb) => like(db, "key", eb.val(`${likeEscape(prefix)}%`), "\\")).where("value", "=", "on")))
    .map((r) => r.key.slice(prefix.length)).sort();
}

/** A repo-scoped feature needs `repo`; scan-tests takes none. */
export async function setFeature(db: Db, f: BuildFeature, on: boolean, by: string, repo?: string): Promise<void> {
  if (REPO_SCOPED[f] && repo === undefined) throw new Error(`${f} is switched per repo`);
  const scoped = REPO_SCOPED[f] ? repo : undefined;
  await db.run(db.k.insertInto("settings").values({ key: keyOf(f, scoped), value: on ? "on" : "off" }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  await audit(db, by, "build-feature", f, { feature: f, on, repo: scoped ?? null });
  if (!on) await stopQueuedTasks(db, f, by, scoped);
}

/** Build tasks of the features whose untrusted work is queued by the pipeline; a switch turned off stops them. */
const FEATURE_STEP: Partial<Record<BuildFeature, string>> = { "pr-builds": "pr-build", nightly: "nightly", screenshots: "screenshot" };

/** Cancels the queued and running tasks of a feature that was switched off (for one repo, or every repo), and marks the PR builds stale. */
async function stopQueuedTasks(db: Db, f: BuildFeature, by: string, repo?: string): Promise<void> {
  const step = FEATURE_STEP[f];
  if (!step) return;
  const rows = await db.all(db.k.selectFrom("build_tasks").select("id").where("step", "=", step).where("state", "not in", TERMINAL)
    .$if(!!repo, (q) => q.where("repo", "=", repo!)));
  for (const r of rows) await cancelTask(db, r.id, by);
  const now = new Date().toISOString();
  if (f === "screenshots") {
    await db.run(db.k.updateTable("main.screenshot_runs").set({ state: "skipped", reason: "screenshots switched off", finished_at: now })
      .where("state", "in", ["planned", "running"]).$if(!!repo, (q) => q.where("repo", "=", repo!)));
  }
  if (f === "pr-builds") {
    await db.run(db.k.updateTable("main.pr_builds").set({ state: "stale", finished_at: now }).where("state", "=", "queued")
      .$if(!!repo, (q) => q.where("repo", "=", repo!)));
  }
}

export async function featureStates(db: Db): Promise<{ feature: BuildFeature; on: boolean; repos: string[] }[]> {
  return await mapSeq(BUILD_FEATURES, async (feature) => ({ feature, on: REPO_SCOPED[feature] ? false : await read(db, keyOf(feature)), repos: await featureRepos(db, feature) }));
}
