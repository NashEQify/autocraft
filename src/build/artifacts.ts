// Artifacts returned by workers: files under one directory, metadata in
// build_artifacts. The bytes are untrusted. Their type comes from sniffing
// them, only a few kinds are accepted, and nothing here ever executes or
// renders them.
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { dataDir } from "../db.ts";
import { envVar } from "../env.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const MAX_TASK_ARTIFACT_BYTES = 200 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_TASK = 100;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** AUTOCRAFT_ARTIFACT_DIR, else `artifacts` beside the database. */
export function artifactDir(): string {
  return resolve(envVar("ARTIFACT_DIR") ?? join(dataDir(), "artifacts"));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The type of an artifact from its bytes, or null when it is not an allowed kind:
 * PNG, JSON, JUnit XML (a `<testsuite>` or `<testsuites>` root) or other UTF-8 text.
 * The allowed kinds are the only ones the dashboard offers for download.
 */
export function sniff(data: Buffer): "image/png" | "application/json" | "application/xml" | "text/plain" | null {
  if (data.length >= PNG.length && data.subarray(0, PNG.length).equals(PNG)) return "image/png";
  if (data.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      JSON.parse(text);
      return "application/json";
    } catch { /* plain text that looks like JSON */ }
  }
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<testsuites?[\s>]/.test(head)) return "application/xml";
  return "text/plain";
}

/** The file for an artifact: a hash of the name, so the name never reaches the file system. */
const fileFor = (taskId: number, name: string): string => join(String(taskId), createHash("sha256").update(name).digest("hex").slice(0, 32));

export function absolute(rel: string): string | null {
  const root = artifactDir();
  const full = resolve(root, rel);
  return full.startsWith(root + sep) ? full : null;
}

export function tempPath(taskId: number): string {
  const dir = join(artifactDir(), String(taskId));
  mkdirSync(dir, { recursive: true });
  return join(dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

export class ArtifactError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Checks an uploaded temp file and files it under the task; removes the temp file when refused. */
export async function storeArtifact(db: Db, taskId: number, name: string, tmp: string): Promise<{ bytes: number; contentType: string }> {
  try {
    if (!NAME_RE.test(name)) throw new ArtifactError(400, "artifact names are 1 to 100 letters, digits, dots, underscores or hyphens");
    const bytes = statSync(tmp).size;
    if (bytes === 0) throw new ArtifactError(400, "the artifact is empty");
    const t = await db.get(db.k.selectFrom("build_tasks").select("artifact_bytes").where("id", "=", taskId));
    if (!t) throw new ArtifactError(404, "no such task");
    const old = await db.get(db.k.selectFrom("build_artifacts").select("bytes").where("task_id", "=", taskId).where("name", "=", name));
    const count = (await db.get(db.k.selectFrom("build_artifacts").select((eb) => eb.fn.countAll<number>().as("n")).where("task_id", "=", taskId)))!.n;
    if (!old && count >= MAX_ARTIFACTS_PER_TASK) throw new ArtifactError(413, `at most ${MAX_ARTIFACTS_PER_TASK} artifacts per task`);
    if (t.artifact_bytes - (old?.bytes ?? 0) + bytes > MAX_TASK_ARTIFACT_BYTES) throw new ArtifactError(413, "the task's artifacts would exceed 200 MB");
    const type = sniff(readFileSync(tmp));
    if (!type) throw new ArtifactError(415, "only PNG, JSON, JUnit XML and UTF-8 text artifacts are accepted");
    const rel = fileFor(taskId, name);
    renameSync(tmp, join(artifactDir(), rel));
    await db.write(async () => {
      await db.run(db.k.insertInto("build_artifacts").values({ task_id: taskId, name, bytes, content_type: type, file: rel })
        .onConflict((oc) => oc.columns(["task_id", "name"]).doUpdateSet(kx.excluded(["bytes", "content_type", "file"]))));
      await db.run(db.k.updateTable("build_tasks").set((eb) => ({ artifact_bytes: eb(eb("artifact_bytes", "-", old?.bytes ?? 0), "+", bytes) })).where("id", "=", taskId));
    });
    return { bytes, contentType: type };
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch { /* already moved or gone */ }
    throw e;
  }
}

/** Deletes the artifact files and rows of tasks. */
export async function removeArtifacts(db: Db, taskIds: number[]): Promise<void> {
  for (const id of taskIds) {
    await db.run(db.k.deleteFrom("build_artifacts").where("task_id", "=", id));
    await db.run(db.k.updateTable("build_tasks").set({ artifact_bytes: 0 }).where("id", "=", id));
    const dir = absolute(String(id));
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
