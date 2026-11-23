// Memory and warm target of build step pods per repository. Both are automatic; a row in build_sizes holds what an
// operator set instead, or what an OOM kill taught.
//
// Memory, first match wins:
//   operator  an operator's size (`tasks sizes set --memory`): used as it is.
//   history   with AUTO_MIN_BUILDS measured builds in the last AUTO_DAYS days (the step pods' peak anonymous memory, as
//             TaskResult.peakMemBytes): the request is the median build's peak, the limit the highest peak with headroom.
//   oom       a step the kernel OOM-killed raised the memory the repository had then by OOM_RAISE (raiseAfterOom). The
//             raise is kept as a floor under the history size, so the next builds do not fall back below it.
//   environment  neither: the environment's memoryRequest and memoryLimit.
// Pods cap every size at maxPodMemory (pods.ts stepMemory).
//
// Warm target (src/build/warm-mount.ts): an operator's choice, or automatic from the size of the repository's last
// published warm version: in memory (`tmpfs`) when its memory-backed target needs at most AUTO_TMPFS_MAX_BYTES, on the
// task's volume (`pvc`) when larger, and `none` until a version is published.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";
import type { TaskResult } from "../../web/src/api/types.ts";
import { BuildError } from "./envs.ts";
import { quantity, type KubeSettings, type StepMemory } from "./pods.ts";
import { warmKeyOf } from "./tasks.ts";
import { WARM_TARGETS, warmTmpfsBytes, type WarmTarget } from "./warm-mount.ts";
import { warmBytes } from "./warm-queue.ts";

/** An OOM kill raises the request and the limit by this factor. */
export const OOM_RAISE = 1.5;
/** Measured builds the history size needs, and how far back it looks. */
export const AUTO_MIN_BUILDS = 3;
export const AUTO_BUILDS = 20;
export const AUTO_DAYS = 30;
/** The history limit: the highest peak times this, and at least this much above it (page cache and a heavier next commit). */
export const AUTO_LIMIT_FACTOR = 1.3;
export const AUTO_LIMIT_ROOM_BYTES = 2 * 1024 ** 3;
const AUTO_MIN_REQUEST_BYTES = 1024 ** 3;
/** The largest memory-backed warm target (warmTmpfsBytes of the version) the automatic choice puts in memory. */
export const AUTO_TMPFS_MAX_BYTES = 16 * 1024 ** 3;
const MiB = 1024 ** 2;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** History sizes are read again after this long; a raise or an operator's change clears them at once. */
const HISTORY_TTL_MS = 120_000;

export type MemorySource = "operator" | "history" | "oom" | "environment";
export type WarmSource = "operator" | "auto";
/** What a repository's step pods get and why. `memory` is null for `environment` (it depends on the environment). */
export type RepoSizing = {
  repo: string;
  memory: StepMemory | null; memorySource: MemorySource;
  /** The history size, also when another source wins; null below AUTO_MIN_BUILDS measured builds. */
  history: (StepMemory & { builds: number }) | null;
  warmTarget: WarmTarget; warmSource: WarmSource;
  /** The automatic warm target, also when an operator's wins, and the version size it follows. */
  autoWarmTarget: WarmTarget; warmBytes: number | null;
  /** The row: when it was written and by what. */
  updatedAt: string | null; reason: string | null;
};

const isTarget = (v: string | null | undefined): v is WarmTarget => (WARM_TARGETS as readonly string[]).includes(v ?? "");
const roundUp = (bytes: number): number => Math.ceil(bytes / MiB) * MiB;
const larger = (a: StepMemory, b: StepMemory): StepMemory => ({ requestBytes: Math.max(a.requestBytes, b.requestBytes), limitBytes: Math.max(a.limitBytes, b.limitBytes) });

/** The automatic warm target for a published version of `bytes`. */
export const autoWarmTarget = (bytes: number | null): WarmTarget =>
  !bytes ? "none" : warmTmpfsBytes(bytes) <= AUTO_TMPFS_MAX_BYTES ? "tmpfs" : "pvc";

const historyCache = new WeakMap<Db, Map<string, { at: number; v: RepoSizing["history"] }>>();
const forget = (db: Db, repo: string) => historyCache.get(db)?.delete(repo);

