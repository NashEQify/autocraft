// Job logs in the database. A job's process writes its log file on the runner's disk; the runner copies the new whole
// lines into job_log_chunks every FLUSH_MS while the job runs and once more when it ends, so a dashboard without that
// disk can show the log. Each copy is one INSERT (and, past the cap, one DELETE of the oldest chunks), never a
// transaction held across file reads. Only the last JOB_LOG_KEEP_BYTES of a job are kept; the file keeps everything.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Db } from "../db/index.ts";

export const JOB_LOG_KEEP_BYTES = 256 * 1024;
/** Chunks are dropped once the kept text passes the cap by this much, so the DELETE runs once per this many bytes, not per copy. */
const DROP_SLACK_BYTES = 64 * 1024;
export const JOB_LOG_FLUSH_MS = 5_000;

/** The bytes of `path` from `from` (an offset, or one computed from the size) to its end; null when the file cannot be read. */
function readRange(path: string, from: number | ((size: number) => number)): { buf: Buffer; start: number; size: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = typeof from === "function" ? from(size) : from;
    const buf = Buffer.alloc(Math.max(0, size - start));
    if (buf.length) readSync(fd, buf, 0, buf.length, start);
    return { buf, start, size };
  } finally {
    closeSync(fd);
  }
}

/** Copies one job's log file into job_log_chunks. One per running job, in the process that started it. */
export class JobLogCopy {
  #db: Db;
  #job: number;
  #path: string;
  #offset: number;
  #seq: number;
  #kept: { seq: number; bytes: number }[];
  #lastAt = 0;
  #busy: Promise<void> | null = null;

  private constructor(db: Db, job: number, path: string, offset: number, kept: { seq: number; bytes: number }[]) {
    this.#db = db;
    this.#job = job;
    this.#path = path;
    this.#offset = offset;
    this.#kept = kept;
    this.#seq = kept.at(-1)?.seq ?? 0;
  }

  /**
   * Starts after what an earlier run of the job (a resumed job) already copied, when the file still holds it; a file shorter
   * than that is another file (a new disk), copied from its start.
   */
  static async open(db: Db, job: number, path: string): Promise<JobLogCopy> {
    const rows = await db.all(db.k.selectFrom("job_log_chunks").select(["seq", "start", "chunk"]).where("job_id", "=", job).orderBy("seq"));
    const kept = rows.map((r) => ({ seq: Number(r.seq), bytes: Buffer.byteLength(r.chunk) }));
    const last = rows.at(-1);
    const end = last ? Number(last.start) + kept.at(-1)!.bytes : 0;
    const size = readRange(path, (s) => s)?.size ?? 0;
    return new JobLogCopy(db, job, path, end <= size ? end : 0, kept);
  }

  /** Copies the new whole lines, at most once per JOB_LOG_FLUSH_MS; `final` copies everything at once, a last partial line too. */
  async flush(final = false): Promise<void> {
    if (this.#busy) await this.#busy;
    if (!final && Date.now() - this.#lastAt < JOB_LOG_FLUSH_MS) return;
    this.#lastAt = Date.now();
    this.#busy = this.#copy(final).finally(() => { this.#busy = null; });
    await this.#busy;
  }

  async #copy(final: boolean): Promise<void> {
    // More new text than the cap keeps: only its end is read.
    const r = readRange(this.#path, (size) => Math.max(this.#offset, size - JOB_LOG_KEEP_BYTES));
    if (!r || !r.buf.length) return;
    let buf = r.buf;
    if (r.start > this.#offset) buf = buf.subarray(buf.indexOf(10) + 1);
    const skipped = r.buf.length - buf.length;
    if (!final) {
      const nl = buf.lastIndexOf(10);
      if (nl < 0) return;
      buf = buf.subarray(0, nl + 1);
    }
    if (!buf.length) return;
    const start = r.start + skipped;
    const seq = this.#seq + 1;
    await this.#db.run(this.#db.k.insertInto("job_log_chunks").values({ job_id: this.#job, seq, start, chunk: buf.toString("utf8") }));
    this.#seq = seq;
    this.#offset = start + buf.length;
    this.#kept.push({ seq, bytes: buf.length });
    let total = this.#kept.reduce((a, c) => a + c.bytes, 0);
    if (total <= JOB_LOG_KEEP_BYTES + DROP_SLACK_BYTES) return;
    let upTo = 0;
    while (this.#kept.length > 1 && total > JOB_LOG_KEEP_BYTES) {
      const c = this.#kept.shift()!;
      total -= c.bytes;
      upTo = c.seq;
    }
    if (upTo) await this.#db.run(this.#db.k.deleteFrom("job_log_chunks").where("job_id", "=", this.#job).where("seq", "<=", upTo));
  }
}

/** The last `bytes` of a job's stored log, from whole lines; truncated when earlier text is not shown. */
export async function storedLogTail(db: Db, job: number, bytes: number): Promise<{ log: string; logTruncated: boolean } | null> {
  const parts: string[] = [];
  let size = 0;
  let first: number | null = null;
  for (const c of await db.all(db.k.selectFrom("job_log_chunks").select(["chunk", "start"]).where("job_id", "=", job).orderBy("seq", "desc"))) {
    parts.push(c.chunk);
    size += Buffer.byteLength(c.chunk);
    first = Number(c.start);
    if (size >= bytes) break;
  }
  if (first === null) return null;
  const joined = parts.reverse().join("");
  if (size <= bytes) return { log: joined, logTruncated: first > 0 };
  const cut = Buffer.from(joined).subarray(-bytes).toString("utf8");
  return { log: cut.slice(cut.indexOf("\n") + 1), logTruncated: true };
}
