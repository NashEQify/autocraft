// Build environments (`build_envs`) (package build-a).
import type { Db } from "../../db/index.ts";
import type { EnvPatch, EnvRecord } from "./types.ts";

/** Environments with their running tasks. 2 statements. */
export async function loadEnvs(db: Db, opt?: { ids?: string[]; kind?: string; enabled?: boolean }): Promise<EnvRecord[]> { throw new Error("not built: build.loadEnvs"); }
/** Finds the environment of a key, with the same timing behaviour for a missing key (dummy hash). */
export async function authenticateEnv(db: Db, key: string): Promise<{ id: string; taskId?: number } | null> { throw new Error("not built: build.authenticateEnv"); }
/** Creates environments with their audit rows. Validation is the caller's. */
export async function createEnv(db: Db, rows: EnvPatch[], by: string): Promise<void> { throw new Error("not built: build.createEnv"); }
/** Updates environments with their audit rows. */
export async function saveEnv(db: Db, rows: EnvPatch[], by: string): Promise<void> { throw new Error("not built: build.saveEnv"); }
/** Replaces an environment's key hash with an audit row. */
export async function rotateEnvKey(db: Db, id: string, keyHash: string, by: string): Promise<boolean> { throw new Error("not built: build.rotateEnvKey"); }
/** Worker heartbeat; `confidential_online_at` by `CASE`. */
export async function touchEnv(db: Db, id: string, r: { caps?: unknown; version?: string | null; at: string }): Promise<EnvRecord> { throw new Error("not built: build.touchEnv"); }
/** The worker's first call. */
export async function helloEnv(db: Db, id: string, r: { caps: unknown; version: string | null; at: string }): Promise<EnvRecord> { throw new Error("not built: build.helloEnv"); }
