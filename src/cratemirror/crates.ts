// crates.io pull-through: the sparse index (short-lived cache, served stale while upstream fails)
// and `.crate` downloads (kept only when their sha256 equals the upstream index's cksum).
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { CRATES_IO_INDEX, CrateVerifier, MAX_CRATE_BYTES, indexPath } from "../worker/cache.ts";
import { LruDir, Slots, TooLarge, diskFull, downloadTo, readCapped, type Log } from "./store.ts";

export const STATIC_CRATES_IO = "https://static.crates.io";
const USER_AGENT = "autocraft-crate-mirror";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,60})?$/;

/** The crate name of a sparse index path ("/se/rd/serde" → "serde"), "config.json", or undefined for anything else. */
export function indexName(path: string): string | undefined {
  if (path === "/config.json") return "config.json";
  const name = path.split("/").pop() ?? "";
  if (!NAME.test(name) || name !== name.toLowerCase()) return undefined;
  return path === `/${indexPath(name)}` ? name : undefined;
}

/** Name and version of a download path: `/crates/<name>/<version>/download` or `/crates/<name>/<name>-<version>.crate`. */
export function downloadTarget(path: string): { name: string; version: string } | undefined {
  const parts = path.split("/");
  if (parts.length < 4 || parts[0] !== "" || parts[1] !== "crates") return undefined;
  let segs: string[];
  try { segs = parts.slice(2).map(decodeURIComponent); } catch { return undefined; }
  const name = segs[0]!;
  let version: string | undefined;
  if (segs.length === 3 && segs[2] === "download") version = segs[1];
  else if (segs.length === 2 && segs[1]!.startsWith(`${name}-`) && segs[1]!.endsWith(".crate")) version = segs[1]!.slice(name.length + 1, -".crate".length);
  if (!NAME.test(name) || !version || !VERSION.test(version)) return undefined;
  return { name, version };
}

export type IndexAnswer =
  | { status: 200; body: Buffer; etag: string; source: "hit" | "miss" | "revalidated" | "stale" }
  | { status: 404; source?: "negative" }
  | { status: 502 | 503 };

type IndexMeta = { fetched: number; etag?: string; lastModified?: string; tag: string };

/** `slots` bounds upstream requests at once, shared by the index cache and the crate store. */
export type UpstreamOpts = { fetch?: typeof fetch; log: Log; now?: () => number; slots: Slots };

const NEGATIVE_MAX = 50_000;

/** Sparse index files cached for `ttlMs`; while upstream fails, a copy up to `staleMs` old is served. Upstream 404s are remembered for `ttlMs` too. */
export class IndexCache {
  #dir: LruDir;
  #upstream: string;
  #ttl: number;
  #stale: number;
  #max: number;
  #fetch: typeof fetch;
  #log: Log;
  #now: () => number;
  #slots: Slots;
  #inflight = new Map<string, Promise<IndexAnswer>>();
  #notFound = new Map<string, number>();

  constructor(o: UpstreamOpts & { dir: string; capBytes: number; upstream?: string; ttlMs?: number; staleMs?: number; maxBytes?: number }) {
    this.#dir = new LruDir(o.dir, o.capBytes);
    this.#upstream = o.upstream ?? CRATES_IO_INDEX;
    this.#ttl = o.ttlMs ?? 60_000;
    this.#stale = o.staleMs ?? 7 * 24 * 3600_000;
    this.#max = o.maxBytes ?? 32 * 1024 * 1024;
    this.#fetch = o.fetch ?? fetch;
    this.#log = o.log;
    this.#now = o.now ?? Date.now;
    this.#slots = o.slots;
  }

