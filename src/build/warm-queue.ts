// The warm producer's queue: step `warm` tasks build the current default-branch head of each repo in the pipeline scope
// for the warm store (src/build/pods.ts warmPod, src/warm/). Only environments with `warmWriter` take them (tasks.ts claim).
// - The main-CI poll calls warmPass: a repo whose current head (main_ci) has no warm build with the writer's toolchain
//   image gets one queued task, unless one is already queued or running. A new head or a new toolchain image both count.
// - At claim the queued task takes the newest head, so merges that land while it waits share one build (warmClaim).
// - Builds of one repo start at least warm_min_interval_minutes apart (default 15): a burst of merges coalesces into one
//   publish. A head whose warm build failed is not built again; the next head is.
// - The warm store's gc runs in the producer pod at most once a day (takeGc, releaseGc).
import type { TaskStep } from "../../web/src/api/types.ts";
import { audit } from "../dash/audit.ts";
import { baseScopeRepos } from "../pilot.ts";
import { setting, writeSetting } from "../settings-read.ts";
import { warmPlan } from "../worker/rust.ts";
import type { Db } from "../db/index.ts";
import { BuildError } from "./envs.ts";
import { settingsOf, toolchainImage, type KubeSettings } from "./pods.ts";
import { createTask, warmKeyOf, WARM_STEP } from "./tasks.ts";

export const WARM_INTERVAL_KEY = "warm_min_interval_minutes";
export const WARM_INTERVAL_DEFAULT = 15;
const WARM_INTERVAL_MAX = 24 * 60;
export const WARM_GC_KEY = "warm_gc_at";
export const WARM_GC_EVERY_MS = 24 * 3600_000;
/** Below every PR build; the warm environment takes no other task, so this orders only the Builds list. */
export const WARM_PRIORITY = -10;
const TOOLCHAINS = ["rust-stable"];

export async function warmMinInterval(db: Db): Promise<number> {
  const v = await setting(db, WARM_INTERVAL_KEY);
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= WARM_INTERVAL_MAX ? n : WARM_INTERVAL_DEFAULT;
}

export async function setWarmMinInterval(db: Db, input: string, by: string): Promise<number> {
  const n = /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > WARM_INTERVAL_MAX) throw new BuildError(400, `the minimum minutes between warm builds must be a whole number from 0 to ${WARM_INTERVAL_MAX}`);
  const was = await warmMinInterval(db);
  await writeSetting(db, WARM_INTERVAL_KEY, String(n));
  if (n !== was) await audit(db, by, "warm-min-interval", "builds", { minutes: n, was });
  return n;
}

/**
 * The current default-branch head of `repo`: the head the latest main-CI poll saw. Every poll refreshes `updated_at` of the
 * head it reads, so this stays right after the branch is force-pushed back to a commit older than one stored earlier.
 */
export async function mainHead(db: Db, repo: string): Promise<string | null> {
  const r = await db.get(db.k.selectFrom("main_ci").select("head_sha").where("repo", "=", repo)
    .orderBy("updated_at", "desc").orderBy("first_seen_at", "desc").limit(1));
  return r?.head_sha ?? null;
}

const warmTasks = (db: Db, repo: string) => db.k.selectFrom("build_tasks").where("repo", "=", repo).where("step", "=", WARM_STEP);

/** A warm build at `head` with `image` already ended (done or failed); one that failed before its environment was known counts for the image it was queued with. */
async function attempted(db: Db, repo: string, head: string, image: string): Promise<boolean> {
  const rows = await db.all(warmTasks(db, repo).select(["sandbox_env", "warm_image"]).where("head_sha", "=", head).where("state", "in", ["done", "failed"]));
  return rows.some((r) => {
    if (!r.sandbox_env) return !r.warm_image || r.warm_image === image;
    try {
      return (JSON.parse(r.sandbox_env) as { image?: string }).image === image;
    } catch {
      return true;
    }
  });
}

const open = async (db: Db, repo: string, states: string[]): Promise<boolean> =>
  !!await db.get(warmTasks(db, repo).select("id").where("state", "in", states).limit(1));

