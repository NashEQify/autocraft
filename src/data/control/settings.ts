// The typed settings registry and snapshot (M05 control-a). The registry `SETTINGS` of `SettingDef` keys is built by M05 from the grep list in control.md 1.1 and the callers of `src/settings-read.ts`.
import type { Db } from "../../db/index.ts";
import type { Config, ControlSnapshot, LiveConfig, SettingKey, SettingPatch, SettingRow } from "./types.ts";

/** Runs `fn` with one settings snapshot in its async context (replaces `withSettingsSnapshot`); no statement when `preload` is given, else one. */
export async function withConfig<T>(db: Db, fn: () => Promise<T>, o?: { live?: readonly string[]; watchWrites?: boolean; preload?: ControlSnapshot }): Promise<T> {
  throw new Error("not built: control.withConfig");
}

/** Sync accessor on the async-context snapshot: typed instance properties and `.repo(repo)` for repo-scope keys. Throws outside a snapshot in tests. */
export function config(db: Db): Config {
  throw new Error("not built: control.config");
}

/** All settings rows, tracked repos, step approvals, active trips and limits; six statements in one wave. */
export async function loadControl(db: Db): Promise<ControlSnapshot> {
  throw new Error("not built: control.loadControl");
}

/** Bypasses the snapshot, for the checks that guard a GitHub write. */
export async function freshConfig(db: Db, keys: readonly SettingKey[]): Promise<Config> {
  throw new Error("not built: control.freshConfig");
}

/** The live keys only, cached 2 s per process. */
export async function loadLiveConfig(db: Db): Promise<LiveConfig> {
  throw new Error("not built: control.loadLiveConfig");
}

/** Batched upsert and delete (`value: null` deletes); keeps the snapshot current and writes one audit row for the batch; joins the caller's transaction, else opens one. */
export async function saveSettings(db: Db, rows: SettingPatch[], by: string, audit?: { action: string; target?: string; details?: unknown }): Promise<number> {
  throw new Error("not built: control.saveSettings");
}

/** Read model for the admin settings page. */
export async function listSettings(db: Db, f?: { scope?: "instance" | "repo"; shown?: boolean }): Promise<SettingRow[]> {
  throw new Error("not built: control.listSettings");
}

/** Validates a pilot list against `tracked_repos`. */
export async function parsePilotRefs(db: Db, input: unknown): Promise<string[]> {
  throw new Error("not built: control.parsePilotRefs");
}

/** Saves the pilot list (`pilot_items`) and audits; one write transaction. */
export async function setPilot(db: Db, by: string, input: unknown): Promise<string[]> {
  throw new Error("not built: control.setPilot");
}

/** The `test_repo:<repo>` flag. */
export async function isTestRepo(db: Db, repo: string): Promise<boolean> {
  throw new Error("not built: control.isTestRepo");
}

/** Repos flagged as test repos. */
export async function testRepos(db: Db): Promise<string[]> {
  throw new Error("not built: control.testRepos");
}

/** Sets the flag. */
export async function setTestRepo(db: Db, repo: string, on: boolean, by: string): Promise<void> {
  throw new Error("not built: control.setTestRepo");
}
