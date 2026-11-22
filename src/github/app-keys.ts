// The registered GitHub App's keys, kept in the database (table github_app, one row) sealed with the TokenBox every
// process derives from the secrets file's session_key, so the dashboard, its replicas and the runner read the same keys
// without sharing a filesystem. A secrets file's `github_app_*` keys are imported once, while no row exists: after that
// the row decides, and a removed app (keys_enc null) is not brought back from the file.
//
// Readers are synchronous (the slug and the minter's keys are read in many places), so each store keeps the last value
// it read and reads the row again, in the background, when that value is older than REREAD_MS. A change made through the
// store itself is visible at once; one made by another process within REREAD_MS.
import { readFileSync } from "node:fs";
import { appSecretsOf, checkSecretsFileMode, readSecrets, type AppSecrets, type Secrets } from "../dash/server/config.ts";
import { TokenBox } from "../dash/server/crypto.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";

const AAD = "github_app:1";
const REREAD_MS = 10_000;

export class AppKeys {
  #db: Db;
  #box: TokenBox;
  #file: string | null;
  #app: AppSecrets | null = null;
  #readAt = 0;
  #reading: Promise<void> | null = null;

  constructor(db: Db, box: TokenBox, file: string | null) {
    this.#db = db;
    this.#box = box;
    this.#file = file;
  }

  /**
   * Imports the secrets file's keys when no row exists yet, then reads the row. A webhook secret set in the file for the
   * stored app (same app id) replaces the stored one at start: GitHub returns none when webhooks are off at registration.
   */
  async load(): Promise<this> {
    const file = this.#file ? fileKeys(this.#file) : null;
    if (file && !await this.#db.get(this.#db.k.selectFrom("github_app").select("id").where("id", "=", 1))) {
      await this.#db.run(this.#db.k.insertInto("github_app").values(this.#row(file)).onConflict((oc) => oc.column("id").doNothing()));
      console.log(`imported the GitHub App ${file.slug} from the secrets file into the database`);
    }
    await this.#read();
    const app = this.#app;
    if (file?.webhookSecret && app && app.id === file.id && app.webhookSecret !== file.webhookSecret) {
      const next = { ...app, webhookSecret: file.webhookSecret };
      await this.#db.run(this.#db.k.updateTable("github_app").set({ keys_enc: this.#row(next).keys_enc, updated_at: new Date().toISOString() }).where("id", "=", 1));
      this.#set(next);
    }
    return this;
  }

  /** The keys as last read; starts a background reread when they are older than REREAD_MS. */
  current(): AppSecrets | null {
    if (Date.now() - this.#readAt > REREAD_MS && !this.#reading) {
      this.#reading = this.#read().catch(() => { /* unreachable database: keep the last value */ }).finally(() => { this.#reading = null; });
    }
    return this.#app;
  }

  /** The keys read now, for callers that can wait (token minting after a registration elsewhere). */
  async fresh(): Promise<AppSecrets | null> {
    await this.#read();
    return this.#app;
  }

  /** Stores a newly registered app. Refuses (EEXIST) when another app is registered. */
  async save(app: AppSecrets): Promise<void> {
    const row = this.#row(app);
    const r = await this.#db.run(this.#db.k.insertInto("github_app").values(row)
      .onConflict((oc) => oc.column("id").doUpdateSet(row).where("github_app.keys_enc", "is", null)));
    if (!r.changes) throw Object.assign(new Error("another app is registered"), { code: "EEXIST" });
    this.#set(app);
  }

  /** Forgets the app's keys; the row stays, so the secrets file's keys are not imported again. */
  async clear(): Promise<void> {
    await this.#db.run(this.#db.k.insertInto("github_app").values({ id: 1, app_id: null, slug: null, keys_enc: null, updated_at: new Date().toISOString() })
      .onConflict((oc) => oc.column("id").doUpdateSet({ app_id: null, slug: null, keys_enc: null, updated_at: new Date().toISOString() })));
    this.#set(null);
  }

  /** For tests and dev servers: the value readers see, without a database write. */
  set(app: AppSecrets | null): void { this.#set(app); }

  #set(app: AppSecrets | null): void {
    this.#app = app;
    this.#readAt = Date.now();
  }

  #row(app: AppSecrets) {
    return { id: 1, app_id: app.id, slug: app.slug, keys_enc: this.#box.seal(JSON.stringify(app), AAD), updated_at: new Date().toISOString() };
  }

  async #read(): Promise<void> {
    const row = await this.#db.get(this.#db.k.selectFrom("github_app").select("keys_enc").where("id", "=", 1));
    const plain = row?.keys_enc ? this.#box.open(row.keys_enc, AAD) : null;
    let app: AppSecrets | null = null;
    try { app = plain ? (JSON.parse(plain) as AppSecrets) : null; } catch { /* unreadable: no app */ }
    this.#set(app);
  }
}

/** The app's keys in a secrets file, for the one-time import; null when it has none or cannot be read. */
function fileKeys(file: string): AppSecrets | null {
  try {
    checkSecretsFileMode(file);
    return appSecretsOf(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  } catch {
    return null;
  }
}

let processKeys: AppKeys | null = null;
let opening: Promise<AppKeys | null> | null = null;

/** Makes `keys` the store that readAppSecrets() and the minter read in this process. */
export function useAppKeys(keys: AppKeys): void {
  processKeys = keys;
}

/** The process's store, if one is in use (the dashboard, the runner and the Discord bot set it at start). */
export const processAppKeys = (): AppKeys | null => processKeys;

/**
 * The process's store, opened on `db` with the secrets file's session key when none is in use yet; null without a
 * secrets file. CLI commands reach it through the minter and the vault.
 */
export function openAppKeys(db: Db | (() => Promise<Db>), env: NodeJS.ProcessEnv = process.env): Promise<AppKeys | null> {
  if (processKeys) return Promise.resolve(processKeys);
  opening ??= (async () => {
    const file = envVar("SECRETS_FILE", env);
    if (!file) return null;
    const { sessionKey } = readSecrets(file);
    const keys = await new AppKeys(typeof db === "function" ? await db() : db, new TokenBox(sessionKey), file).load();
    processKeys ??= keys;
    return processKeys;
  })().finally(() => { opening = null; });
  return opening;
}

const bound = new WeakMap<Secrets, AppKeys>();

/** The store `secrets` is bound to; null when its app keys come from the loaded file only. */
export const boundAppKeys = (secrets: Secrets): AppKeys | null => bound.get(secrets) ?? null;

/** Makes `secrets.app` read and set `keys` (the dashboard's configuration, read where the routes expect it). */
export function bindSecrets(secrets: Secrets, keys: AppKeys): void {
  bound.set(secrets, keys);
  Object.defineProperty(secrets, "app", {
    enumerable: true, configurable: true,
    get: (): AppSecrets | null => keys.current(),
    set: (v: AppSecrets | null) => keys.set(v),
  });
}
