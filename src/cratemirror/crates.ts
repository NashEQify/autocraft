// crates.io pull-through: the sparse index (short-lived cache, served stale while upstream fails)
// and `.crate` downloads (kept only when their sha256 equals the upstream index's cksum).
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { CRATES_IO_INDEX, CrateVerifier, MAX_CRATE_BYTES, indexPath } from "../worker/cache.ts";
import { LruDir, TooLarge, downloadTo, readCapped, type Log } from "./store.ts";

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
  | { status: 404 | 502 };

type IndexMeta = { fetched: number; etag?: string; lastModified?: string; tag: string };

export type UpstreamOpts = { fetch?: typeof fetch; log: Log; now?: () => number };

/** Sparse index files cached for `ttlMs`; while upstream fails, a copy up to `staleMs` old is served. */
export class IndexCache {
  #dir: LruDir;
  #upstream: string;
  #ttl: number;
  #stale: number;
  #max: number;
  #fetch: typeof fetch;
  #log: Log;
  #now: () => number;
  #inflight = new Map<string, Promise<IndexAnswer>>();

  constructor(o: UpstreamOpts & { dir: string; capBytes: number; upstream?: string; ttlMs?: number; staleMs?: number; maxBytes?: number }) {
    this.#dir = new LruDir(o.dir, o.capBytes);
    this.#upstream = o.upstream ?? CRATES_IO_INDEX;
    this.#ttl = o.ttlMs ?? 60_000;
    this.#stale = o.staleMs ?? 7 * 24 * 3600_000;
    this.#max = o.maxBytes ?? 32 * 1024 * 1024;
    this.#fetch = o.fetch ?? fetch;
    this.#log = o.log;
    this.#now = o.now ?? Date.now;
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

  #write(rel: string, meta: IndexMeta, body: Buffer): void {
    const tmp = this.#dir.tmp(rel);
    const data = Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), body]);
    writeFileSync(tmp, data, { flag: "wx" });
    this.#dir.admit(rel, tmp, data.length);
  }

  /** `path` must have passed indexName(). */
  get(path: string): Promise<IndexAnswer> {
    const rel = `files${path}`;
    const cached = this.#read(rel);
    if (cached && this.#now() - cached.meta.fetched < this.#ttl) {
      this.#dir.touch(rel);
      return Promise.resolve({ status: 200, body: cached.body, etag: cached.meta.tag, source: "hit" });
    }
    let p = this.#inflight.get(rel);
    if (!p) {
      p = this.#refresh(path, rel, cached).finally(() => this.#inflight.delete(rel));
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
        this.#write(rel, { ...cached.meta, fetched: this.#now() }, cached.body);
        return { status: 200, body: cached.body, etag: cached.meta.tag, source: "revalidated" };
      }
      if (res.status === 200) {
        const body = await readCapped(res, this.#max);
        const tag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
        this.#write(rel, { fetched: this.#now(), etag: res.headers.get("etag") ?? undefined, lastModified: res.headers.get("last-modified") ?? undefined, tag }, body);
        return { status: 200, body, etag: tag, source: "miss" };
      }
      await res.body?.cancel();
      if (res.status === 404 || res.status === 410 || res.status === 451) {
        this.#dir.remove(rel);
        return { status: 404 };
      }
      error = `upstream HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof TooLarge ? e.message : `upstream ${(e as Error).name === "TimeoutError" ? "timeout" : "unreachable"}: ${(e as Error).message}`;
    }
    this.#log("upstream-error", { host: "index.crates.io", path, error });
    if (cached && this.#now() - cached.meta.fetched < this.#stale) {
      this.#dir.touch(rel);
      return { status: 200, body: cached.body, etag: cached.meta.tag, source: "stale" };
    }
    return { status: 502 };
  }
}

export type CrateAnswer = { status: 200; path: string; size: number; source: "hit" | "miss" } | { status: 404 | 502 };

/** Immutable `.crate` files, admitted only when their sha256 equals the cksum in the upstream index. */
export class CrateStore {
  #dir: LruDir;
  #index: string;
  #static: string;
  #max: number;
  #fetch: typeof fetch;
  #log: Log;
  #inflight = new Map<string, Promise<CrateAnswer>>();

  constructor(o: UpstreamOpts & { dir: string; capBytes: number; indexUpstream?: string; staticUpstream?: string; maxBytes?: number }) {
    this.#dir = new LruDir(o.dir, o.capBytes);
    this.#index = o.indexUpstream ?? CRATES_IO_INDEX;
    this.#static = o.staticUpstream ?? STATIC_CRATES_IO;
    this.#max = o.maxBytes ?? MAX_CRATE_BYTES;
    this.#fetch = o.fetch ?? fetch;
    this.#log = o.log;
  }

  get bytes(): number { return this.#dir.bytes; }
  get count(): number { return this.#dir.count; }

  get(name: string, version: string): Promise<CrateAnswer> {
    const lower = name.toLowerCase();
    const rel = `${indexPath(lower)}/${lower}-${version}.crate`;
    if (this.#dir.has(rel)) {
      this.#dir.touch(rel);
      return Promise.resolve({ status: 200, path: this.#dir.path(rel), size: this.#dir.size(rel), source: "hit" });
    }
    let p = this.#inflight.get(rel);
    if (!p) {
      p = this.#download(name, version, rel).finally(() => this.#inflight.delete(rel));
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
        unlinkQuiet(tmp);
        return { status: 502 };
      }
      this.#dir.admit(rel, tmp, got.size);
      return { status: 200, path: this.#dir.path(rel), size: got.size, source: "miss" };
    } catch (e) {
      unlinkQuiet(tmp);
      this.#log("upstream-error", { host: "static.crates.io", path, error: (e as Error).message });
      return { status: 502 };
    }
  }
}

function unlinkQuiet(path: string): void {
  rmSync(path, { force: true });
}