/** The size the repository's recent measured builds in Kubernetes environments call for; null below AUTO_MIN_BUILDS. */
export async function historyMemory(db: Db, repo: string): Promise<RepoSizing["history"]> {
  const cache = historyCache.get(db) ?? new Map();
  historyCache.set(db, cache);
  const hit = cache.get(repo);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.v;
  const since = new Date(Date.now() - AUTO_DAYS * 86400_000).toISOString();
  const rows = await db.all(db.k.selectFrom("build_tasks").select("results").where("repo", "=", repo).where("ended_at", ">=", since)
    .where("state", "in", ["done", "failed"]).where("results", "!=", "[]")
    .where("env_id", "in", db.k.selectFrom("build_envs").select("id").where("kind", "=", "kubernetes"))
    .orderBy("ended_at", "desc").limit(AUTO_BUILDS * 2));
  // One size serves every step of a task, so a build counts with its largest step.
  const peaks: number[] = [];
  for (const r of rows) {
    let results: TaskResult[] = [];
    try {
      results = JSON.parse(r.results) as TaskResult[];
    } catch {
      continue;
    }
    const p = Math.max(0, ...(Array.isArray(results) ? results : []).map((x) => typeof x?.peakMemBytes === "number" && Number.isFinite(x.peakMemBytes) ? x.peakMemBytes : 0));
    if (p > 0) peaks.push(p);
    if (peaks.length === AUTO_BUILDS) break;
  }
  let v: RepoSizing["history"] = null;
  if (peaks.length >= AUTO_MIN_BUILDS) {
    const p = [...peaks].sort((a, b) => a - b);
    const mid = p.length >> 1;
    const median = p.length % 2 ? p[mid]! : (p[mid - 1]! + p[mid]!) / 2;
    const max = p[p.length - 1]!;
    const limit = roundUp(Math.max(max * AUTO_LIMIT_FACTOR, max + AUTO_LIMIT_ROOM_BYTES));
    v = { requestBytes: Math.min(roundUp(Math.max(median, AUTO_MIN_REQUEST_BYTES)), limit), limitBytes: limit, builds: peaks.length };
  }
  cache.set(repo, { at: Date.now(), v });
  return v;
}

/** What `repo`'s step pods get and why. */
export async function repoSizing(db: Db, repo: string): Promise<RepoSizing> {
  const row = await db.get(db.k.selectFrom("build_sizes").selectAll().where("repo", "=", repo));
  const history = await historyMemory(db, repo);
  const own = row ? { requestBytes: Number(row.memory_request_bytes), limitBytes: Number(row.memory_limit_bytes) } : null;
  const source = row?.memory_source;
  const [memory, memorySource]: [StepMemory | null, MemorySource] =
    own && source === "operator" ? [own, "operator"]
    : own && source === "oom" ? [history ? larger(history, own) : own, "oom"]
    : history ? [{ requestBytes: history.requestBytes, limitBytes: history.limitBytes }, "history"]
    : [null, "environment"];
  const bytes = await warmBytes(db, warmKeyOf(repo));
  const auto = autoWarmTarget(bytes);
  const set = row?.warm_target;
  return {
    repo, memory, memorySource, history,
    warmTarget: isTarget(set) ? set : auto, warmSource: isTarget(set) ? "operator" : "auto", autoWarmTarget: auto, warmBytes: bytes,
    updatedAt: row?.updated_at ?? null, reason: row?.reason ?? null,
  };
}

/** Every repository with a row, plus `repos`, sorted. */
export async function listSizings(db: Db, repos: Iterable<string> = []): Promise<RepoSizing[]> {
  const rows = await db.all(db.k.selectFrom("build_sizes").select("repo"));
  const all = [...new Set([...rows.map((r) => r.repo), ...repos])].sort();
  const out: RepoSizing[] = [];
  for (const r of all) out.push(await repoSizing(db, r));
  return out;
}

/** The repository's step memory: its sizing's, or the environment's. Pods cap it at maxPodMemory (pods.ts stepMemory). */
export async function repoMemory(db: Db, repo: string, s: KubeSettings): Promise<StepMemory> {
  return (await repoSizing(db, repo)).memory ?? { requestBytes: quantity(s.memoryRequest), limitBytes: quantity(s.memoryLimit) };
}

/** Where the repository's build pods put a warm target. */
export async function repoWarmTarget(db: Db, repo: string): Promise<WarmTarget> {
  return (await repoSizing(db, repo)).warmTarget;
}

/** A row that holds neither an own memory nor a warm target is removed: the repository is automatic again. */
async function tidy(db: Db, repo: string): Promise<void> {
  await db.run(db.k.deleteFrom("build_sizes").where("repo", "=", repo).where("memory_source", "=", "auto").where("warm_target", "=", "auto"));
  forget(db, repo);
}