/** Queues a warm build of `repo` for the writer `s` when its head needs one; returns the task id, or null. */
export async function queueWarm(db: Db, repo: string, s: KubeSettings): Promise<number | null> {
  const head = await mainHead(db, repo);
  const image = toolchainImage(s, TOOLCHAINS);
  if (!head || !image || await open(db, repo, ["queued", "claimed", "running"]) || await attempted(db, repo, head, image)) return null;
  try {
    return await createTask(db, {
      step: WARM_STEP, repo, headSha: head, baseSha: head, requires: { os: "linux", toolchains: [...TOOLCHAINS] }, priority: WARM_PRIORITY,
      plan: warmPlan({ mirror: !!s.crateMirror }), warm: { key: warmKeyOf(repo), role: "build" }, warmImage: image,
    });
  } catch (e) {
    if (e instanceof BuildError) return null;
    throw e;
  }
}

/** The settings of the enabled warm writers. */
async function writers(db: Db): Promise<KubeSettings[]> {
  return (await db.all(db.k.selectFrom("build_envs").select("settings").where("kind", "=", "kubernetes").where("enabled", "=", 1).orderBy("id")))
    .map((r) => settingsOf(r.settings)).filter((s) => s.warmWriter);
}

/** Queues the warm builds the repos in the pipeline scope need; returns how many. Nothing without an enabled warm writer. */
export async function warmPass(db: Db): Promise<number> {
  const w = (await writers(db))[0];
  if (!w) return 0;
  let n = 0;
  for (const repo of [...await baseScopeRepos(db)].sort()) if (await queueWarm(db, repo, w) !== null) n++;
  return n;
}

/**
 * At claim, for a writer with settings `s`: the head and plan a queued warm task of `repo` runs with, or null while it must
 * wait (another warm build of the repo runs, the last one started under the minimum interval ago, or the newest head was
 * already built with this image).
 */
export async function warmClaim(db: Db, repo: string, s: KubeSettings, nowMs: number): Promise<{ head: string; plan: TaskStep[] } | null> {
  const head = await mainHead(db, repo);
  const image = toolchainImage(s, TOOLCHAINS);
  if (!head || !image || await open(db, repo, ["claimed", "running"])) return null;
  const since = new Date(nowMs - (await warmMinInterval(db)) * 60_000).toISOString();
  if (await db.get(warmTasks(db, repo).select("id").where("claimed_at", ">", since).limit(1))) return null;
  if (await attempted(db, repo, head, image)) return null;
  return { head, plan: warmPlan({ mirror: !!s.crateMirror }) };
}

/** A failed gc is tried again this long after it was taken. */
export const WARM_GC_RETRY_MS = 3 * 3600_000;

/**
 * Takes the day's gc for one warm pod: true when none ran or was taken in the last day. The time is written in the same
 * statement that decides, so pods created in one pass do not all run gc.
 */
export async function takeGc(db: Db, nowMs: number): Promise<boolean> {
  const cur = await db.get(db.k.selectFrom("main.settings").select("value").where("key", "=", WARM_GC_KEY));
  const at = new Date(nowMs).toISOString();
  if (!cur) return (await db.run(db.k.insertInto("main.settings").values({ key: WARM_GC_KEY, value: at }).onConflict((oc) => oc.column("key").doNothing()))).changes > 0;
  if (nowMs - Date.parse(cur.value ?? "") < WARM_GC_EVERY_MS) return false;
  return (await db.run(db.k.updateTable("main.settings").set({ value: at }).where("key", "=", WARM_GC_KEY).where("value", "=", cur.value))).changes > 0;
}

/** A gc that failed: the day's gc is due again after WARM_GC_RETRY_MS. */
export const releaseGc = async (db: Db, nowMs: number): Promise<void> =>
  await writeSetting(db, WARM_GC_KEY, new Date(nowMs - WARM_GC_EVERY_MS + WARM_GC_RETRY_MS).toISOString());

/** Bytes of a key's newest published version, from its last publish: what the next build's target is expected to hold. */
const bytesKey = (key: string) => `warm_bytes:${key}`;
export async function warmBytes(db: Db, key: string): Promise<number | null> {
  const n = Number(await setting(db, bytesKey(key)));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export const recordWarmBytes = async (db: Db, key: string, bytes: number): Promise<void> => {
  if (Number.isSafeInteger(bytes) && bytes > 0) await writeSetting(db, bytesKey(key), String(bytes));
};
