// The environment of a child process that reads from GitHub (gh api, gh pr, git fetch over HTTPS).
// Under the `box` identity nothing is added: the child inherits this process's environment and the box account's
// login. Under `app` the child's whole environment is the inherited basics plus an installation token (never the
// box account's credentials), and a failure to mint one is an error, not a fallback to the box account.
// The setting is held in memory: the runner's tick and the dashboard's live hub refresh it when the `settings` change
// counter moves (refreshReadIdentity), so a switch takes effect there without a restart; a one-shot CLI command reads it
// once, on first use.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../db.ts";
import { DEFAULT_OWNER, OWNER } from "../owners.ts";
import { AppNotInstalledError, TOKEN_ENV, appChildEnv, installationToken } from "./install-token.ts";
import type { Db } from "../db/index.ts";
import { dbFor } from "../db/open.ts";

export type ReadEnv = Record<string, string>;
export type ReadDeps = { db?: Db; mint?: (owner: string) => Promise<string>; defaultOwner?: () => Promise<string> };

// The promise is kept, so two first calls at once share one open.
let shared: { path: string; db: Promise<Db> } | null = null;
/**
 * A read-only handle on the instance database, opened on first use. Null only when there is no database file (nothing
 * configured the identity); a file that cannot be opened is an error, never a silent read as the box account.
 */
async function sharedDb(): Promise<Db | null> {
  const path = dbPath();
  if (shared?.path === path) return await shared.db;
  if (!existsSync(path)) return null;
  const mine = { path, db: openShared(path) };
  shared = mine;
  try {
    return await mine.db;
  } catch (e) {
    if (shared === mine) shared = null;
    throw e;
  }
}

async function openShared(path: string): Promise<Db> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    let sync: DatabaseSync;
    try {
      sync = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    } catch (e) { last = e; continue; }
    return await dbFor(sync);
  }
  throw new Error(`cannot read the GitHub identity setting: ${String((last as Error)?.message ?? last).slice(0, 120)}`);
}

async function settingOf(db: Db): Promise<string | undefined> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return (await db.prepare("SELECT value FROM main.settings WHERE key = 'github_identity'").get() as { value: string } | undefined)?.value;
    } catch (e) { last = e; }
  }
  throw new Error(`cannot read the GitHub identity setting: ${String((last as Error)?.message ?? last).slice(0, 120)}`);
}

/** The identity setting as this process holds it, with the `settings` change counter it was read at (null: unknown). */
let held: { app: boolean; seq: number | null } | null = null;
let firstRead: Promise<boolean> | null = null;

/**
 * Brings the held identity up to date when the `settings` change counter moved (`seq`: the counter as the caller already
 * read it). Long-running loops call it every pass. The counter is read before the value, so a write between the two
 * only makes the next pass read again.
 */
export async function refreshReadIdentity(db: Db, seq?: number): Promise<void> {
  const at = seq ?? (await db.prepare("SELECT seq FROM main.change_seq WHERE topic = 'settings'").get() as { seq: number } | undefined)?.seq ?? null;
  if (at !== null && held?.seq === at) return;
  const app = await settingOf(db) === "app";
  // Another pass may have stored a later reading while this one awaited.
  if (at !== null && held && held.seq !== null && held.seq > at) return;
  held = { app, seq: at };
}

/** Records a switch this process just wrote, so its own next read uses it before any refresh. */
export function noteReadIdentity(app: boolean): void {
  held = { app, seq: null };
}

/**
 * Whether reads go through the GitHub App right now: the held value, read once on first use when no loop refreshed it.
 * With `db`, that database's setting. Throws when the setting exists to be read but cannot be.
 */
export async function readsUseApp(db?: Db): Promise<boolean> {
  if (db) return await settingOf(db) === "app";
  if (held) return held.app;
  firstRead ??= (async () => {
    const d = await sharedDb();
    return d !== null && await settingOf(d) === "app";
  })().catch((e: unknown) => { firstRead = null; throw e; });
  const app = await firstRead;
  held ??= { app, seq: null };
  return held.app;
}