  get bytes(): number { return this.#dir.bytes; }

  #read(rel: string): { meta: IndexMeta; body: Buffer } | undefined {
    if (!this.#dir.has(rel)) return undefined;
    try {
      const raw = readFileSync(this.#dir.path(rel));
      const nl = raw.indexOf(10);
      return { meta: JSON.parse(raw.subarray(0, nl).toString()) as IndexMeta, body: raw.subarray(nl + 1) };
    } catch {
      this.#dir.remove(rel);
      return undefined;
    }
  }

  /** Stores the entry; a failed write is logged and the answer is still served. */
  #write(path: string, rel: string, meta: IndexMeta, body: Buffer): void {
    const tmp = this.#dir.tmp(rel);
    try {
      const data = Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), body]);
      writeFileSync(tmp, data, { flag: "wx" });
      this.#dir.admit(rel, tmp, data.length);
    } catch (e) {
      rmSync(tmp, { force: true });
      this.#log(diskFull(e) ? "disk-full" : "store-error", { host: "index.crates.io", path, error: (e as Error).message });
    }
  }

  #staleAnswer(rel: string, cached: { meta: IndexMeta; body: Buffer } | undefined): IndexAnswer | undefined {
    if (!cached || this.#now() - cached.meta.fetched >= this.#stale) return undefined;
    this.#dir.touch(rel);
    return { status: 200, body: cached.body, etag: cached.meta.tag, source: "stale" };
  }

  /** `path` must have passed indexName(). */
  get(path: string): Promise<IndexAnswer> {
    const rel = `files${path}`;
    const cached = this.#read(rel);
    const now = this.#now();
    if (cached && now - cached.meta.fetched < this.#ttl) {
      this.#dir.touch(rel);
      return Promise.resolve({ status: 200, body: cached.body, etag: cached.meta.tag, source: "hit" });
    }
    if (!cached && (this.#notFound.get(path) ?? 0) > now) return Promise.resolve({ status: 404, source: "negative" });
    let p = this.#inflight.get(rel);
    if (!p) {
      const release = this.#slots.take();
      if (!release) return Promise.resolve(this.#staleAnswer(rel, cached) ?? { status: 503 });
      p = this.#refresh(path, rel, cached).finally(() => {
        release();
        this.#inflight.delete(rel);
      });
      this.#inflight.set(rel, p);
    }
    return p;
  }

  async #refresh(path: string, rel: string, cached: { meta: IndexMeta; body: Buffer } | undefined): Promise<IndexAnswer> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (cached?.meta.etag) headers["if-none-match"] = cached.meta.etag;
    else if (cached?.meta.lastModified) headers["if-modified-since"] = cached.meta.lastModified;
    let error: string;
    try {
      const res = await this.#fetch(`${this.#upstream}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (res.status === 304 && cached) {
        await res.body?.cancel();
        this.#write(path, rel, { ...cached.meta, fetched: this.#now() }, cached.body);
        return { status: 200, body: cached.body, etag: cached.meta.tag, source: "revalidated" };
      }
      if (res.status === 200) {
        const body = await readCapped(res, this.#max);
        const tag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
        this.#notFound.delete(path);
        this.#write(path, rel, { fetched: this.#now(), etag: res.headers.get("etag") ?? undefined, lastModified: res.headers.get("last-modified") ?? undefined, tag }, body);
        return { status: 200, body, etag: tag, source: "miss" };
      }
      await res.body?.cancel();
      if (res.status === 404 || res.status === 410 || res.status === 451) {
        this.#dir.remove(rel);
        if (this.#notFound.size >= NEGATIVE_MAX) this.#notFound.delete(this.#notFound.keys().next().value!);
        this.#notFound.delete(path);
        this.#notFound.set(path, this.#now() + this.#ttl);
        return { status: 404 };
      }
      error = `upstream HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof TooLarge ? e.message : `upstream ${(e as Error).name === "TimeoutError" ? "timeout" : "unreachable"}: ${(e as Error).message}`;
    }
    this.#log("upstream-error", { host: "index.crates.io", path, error });
    return this.#staleAnswer(rel, cached) ?? { status: 502 };
  }
}

export type CrateAnswer = { status: 200; path: string; source: "hit" | "miss" } | { status: 404 | 502 | 503 };

/** Immutable `.crate` files, admitted only when their sha256 equals the cksum in the upstream index. */
export class CrateStore {
  #dir: LruDir;
  #index: string;
  #static: string;
  #max: number;
  #minFree: number;
  #fetch: typeof fetch;
  #log: Log;
  #slots: Slots;
  #inflight = new Map<string, Promise<CrateAnswer>>();

  constructor(o: UpstreamOpts & { dir: string; capBytes: number; indexUpstream?: string; staticUpstream?: string; maxBytes?: number; minFreeBytes?: number }) {
    this.#dir = new LruDir(o.dir, o.capBytes);
    this.#index = o.indexUpstream ?? CRATES_IO_INDEX;
    this.#static = o.staticUpstream ?? STATIC_CRATES_IO;
    this.#max = o.maxBytes ?? MAX_CRATE_BYTES;
    this.#minFree = o.minFreeBytes ?? 2 * 1024 ** 3;
    this.#fetch = o.fetch ?? fetch;
    this.#log = o.log;
    this.#slots = o.slots;
  }

  get bytes(): number { return this.#dir.bytes; }
  get count(): number { return this.#dir.count; }

  #rel(name: string, version: string): string {
    const lower = name.toLowerCase();
    return `${indexPath(lower)}/${lower}-${version}.crate`;
  }

  /** Forgets a stored file that vanished from disk. */
  forget(name: string, version: string): void { this.#dir.remove(this.#rel(name, version)); }

  get(name: string, version: string): Promise<CrateAnswer> {
    const rel = this.#rel(name, version);
    if (this.#dir.has(rel)) {
      this.#dir.touch(rel);
      return Promise.resolve({ status: 200, path: this.#dir.path(rel), source: "hit" });
    }
    let p = this.#inflight.get(rel);
    if (!p) {
      const path = `/crates/${name}/${version}/download`;
      // Temp files of downloads in flight are not under the cap, so misses stop while the disk is nearly full.
      let free = Infinity;
      try { const st = statfsSync(this.#dir.root); free = st.bavail * st.bsize; } catch { /* unknown: let the write decide */ }
      if (free < this.#minFree) {
        this.#log("disk-low", { host: "static.crates.io", path, free });
        return Promise.resolve({ status: 503 });
      }
      const release = this.#slots.take();
      if (!release) return Promise.resolve({ status: 503 });
      p = this.#download(name, version, rel).finally(() => {
        release();
        this.#inflight.delete(rel);
      });
      this.#inflight.set(rel, p);
    }
    return p;
  }

  async #download(name: string, version: string, rel: string): Promise<CrateAnswer> {
    const path = `/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`;
    let want: string | undefined;
    try {
      // A new verifier per download: its per-name cache must not outlive this lookup, or new versions would never verify.
      want = await new CrateVerifier(this.#index, this.#fetch).checksum(name, version);
    } catch (e) {
      this.#log("upstream-error", { host: "index.crates.io", path, error: `checksum lookup: ${(e as Error).message}` });
      return { status: 502 };
    }
    if (!want) return { status: 404 };
    const tmp = this.#dir.tmp(rel);
    try {
      const res = await this.#fetch(`${this.#static}${path}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(5 * 60_000) });
      if (res.status === 404 || res.status === 410 || res.status === 451) {
        await res.body?.cancel();
        return { status: 404 };
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new Error(`upstream HTTP ${res.status}`);
      }
      const got = await downloadTo(res, tmp, this.#max);
      if (got.sha256 !== want) {
        this.#log("checksum-mismatch", { host: "static.crates.io", path, bytes: got.size });
        rmSync(tmp, { force: true });
        return { status: 502 };
      }
      this.#dir.admit(rel, tmp, got.size);
      return { status: 200, path: this.#dir.path(rel), source: "miss" };
    } catch (e) {
      rmSync(tmp, { force: true });
      this.#log(diskFull(e) ? "disk-full" : "upstream-error", { host: "static.crates.io", path, error: (e as Error).message });
      return { status: 502 };
    }
  }
}
