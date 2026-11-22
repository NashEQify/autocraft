// Read-only git smart HTTP for an allowlist of GitHub repositories, served from bare mirrors.
// Clients may only run upload-pack (fetch/clone); every other path is 404.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Log } from "./store.ts";

export const GITHUB = "https://github.com";
const SEG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_ADVERTISE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10 * 60_000;

/** "owner/repo" in lower case, from a list entry ("storytold/craft-libs", "https://github.com/storytold/craft-libs.git"), or undefined. */
export function normalizeRepo(entry: string): string | undefined {
  const s = entry.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
  const [owner, repo, ...rest] = s.split("/");
  if (rest.length || !owner || !repo || !SEG.test(owner) || !SEG.test(repo) || repo.includes("..")) return undefined;
  return `${owner}/${repo}`.toLowerCase();
}

/** Repos from a list file (one per line, `#` comments) and an inline list (comma or whitespace separated). */
export function readAllowlist(file: string | undefined, inline: string | undefined, log: Log): Set<string> {
  const out = new Set<string>();
  const add = (text: string, from: string): void => {
    for (const raw of text.split(/[\s,]+/)) {
      if (!raw) continue;
      const r = normalizeRepo(raw);
      if (r) out.add(r);
      else log("git-allowlist-skip", { from, entry: raw.slice(0, 120) });
    }
  };
  if (inline) add(inline, "env");
  if (file) {
    try {
      add(readFileSync(file, "utf8").split("\n").map((l) => l.replace(/#.*/, "")).join("\n"), "file");
    } catch (e) {
      log("git-allowlist-error", { error: (e as Error).message });
    }
  }
  return out;
}

/** A git smart-HTTP route: repo ("owner/repo", lower case) and which endpoint. */
export function gitRoute(path: string): { repo: string; endpoint: "info/refs" | "git-upload-pack" } | undefined {
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack)$/.exec(path);
  if (!m) return undefined;
  const repo = normalizeRepo(`${m[1]}/${m[2]}`);
  return repo ? { repo, endpoint: m[3] as "info/refs" | "git-upload-pack" } : undefined;
}

type RunResult = { code: number | null; stdout: Buffer; stderr: string };

export type GitOpts = {
  dir: string;
  allowlist: () => Set<string>;
  log: Log;
  upstream?: string;
  fetchEveryMs?: number;
  freshMs?: number;
  gcEveryMs?: number;
  maxResponseBytes?: number;
};

export type GitAnswer =
  | { status: 200; contentType: string; body: Buffer }
  | { status: 200; contentType: string; stream: NodeJS.ReadableStream; done: Promise<void> }
  | { status: 400 | 404 | 413 | 415 | 502 };

export class GitMirrors {
  #dir: string;
  #allowlist: () => Set<string>;
  #allowed = new Set<string>();
  #log: Log;
  #upstream: string;
  #fetchEvery: number;
  #fresh: number;
  #gcEvery: number;
  #maxResponse: number;
  #lastFetch = new Map<string, number>();
  #inflight = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  #syncing: Promise<void> | undefined;

  constructor(o: GitOpts) {
    this.#dir = o.dir;
    this.#allowlist = o.allowlist;
    this.#log = o.log;
    this.#upstream = o.upstream ?? GITHUB;
    this.#fetchEvery = o.fetchEveryMs ?? 2 * 60_000;
    this.#fresh = o.freshMs ?? 30_000;
    this.#gcEvery = o.gcEveryMs ?? 7 * 24 * 3600_000;
    this.#maxResponse = o.maxResponseBytes ?? 4 * 1024 ** 3;
    mkdirSync(this.#dir, { recursive: true });
    this.#allowed = this.#allowlist();
  }

  get repos(): number { return this.#allowed.size; }

  /** Syncs now, then every `fetchEveryMs`. */
  start(): void {
    void this.sync();
    this.#timer = setInterval(() => void this.sync(), this.#fetchEvery);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#syncing;
    await Promise.allSettled([...this.#inflight.values()]);
  }

  /** Rereads the allowlist, fetches every listed repo, gc's those due and deletes mirrors no longer listed. */
  sync(): Promise<void> {
    this.#syncing ??= (async () => {
      this.#allowed = this.#allowlist();
      for (const repo of this.#allowed) {
        try {
          await this.#ensure(repo, 0);
          await this.#gcIfDue(repo);
        } catch { /* logged by #ensure */ }
      }
      for (const owner of readdirSync(this.#dir, { withFileTypes: true })) {
        if (!owner.isDirectory()) continue;
        for (const name of readdirSync(join(this.#dir, owner.name))) {
          const repo = `${owner.name}/${name.replace(/\.git(\.tmp)?$/, "")}`;
          if (this.#inflight.has(repo)) continue;
          if (!this.#allowed.has(repo) || name.endsWith(".tmp")) {
            rmSync(join(this.#dir, owner.name, name), { recursive: true, force: true });
            this.#lastFetch.delete(repo);
            this.#log("git-removed", { repo });
          }
        }
      }
    })().finally(() => { this.#syncing = undefined; });
    return this.#syncing;
  }

  #path(repo: string): string { return join(this.#dir, `${repo}.git`); }

  #run(args: string[], o: { input?: Buffer; protocol?: string; maxOut?: number } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.#dir, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
      for (const k of ["SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[k]) env[k] = process.env[k];
      if (o.protocol) env.GIT_PROTOCOL = o.protocol;
      const child = spawn("git", args, { env, stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = "";
      child.stdout.on("data", (c: Buffer) => {
        outBytes += c.length;
        if (outBytes > (o.maxOut ?? MAX_ADVERTISE_BYTES)) child.kill();
        else out.push(c);
      });
      child.stderr.on("data", (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err.trim() }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(o.input);
    });
  }

  async #git(args: string[]): Promise<Buffer> {
    const r = await this.#run(args);
    if (r.code !== 0) throw new Error(`git ${args[0] === "-C" ? args[2] : args[0]} exited ${r.code}: ${r.stderr.split("\n").pop() ?? ""}`);
    return r.stdout;
  }

  /** Fetches `repo` unless the last fetch is younger than `maxAgeMs`; creates the mirror first if needed. Throws only when no mirror exists afterwards. */
  #ensure(repo: string, maxAgeMs: number): Promise<void> {
    const last = this.#lastFetch.get(repo);
    if (last !== undefined && Date.now() - last < maxAgeMs) return Promise.resolve();
    let p = this.#inflight.get(repo);
    if (!p) {
      p = this.#fetch(repo).finally(() => this.#inflight.delete(repo));
      this.#inflight.set(repo, p);
    }
    return p;
  }

  async #fetch(repo: string): Promise<void> {
    const dest = this.#path(repo);
    const fresh = !existsSync(dest);
    const dir = fresh ? `${dest}.tmp` : dest;
    const started = Date.now();
    try {
      if (fresh) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        await this.#git(["init", "--quiet", "--bare", dir]);
        await this.#git(["-C", dir, "config", "remote.origin.url", `${this.#upstream}/${repo}.git`]);
        await this.#git(["-C", dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
        await this.#git(["-C", dir, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
      }
      await this.#git(["-C", dir, "fetch", "--quiet", "--prune", "origin"]);
      const head = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\tHEAD$/m.exec((await this.#git(["-C", dir, "ls-remote", "--symref", "origin", "HEAD"])).toString());
      if (head) await this.#git(["-C", dir, "symbolic-ref", "HEAD", head[1]!]);
      if (fresh) renameSync(dir, dest);
      this.#lastFetch.set(repo, Date.now());
      this.#log("git-fetch", { repo, ms: Date.now() - started, created: fresh || undefined });
    } catch (e) {
      this.#log("upstream-error", { host: "github.com", repo, error: (e as Error).message });
      if (fresh) {
        rmSync(dir, { recursive: true, force: true });
        throw e;
      }
    }
  }

  async #gcIfDue(repo: string): Promise<void> {
    const dir = this.#path(repo);
    const last = Number((await this.#run(["-C", dir, "config", "autocraft.lastgc"])).stdout.toString().trim() || 0);
    if (Date.now() - last * 1000 < this.#gcEvery) return;
    await this.#git(["-C", dir, "gc", "--quiet"]);
    await this.#git(["-C", dir, "config", "autocraft.lastgc", String(Math.floor(Date.now() / 1000))]);
    this.#log("git-gc", { repo });
  }

  /** Allowed, mirrored and fetched within `freshMs`, or why not. */
  async #ready(repo: string, fetchIfOld: boolean): Promise<404 | 502 | undefined> {
    if (!this.#allowed.has(repo)) return 404;
    try {
      await this.#ensure(repo, fetchIfOld ? this.#fresh : Infinity);
    } catch {
      return 502;
    }
    return existsSync(this.#path(repo)) ? undefined : 502;
  }

  static protocol(header: string | string[] | undefined): string | undefined {
    const v = Array.isArray(header) ? header[0] : header;
    return v === "version=2" || v === "version=1" ? v : undefined;
  }

  /** GET info/refs?service=git-upload-pack. */
  async advertise(repo: string, query: URLSearchParams, gitProtocol: string | undefined): Promise<GitAnswer> {
    if (query.get("service") !== "git-upload-pack") return { status: 404 };
    const bad = await this.#ready(repo, true);
    if (bad) return { status: bad };
    const r = await this.#run(["-c", "uploadpack.allowReachableSHA1InWant=true", "upload-pack", "--strict", "--stateless-rpc", "--advertise-refs", this.#path(repo)], { protocol: gitProtocol });
    if (r.code !== 0) {
      this.#log("git-error", { repo, error: r.stderr.split("\n").pop() });
      return { status: 502 };
    }
    // Protocol v2 answers start with the capability list; v0/v1 need the service line first.
    const head = gitProtocol === "version=2" ? Buffer.alloc(0) : Buffer.from("001e# service=git-upload-pack\n0000");
    return { status: 200, contentType: "application/x-git-upload-pack-advertisement", body: Buffer.concat([head, r.stdout]) };
  }

  /** POST git-upload-pack with the client's request body (already read, at most MAX_REQUEST_BYTES). */
  async uploadPack(repo: string, contentType: string | undefined, encoding: string | undefined, raw: Buffer, gitProtocol: string | undefined): Promise<GitAnswer> {
    if (contentType !== "application/x-git-upload-pack-request") return { status: 415 };
    const bad = await this.#ready(repo, false);
    if (bad) return { status: bad };
    let input: Buffer;
    try {
      input = encoding === "gzip" ? gunzipSync(raw, { maxOutputLength: MAX_REQUEST_BYTES }) : raw;
    } catch {
      return { status: encoding === "gzip" ? 413 : 400 };
    }
    if (encoding && encoding !== "gzip" && encoding !== "identity") return { status: 415 };
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.#dir, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
    const child = spawn("git", ["-c", "uploadpack.allowReachableSHA1InWant=true", "upload-pack", "--strict", "--stateless-rpc", this.#path(repo)], { env, stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
    let err = "";
    let bytes = 0;
    child.stderr.on("data", (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
    child.stdout.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > this.#maxResponse) {
        this.#log("git-error", { repo, error: `response larger than ${this.#maxResponse} bytes` });
        child.kill();
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    const done = new Promise<void>((resolve) => child.on("close", (code) => {
      if (code !== 0) this.#log("git-error", { repo, error: err.trim().split("\n").pop() ?? `exit ${code}` });
      resolve();
    }));
    child.on("error", (e) => this.#log("git-error", { repo, error: e.message }));
    return { status: 200, contentType: "application/x-git-upload-pack-result", stream: child.stdout, done };
  }
}

export const MAX_GIT_REQUEST_BYTES = MAX_REQUEST_BYTES;