/** Sets the repository's warm target; `auto` returns it to the automatic choice. */
export async function setWarmTarget(db: Db, repo: string, target: string, by: string): Promise<void> {
  if (!REPO_RE.test(repo)) throw new BuildError(400, "repo is not valid");
  if (target !== "auto" && !isTarget(target)) throw new BuildError(400, `the warm target must be one of ${[...WARM_TARGETS, "auto"].join(", ")}`);
  const at = new Date().toISOString();
  await db.run(db.k.insertInto("build_sizes")
    .values({ repo, memory_request_bytes: 0, memory_limit_bytes: 0, memory_source: "auto", updated_at: at, reason: `set by ${by}`, warm_target: target })
    .onConflict((oc) => oc.column("repo").doUpdateSet({ warm_target: target, updated_at: at })));
  await tidy(db, repo);
  await audit(db, by, "build-warm-target-set", `repo:${repo}`, { warmTarget: target });
}

async function write(db: Db, repo: string, m: StepMemory, source: "operator" | "oom", reason: string): Promise<void> {
  await db.run(db.k.insertInto("build_sizes")
    .values({ repo, memory_request_bytes: m.requestBytes, memory_limit_bytes: m.limitBytes, memory_source: source, updated_at: new Date().toISOString(), reason, warm_target: "auto" })
    .onConflict((oc) => oc.column("repo").doUpdateSet(excluded(["memory_request_bytes", "memory_limit_bytes", "memory_source", "updated_at", "reason"]))));
  forget(db, repo);
}

/**
 * After a step of `repo` was OOM-killed: the memory it has now grows by OOM_RAISE, each at most the environment's
 * maxPodMemory and `nodeMaxBytes` (the largest node's allocatable memory, when known), and is kept as the repository's
 * floor. `raised` is false when the limit was already there, so a rerun would get no more memory.
 */
export async function raiseAfterOom(db: Db, repo: string, s: KubeSettings, nodeMaxBytes: number | null = null): Promise<{ memory: StepMemory; raised: boolean }> {
  const max = Math.min(quantity(s.maxPodMemory), nodeMaxBytes ?? Infinity);
  const before = await repoMemory(db, repo, s);
  const limit = Math.min(roundUp(before.limitBytes * OOM_RAISE), max);
  const memory = { requestBytes: Math.min(roundUp(before.requestBytes * OOM_RAISE), limit), limitBytes: limit };
  if (memory.limitBytes <= before.limitBytes && memory.requestBytes <= before.requestBytes) return { memory: before, raised: false };
  await write(db, repo, memory, "oom", `a step was OOM-killed at a ${gib(before.limitBytes)} limit`);
  return { memory, raised: true };
}

export const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2).replace(/\.?0+$/, "")} GiB`;

/** An operator's size for `repo`; the limit defaults to twice the request, the environments' ratio. */
export async function setBuildSize(db: Db, repo: string, requestBytes: number, limitBytes: number | null, by: string): Promise<StepMemory> {
  if (!REPO_RE.test(repo)) throw new BuildError(400, "repo is not valid");
  const limit = limitBytes ?? requestBytes * 2;
  if (!(requestBytes > 0) || !Number.isFinite(limit) || limit < requestBytes) throw new BuildError(400, "the memory request must be above 0 and at most the limit");
  const memory = { requestBytes: Math.ceil(requestBytes), limitBytes: Math.ceil(limit) };
  await write(db, repo, memory, "operator", `set by ${by}`);
  await audit(db, by, "build-size-set", `repo:${repo}`, memory);
  return memory;
}

/** Returns `repo`'s memory to automatic (an operator's size and an OOM floor both go); false when it had neither. */
export async function autoBuildSize(db: Db, repo: string, by: string): Promise<boolean> {
  const r = await db.run(db.k.updateTable("build_sizes").set({ memory_source: "auto", memory_request_bytes: 0, memory_limit_bytes: 0, updated_at: new Date().toISOString() })
    .where("repo", "=", repo).where("memory_source", "!=", "auto"));
  await tidy(db, repo);
  if (!r.changes) return false;
  await audit(db, by, "build-size-auto", `repo:${repo}`);
  return true;
}

/** Removes `repo`'s row, so memory and warm target are both automatic again; false when it had none. */
export async function clearBuildSize(db: Db, repo: string, by: string): Promise<boolean> {
  const r = await db.run(db.k.deleteFrom("build_sizes").where("repo", "=", repo));
  forget(db, repo);
  if (!r.changes) return false;
  await audit(db, by, "build-size-clear", `repo:${repo}`);
  return true;
}
