// MCP connector and Task Runner credentials (M04 access-b).
import type { Db } from "../../db/index.ts";
import type { Login, LoginState, McpCaller, McpTokenRow, NewToken, RunnerLoginRow, RunnerTokenRow, TokenScopes } from "./types.ts";

/** A person's tokens. */
export async function listTokens(db: Db, login: Login, kind?: string): Promise<McpTokenRow[]> {
  throw new Error("not built: access.listTokens");
}

/** Every token, for the Access page. */
export async function listAllTokens(db: Db): Promise<(McpTokenRow & { login: string })[]> {
  throw new Error("not built: access.listAllTokens");
}

/** Guarded insert (at most 5 live tokens per login and kind); null is the 409. */
export async function addToken(db: Db, row: NewToken): Promise<McpTokenRow | null> {
  throw new Error("not built: access.addToken");
}

/** Updates the scopes of a runner token. */
export async function setRunnerScopes(db: Db, login: Login, id: number, scopes: TokenScopes): Promise<boolean> {
  throw new Error("not built: access.setRunnerScopes");
}

/** One runner token. */
export async function loadRunnerTokenOf(db: Db, login: Login, id: number): Promise<{ canAnswer: boolean } | null> {
  throw new Error("not built: access.loadRunnerTokenOf");
}

/** A person's runner tokens. */
export async function loadRunnerTokensOf(db: Db, login: Login): Promise<RunnerTokenRow[]> {
  throw new Error("not built: access.loadRunnerTokensOf");
}

/** Deletes one token. */
export async function revokeToken(db: Db, login: Login, id: number, kind: string): Promise<boolean> {
  throw new Error("not built: access.revokeToken");
}

/** Admin revoke: delete returning. */
export async function revokeAnyToken(db: Db, id: number): Promise<{ login: string; kind: string } | null> {
  throw new Error("not built: access.revokeAnyToken");
}

/** Batched delete. */
export async function endTokens(db: Db, logins: Login[]): Promise<number> {
  throw new Error("not built: access.endTokens");
}

/** Deletes answer tokens and clears the answer scope; one `db.write`. */
export async function endAnswerTokens(db: Db, login: Login): Promise<number> {
  throw new Error("not built: access.endAnswerTokens");
}

/** Joins `access` for the role; moves `last_used_at`, and a runner's expiry, forward at most once a minute. */
export async function loadCaller(db: Db, hash: string): Promise<McpCaller | null> {
  throw new Error("not built: access.loadCaller");
}

/** Deletes expired tokens and runner logins an hour past expiry; one `db.write`. */
export async function pruneTokens(db: Db, now: number): Promise<void> {
  throw new Error("not built: access.pruneTokens");
}

/** Addresses with a pending runner login. */
export async function listPendingLoginIps(db: Db, nowMs: number): Promise<string[]> {
  throw new Error("not built: access.listPendingLoginIps");
}

/** Whether a hash is in `runner_logins` or `mcp_tokens`. */
export async function credentialInUse(db: Db, hash: string): Promise<boolean> {
  throw new Error("not built: access.credentialInUse");
}

/** Insert on conflict do nothing. */
export async function addRunnerLogin(db: Db, row: Omit<RunnerLoginRow, "state">): Promise<"added" | "code-taken"> {
  throw new Error("not built: access.addRunnerLogin");
}

/** Reads the login; moves an expired one to `expired`. */
export async function pollRunnerLogin(db: Db, hash: string, nowMs: number): Promise<LoginState | null> {
  throw new Error("not built: access.pollRunnerLogin");
}

/** The pending login of a code. */
export async function loadPendingLogin(db: Db, code: string, nowMs: number): Promise<RunnerLoginRow | null> {
  throw new Error("not built: access.loadPendingLogin");
}

/** Atomic: read, the caller's pure address check, guarded token insert, mark approved; one `db.write`. */
export async function approveRunnerLogin(db: Db, approver: string, code: string, o: { label: string; scopes: TokenScopes; nowMs: number; checkAddress: (row: RunnerLoginRow) => void }): Promise<{ token: McpTokenRow; machine: string | null; ip: string | null } | null> {
  throw new Error("not built: access.approveRunnerLogin");
}

/** `UPDATE ... WHERE state = 'pending' ... RETURNING`. */
export async function denyRunnerLogin(db: Db, approver: string, code: string, nowMs: number): Promise<{ label: string | null; machine: string | null; ip: string | null } | null> {
  throw new Error("not built: access.denyRunnerLogin");
}
