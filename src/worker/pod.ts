// `autocraft-server worker pod task|source|upload`: the AutoCraft-image phases of a build task that runs in Kubernetes
// pods (src/build/pods.ts). They run no repository code. The plan's steps run in their own pods, in the toolchain image,
// and the runner reads their results from pod status; nothing here reports a result.
//   task    (network `api`)   fetches the task with the pod key and writes it to the task's volume
//   source  (network `fetch`) source tarball, patch and CI-gate inputs into the volume; its termination message tells the runner what it found
//   upload  (network `api`)   uploads the artifacts of the steps that ran
//   disk    (first in every step pod) fails the pod when the task's volume holds more than the environment's size,
//           which a local-path volume does not enforce itself
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { PodTask } from "../build/tasks.ts";
import { WorkerApi } from "./client.ts";
import { gateInputs } from "./environment.ts";
import { collectArtifacts, contentTypeOf } from "./executor.ts";
import { resolveGate } from "./gate.ts";
import { applyPatch } from "./patch.ts";
import { downloadAndExtract } from "./tarball.ts";

const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
/** Kubernetes keeps at most 4096 bytes of a termination message. */
const MESSAGE_MAX = 4096;

type PodEnv = { work: string; message: string; key?: string; url?: string; ran: number; fetchImpl?: typeof fetch; log: (s: string) => void };

function podEnv(env: NodeJS.ProcessEnv = process.env): PodEnv {
  return {
    work: env.AUTOCRAFT_POD_WORK || "/work", message: env.AUTOCRAFT_POD_MESSAGE || "/dev/termination-log",
    key: env.AUTOCRAFT_POD_KEY, url: env.AUTOCRAFT_WORKER_URL, ran: Number(env.AUTOCRAFT_POD_RAN ?? 0),
    log: (s) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
  };
}

function api(e: PodEnv): WorkerApi {
  if (!e.key || !e.url) throw new Error("AUTOCRAFT_POD_KEY and AUTOCRAFT_WORKER_URL are required");
  return new WorkerApi(e.url, e.key, e.fetchImpl);
}

async function taskPhase(e: PodEnv): Promise<number> {
  const t = await api(e).podTask();
  writeFileSync(join(e.work, "task.json"), JSON.stringify(t), { mode: 0o600 });
  e.log(`task ${t.id}: ${t.repo}@${t.headSha.slice(0, 12)}, ${t.steps.length} step${t.steps.length === 1 ? "" : "s"}${t.patch ? ", with a patch" : ""}`);
  return 0;
}

/** Writes the report the runner reads from pod status. */
function report(e: PodEnv, o: object): void {
  let text = JSON.stringify(o);
  if (Buffer.byteLength(text) > MESSAGE_MAX) text = JSON.stringify({ ok: false, summary: "source: the CI gate's env is too large for a build pod's report" });
  writeFileSync(e.message, text);
}