/** The owner of the tracked repos: the default owner when it has any, else the first tracked one. */
export async function trackedOwner(db?: Db): Promise<string> {
  const d = db ?? await sharedDb();
  try {
    const rows = await d?.prepare("SELECT r.owner FROM main.tracked_repos t JOIN main.repos r ON r.name = t.name WHERE r.owner IS NOT NULL ORDER BY t.added_at").all() as { owner: string }[] | undefined;
    const owners = (rows ?? []).map((r) => r.owner).filter((o) => OWNER.test(o));
    if (owners.some((o) => o.toLowerCase() === DEFAULT_OWNER)) return DEFAULT_OWNER;
    if (owners[0]) return owners[0];
  } catch { /* fall through to the default owner */ }
  return DEFAULT_OWNER;
}

/** The owner whose installation serves a read: `owner` when valid, else the tracked owner's. */
export const resolveOwner = async (owner?: string, db?: Db): Promise<string> => (owner && OWNER.test(owner) ? owner : await trackedOwner(db));

const slugOwner = (v: string | undefined): string | undefined => {
  const o = v?.includes("/") ? v.split("/")[0] : undefined;
  return o && OWNER.test(o) ? o : undefined;
};

/** The owner a gh or git command is about, when its arguments name one (`repos/O/…`, `--repo O/…`, `-R O/…`, `owner=O`, `github.com/O/…`). */
export function ownerOfArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^(?:repos|orgs)\/([^/]+)/.exec(a) ?? /github\.com\/([^/]+)\//.exec(a) ?? /^owner=(.+)$/.exec(a);
    if (m && OWNER.test(m[1]!)) return m[1]!;
    const eq = /^(?:--repo|-R)=(.+)$/.exec(a);
    if (eq) { const o = slugOwner(eq[1]); if (o) return o; }
    if (a === "--repo" || a === "-R") { const o = slugOwner(args[i + 1]); if (o) return o; }
  }
  return undefined;
}

/** The owner a GraphQL call is about: its `owner` or `login` variable, else an `org:`/`user:`/`repo:` term of a search query. */
export function ownerOfVariables(v: object): string | undefined {
  const x = v as { owner?: unknown; login?: unknown; q?: unknown };
  for (const c of [x.owner, x.login]) if (typeof c === "string" && OWNER.test(c)) return c;
  if (typeof x.q === "string") {
    const m = /(?:^|\s)(?:org|user):([A-Za-z0-9-]+)/.exec(x.q) ?? /(?:^|\s)repo:([A-Za-z0-9-]+)\//.exec(x.q);
    if (m && OWNER.test(m[1]!)) return m[1]!;
  }
  return undefined;
}

/** A read as the app that cannot be made; `notInstalled` when the app is not installed on the owner. */
export class AppReadError extends Error {
  readonly notInstalled: boolean;
  constructor(message: string, notInstalled: boolean) { super(message); this.name = "AppReadError"; this.notInstalled = notInstalled; }
}

/**
 * The whole child environment for a read as the app, or undefined under `box` (the child inherits). `owner` picks the
 * installation; without one the tracked owner's is used. Throws when no installation token can be minted.
 */
export async function readEnv(owner?: string, deps: ReadDeps = {}): Promise<ReadEnv | undefined> {
  // A process that was started with an identity of its own (a merge child that acts as a person) keeps it.
  if (process.env[TOKEN_ENV]) return undefined;
  if (!await readsUseApp(deps.db)) return undefined;
  const o = owner && OWNER.test(owner) ? owner : await (deps.defaultOwner ?? (async () => await trackedOwner(deps.db)))();
  try {
    return appChildEnv(await (deps.mint ?? installationToken)(o));
  } catch (e) {
    const missing = e instanceof AppNotInstalledError;
    const why = missing ? `the GitHub App is not installed on ${o}` : `no installation token for ${o}: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}`;
    throw new AppReadError(`app identity: ${why}`, missing);
  }
}

const NETWORK_GIT = new Set(["fetch", "ls-remote", "clone", "pull"]);
/** The subcommand of a git argument list, past leading `-c key=value` pairs. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "-C" || args[i] === "--git-dir") { i++; continue; }
    if (args[i]!.startsWith("-")) continue;
    return args[i];
  }
  return undefined;
}

/** The environment for spawning `cmd args`: the app's for every gh command and the network reads of git under `app`, else undefined (inherit). Local git gets no token. */
export async function readEnvFor(cmd: string, args: readonly string[]): Promise<ReadEnv | undefined> {
  if (cmd === "git") { const sub = gitSubcommand(args); if (!sub || !NETWORK_GIT.has(sub)) return undefined; }
  else if (cmd !== "gh") return undefined;
  return readEnv(ownerOfArgs(args));
}
