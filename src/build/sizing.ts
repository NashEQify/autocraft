// Memory of build step pods per repository (table build_sizes). A repository without a row gets its environment's
// memoryRequest and memoryLimit. A step the kernel OOM-killed raises its repository's request and limit (raiseAfterOom),
// up to the environment's maxPodMemory; an operator sets or clears a size with `tasks sizes`.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";
import { BuildError } from "./envs.ts";
import { quantity, type KubeSettings, type StepMemory } from "./pods.ts";

/** An OOM kill raises the request and the limit by this factor. */
export const OOM_RAISE = 1.5;
const MiB = 1024 ** 2;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export type BuildSize = StepMemory & { repo: string; updatedAt: string; reason: string };

const roundUp = (bytes: number): number => Math.ceil(bytes / MiB) * MiB;

export async function listBuildSizes(db: Db): Promise<BuildSize[]> {
  const rows = await db.all(db.k.selectFrom("build_sizes").selectAll().orderBy("repo"));
  return rows.map((r) => ({ repo: r.repo, requestBytes: Number(r.memory_request_bytes), limitBytes: Number(r.memory_limit_bytes), updatedAt: r.updated_at, reason: r.reason }));
}

/** The repository's step memory: its own size, or the environment's when it has none. Pods cap it at maxPodMemory (pods.ts stepMemory). */
export async function repoMemory(db: Db, repo: string, s: KubeSettings): Promise<StepMemory> {
  const r = await db.get(db.k.selectFrom("build_sizes").select(["memory_request_bytes", "memory_limit_bytes"]).where("repo", "=", repo));
  return r
    ? { requestBytes: Number(r.memory_request_bytes), limitBytes: Number(r.memory_limit_bytes) }
    : { requestBytes: quantity(s.memoryRequest), limitBytes: quantity(s.memoryLimit) };
}

async function write(db: Db, repo: string, m: StepMemory, reason: string): Promise<void> {
  await db.run(db.k.insertInto("build_sizes")
    .values({ repo, memory_request_bytes: m.requestBytes, memory_limit_bytes: m.limitBytes, updated_at: new Date().toISOString(), reason })
    .onConflict((oc) => oc.column("repo").doUpdateSet(excluded(["memory_request_bytes", "memory_limit_bytes", "updated_at", "reason"]))));
}

/**
 * After a step of `repo` was OOM-killed: its request and limit grow by OOM_RAISE, each at most the environment's maxPodMemory.
 * `raised` is false when the limit was already there, so a rerun would get no more memory.
 */
export async function raiseAfterOom(db: Db, repo: string, s: KubeSettings): Promise<{ memory: StepMemory; raised: boolean }> {
  const max = quantity(s.maxPodMemory);
  const before = await repoMemory(db, repo, s);
  const limit = Math.min(roundUp(before.limitBytes * OOM_RAISE), max);
  const memory = { requestBytes: Math.min(roundUp(before.requestBytes * OOM_RAISE), limit), limitBytes: limit };
  if (memory.limitBytes <= before.limitBytes && memory.requestBytes <= before.requestBytes) return { memory: before, raised: false };
  await write(db, repo, memory, `a step was OOM-killed at a ${gib(before.limitBytes)} limit`);
  return { memory, raised: true };
}

export const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2).replace(/\.?0+$/, "")} GiB`;

/** An operator's size for `repo`; the limit defaults to twice the request, the environments' ratio. */
export async function setBuildSize(db: Db, repo: string, requestBytes: number, limitBytes: number | null, by: string): Promise<StepMemory> {
  if (!REPO_RE.test(repo)) throw new BuildError(400, "repo is not valid");
  const limit = limitBytes ?? requestBytes * 2;
  if (!(requestBytes > 0) || !Number.isFinite(limit) || limit < requestBytes) throw new BuildError(400, "the memory request must be above 0 and at most the limit");
  const memory = { requestBytes: Math.ceil(requestBytes), limitBytes: Math.ceil(limit) };
  await write(db, repo, memory, `set by ${by}`);
  await audit(db, by, "build-size-set", `repo:${repo}`, memory);
  return memory;
}

/** Removes `repo`'s size, so its pods get the environment's again; false when it had none. */
export async function clearBuildSize(db: Db, repo: string, by: string): Promise<boolean> {
  const r = await db.run(db.k.deleteFrom("build_sizes").where("repo", "=", repo));
  if (!r.changes) return false;
  await audit(db, by, "build-size-clear", `repo:${repo}`);
  return true;
}