async function sourcePhase(e: PodEnv): Promise<number> {
  const fail = (summary: string) => {
    e.log(summary);
    report(e, { ok: false, summary: summary.slice(0, 300) });
    return 1;
  };
  let t: PodTask;
  try {
    t = JSON.parse(readFileSync(join(e.work, "task.json"), "utf8")) as PodTask;
  } catch (err) {
    return fail(`source: the task file is missing (${(err as Error).message})`);
  }
  const src = join(e.work, "src");
  for (const d of [src, join(e.work, "target"), join(e.work, "cache", "cargo"), join(e.work, "ext"), join(e.work, "scratch"), ...t.steps.map((_, i) => join(e.work, "out", String(i)))]) {
    mkdirSync(d, { recursive: true });
  }
  e.log(`fetching source for ${t.repo}@${t.headSha.slice(0, 12)}`);
  try {
    e.log(`unpacked ${await downloadAndExtract(t.sourceUrl, src, MAX_SOURCE_BYTES, undefined, e.fetchImpl)} files`);
  } catch (err) {
    return fail(`source failed: ${(err as Error).message}`);
  }
  if (t.patch !== undefined) {
    const err = await applyPatch(t.patch, src, join(e.work, "scratch"));
    e.log(err ?? "patch applied");
    if (err) return fail(err);
  }
  const out = { ok: true, env: {} as Record<string, string>, mounts: [] as { sub: string; target: string }[], packages: [] as string[], craftFontsRef: null as string | null, craftI18nRev: null as string | null };
  try {
    const gate = t.baseSha ? await resolveGate(t.repo, t.baseSha, e.fetchImpl) : null;
    if (!t.baseSha || !gate) e.log(`${t.baseSha ? "no CI gate for this repo at the base commit" : "no base commit for this task"}; the steps run in the toolchain image as it is`);
    else {
      const g = await gateInputs(e.work, t.repo, t.baseSha, gate, { fetchImpl: e.fetchImpl, log: e.log });
      const root = realpathSync(e.work);
      Object.assign(out, { env: g.env, packages: gate.packages, craftFontsRef: gate.craftFontsRef, craftI18nRev: g.craftI18nRev, mounts: g.mounts.map((m) => ({ sub: relative(root, realpathSync(m.source)), target: m.target })) });
      e.log(`environment: gate ${gate.gateRef} (gate.yml sha256 ${gate.gateSha256?.slice(0, 16) ?? "unknown"}), packages ${gate.packages.join(" ") || "none"}, craft-fonts ${gate.craftFontsRef?.slice(0, 12) ?? "none"}, craft-i18n ${g.craftI18nRev?.slice(0, 12) ?? "none"}, gate env ${Object.keys(gate.env).join(", ") || "none"}`);
    }
  } catch (err) {
    return fail(`environment failed: ${(err as Error).message}`);
  }
  report(e, out);
  return 0;
}

async function uploadPhase(e: PodEnv): Promise<number> {
  const client = api(e);
  const t = await client.podTask();
  const taken = new Set<string>();
  const budget = { total: 0, count: 0 };
  let n = 0;
  for (const [i, step] of t.steps.slice(0, e.ran).entries()) {
    if (!step.artifacts.length) continue;
    for (const f of collectArtifacts(join(e.work, "out", String(i)), step.artifacts, taken, budget, e.log)) {
      await client.upload(t.id, f.name, readFileSync(f.path), contentTypeOf(f.name));
      e.log(`uploaded ${f.name} (${f.bytes} bytes)`);
      n++;
    }
  }
  e.log(`${n} artifact${n === 1 ? "" : "s"} uploaded`);
  return 0;
}

/** Stops counting past this many entries: a tree that large fails the check as well. */
const DISK_MAX_ENTRIES = 2_000_000;

/** Space used under `root` (allocated blocks), without following links; null past DISK_MAX_ENTRIES entries. */
export function usedBytes(root: string): number | null {
  let total = 0, entries = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (++entries > DISK_MAX_ENTRIES) return null;
      const p = join(dir, n);
      try {
        const st = lstatSync(p);
        total += st.blocks * 512;
        if (st.isDirectory()) stack.push(p);
      } catch { /* removed meanwhile */ }
    }
  }
  return total;
}

function diskPhase(e: PodEnv, limit: number): number {
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  const used = usedBytes(e.work);
  const over = used === null ? `the task's volume holds more than ${DISK_MAX_ENTRIES} files` : used > limit ? `the task's volume holds ${gb(used)} GB, over its ${gb(limit)} GB` : null;
  e.log(over ?? `the task's volume holds ${gb(used!)} GB of ${gb(limit)} GB`);
  if (!over) return 0;
  writeFileSync(e.message, over);
  return 4;
}

export async function podPhase(phase: string | undefined, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<number> {
  const e = { ...podEnv(env), ...(fetchImpl ? { fetchImpl } : {}) };
  try {
    if (phase === "task") return await taskPhase(e);
    if (phase === "source") return await sourcePhase(e);
    if (phase === "upload") return await uploadPhase(e);
    if (phase === "disk") return diskPhase(e, Number(env.AUTOCRAFT_POD_DISK_LIMIT) || 0);
  } catch (err) {
    e.log(`${phase} failed: ${(err as Error).message}`);
    return 1;
  }
  e.log("usage: autocraft-server worker pod task|source|upload|disk");
  return 2;
}
