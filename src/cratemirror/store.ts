// Disk storage shared by the crate mirror's index cache and crate store: a byte-capped directory
// that evicts the least recently read files, plus capped reads of upstream responses.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, utimesSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Log = (event: string, fields: Record<string, unknown>) => void;

/** Structured log line on stdout. Callers pass only the request path, never client addresses or headers. */
export const jsonLog: Log = (event, fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "crate-mirror", event, ...fields }));

export class TooLarge extends Error {}

/** The response body, or TooLarge once it passes `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel();
    throw new TooLarge(`response larger than ${max} bytes`);
  }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res.body ?? []) {
    n += c.length;
    if (n > max) throw new TooLarge(`response larger than ${max} bytes`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks, n);
}

/** Streams the response body into a new file `path`, hashing it; TooLarge once it passes `max` bytes. */
export async function downloadTo(res: Response, path: string, max: number): Promise<{ size: number; sha256: string }> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel();
    throw new TooLarge(`response larger than ${max} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const hash = createHash("sha256");
  const fh = await open(path, "wx");
  let size = 0;
  try {
    for await (const c of res.body ?? []) {
      size += c.length;
      if (size > max) throw new TooLarge(`response larger than ${max} bytes`);
      hash.update(c);
      await fh.write(c);
    }
  } finally {
    await fh.close();
  }
  return { size, sha256: hash.digest("hex") };
}

const TMP = /\.tmp-\d+-\d+$/;
const PERSIST_READ_MS = 60 * 60 * 1000;
let tmpSeq = 0;

/**
 * Files under `root` with a byte cap. The map's order is the read order (oldest first), so eviction
 * walks it from the start. A read sets the file's mtime (at most hourly), so the order survives restarts.
 */
export class LruDir {
  readonly root: string;
  cap: number;
  #entries = new Map<string, { size: number; read: number; persisted: number }>();
  #total = 0;

  constructor(root: string, cap: number) {
    this.root = root;
    this.cap = cap;
    mkdirSync(root, { recursive: true });
    const found: { rel: string; size: number; mtime: number }[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else if (TMP.test(e.name)) unlinkSync(p);
        else if (e.isFile()) {
          const st = lstatSync(p);
          found.push({ rel: r, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(root, "");
    found.sort((a, b) => a.mtime - b.mtime);
    for (const f of found) this.#set(f.rel, f.size, f.mtime, f.mtime);
    this.#evict();
  }

  get bytes(): number { return this.#total; }
  get count(): number { return this.#entries.size; }
  has(rel: string): boolean { return this.#entries.has(rel); }
  path(rel: string): string { return join(this.root, rel); }
  size(rel: string): number { return this.#entries.get(rel)?.size ?? 0; }
  /** A fresh temp path next to `rel`, removed at the next start if left behind. */
  tmp(rel: string): string {
    mkdirSync(dirname(this.path(rel)), { recursive: true });
    return `${this.path(rel)}.tmp-${process.pid}-${++tmpSeq}`;
  }

  #set(rel: string, size: number, read: number, persisted: number): void {
    const old = this.#entries.get(rel);
    if (old) this.#total -= old.size;
    this.#entries.delete(rel);
    this.#entries.set(rel, { size, read, persisted });
    this.#total += size;
  }

  /** Marks `rel` as read now. */
  touch(rel: string): void {
    const e = this.#entries.get(rel);
    if (!e) return;
    const now = Date.now();
    let persisted = e.persisted;
    if (now - persisted > PERSIST_READ_MS) {
      try { utimesSync(this.path(rel), new Date(now), new Date(now)); persisted = now; } catch { /* file gone: next admit or scan fixes the entry */ }
    }
    this.#set(rel, e.size, now, persisted);
  }

  /** Moves the finished temp file into place as `rel`, then evicts other files until under the cap. */
  admit(rel: string, tmp: string, size: number): void {
    mkdirSync(dirname(this.path(rel)), { recursive: true });
    renameSync(tmp, this.path(rel));
    const now = Date.now();
    this.#set(rel, size, now, now);
    this.#evict(rel);
  }

  remove(rel: string): void {
    const e = this.#entries.get(rel);
    if (!e) return;
    this.#entries.delete(rel);
    this.#total -= e.size;
    try { unlinkSync(this.path(rel)); } catch { /* already gone */ }
  }

  #evict(keep?: string): void {
    for (const rel of this.#entries.keys()) {
      if (this.#total <= this.cap) return;
      if (rel !== keep) this.remove(rel);
    }
  }
}
