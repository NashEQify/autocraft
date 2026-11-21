// Device-style login of a Task Runner (protocol.ts LoginStart). The runner makes its own credential and sends only its
// hash (POST ROUTES.loginStart, no credential); it shows the user code and link, and polls with the credential as its
// bearer (ROUTES.loginPoll). A signed-in maintainer or operator approves the code on the Connect page (src/dash/api/runners.ts),
// which turns the stored hash into a `runner` mcp_tokens row, so the credential then works on the runner routes as it is. The
// runner asks for scopes (agent access, answering); the approver's ticks decide what the row gets.
// A login is single use and lasts LOGIN_TTL_MS; its row stays an hour past that for the runner to read the outcome (pruneTokens).
import { randomInt } from "node:crypto";
import { addRunnerToken, cleanLabel, type McpTokenRow, type Scopes } from "../dash/mcp/tokens.ts";
import { sha256hex } from "../dash/server/crypto.ts";
import { HttpError } from "../dash/server/util.ts";
import type { LoginPollReply, LoginStart, LoginStartReply, LoginState, Machine, PendingRunnerLogin } from "./protocol.ts";
import type { Db } from "../db/index.ts";

export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const LOGIN_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 5;
/** Logins waiting for approval from one address (an IPv6 address counts by its /64); past this its starts are refused until some expire. */
export const MAX_PENDING_PER_ADDRESS = 5;
/** Logins waiting for approval across all clients: a backstop past the per-address cap. */
export const MAX_PENDING = 1000;

/**
 * The address a login counts against: an IPv4 address (also IPv4-mapped) as it is, an IPv6 address by its /64, since one
 * client usually holds a whole /64. Anything else as it is.
 */
export function addressKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  const addr = ip.split("%")[0]!.toLowerCase();
  if (!addr.includes(":") || !/^[0-9a-f:.]+$/.test(addr)) return ip;
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const left = groups(head), right = groups(tail);
  const all = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${all.slice(0, 4).map((g) => (Number.parseInt(g || "0", 16) || 0).toString(16)).join(":")}::/64`;
}

/** Whether two client addresses count as one (addressKey). */
export const sameAddress = (a: string, b: string): boolean => addressKey(a) === addressKey(b);

const CONTROL = /[\u0000-\u001f\u007f]/;
const field = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v);

/** The start body, checked; throws HttpError 400 for a malformed one. */
export function parseLoginStart(raw: unknown): LoginStart {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a LoginStart object");
  const b = raw as Record<string, unknown>;
  if (typeof b.credentialHash !== "string" || !/^[0-9a-f]{64}$/.test(b.credentialHash)) throw new HttpError(400, "credentialHash must be the lowercase hex SHA-256 of the credential");
  if (typeof b.label !== "string" || b.label.length > 200) throw new HttpError(400, "label must be a string");
  const m = b.machine as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || Array.isArray(m) || !field(m.hostname, 253) || !field(m.platform, 40) || !field(m.arch, 40)) throw new HttpError(400, "machine must be { hostname, platform, arch }");
  if (typeof b.helperVersion !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(b.helperVersion)) throw new HttpError(400, "helperVersion must be a version string");
  const sc = b.scopes as Record<string, unknown> | undefined;
  if (sc !== undefined && (!sc || typeof sc !== "object" || Array.isArray(sc) || (sc.agent !== undefined && typeof sc.agent !== "boolean") || (sc.answer !== undefined && typeof sc.answer !== "boolean"))) {
    throw new HttpError(400, "scopes must be { agent?: boolean, answer?: boolean }");
  }
  return {
    credentialHash: b.credentialHash, label: b.label, machine: { hostname: m.hostname, platform: m.platform, arch: m.arch }, helperVersion: b.helperVersion,
    scopes: { agent: sc?.agent !== false, answer: sc?.answer === true },
  };
}

/** A user code as stored (uppercase, no hyphen), or null when it cannot be one. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 20) return null;
  const c = raw.replace(/[-\s]/g, "").toUpperCase();
  return c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

export const showCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Stores a new login and returns what the runner shows; `baseUrl` is the dashboard's origin. */
export async function startLogin(db: Db, start: LoginStart, ip: string, baseUrl: string, nowMs: number = Date.now()): Promise<LoginStartReply> {
  const pending = (await db.prepare("SELECT ip FROM main.runner_logins WHERE state = 'pending' AND expires_at > ?").all(nowMs) as { ip: string | null }[]);
  if (pending.length >= MAX_PENDING) throw new HttpError(429, "too many Task Runner logins are waiting; try again in a few minutes");
  const key = addressKey(ip);
  if (pending.filter((r) => r.ip !== null && addressKey(r.ip) === key).length >= MAX_PENDING_PER_ADDRESS) {
    throw new HttpError(429, "too many Task Runner logins from this address are waiting; approve or deny them, or wait a few minutes");
  }
  if (await db.prepare("SELECT 1 FROM main.runner_logins WHERE secret_hash = ? UNION ALL SELECT 1 FROM main.mcp_tokens WHERE token_hash = ?").get(start.credentialHash, start.credentialHash)) {
    throw new HttpError(409, "this credential was already used for a login; make a new one");
  }
  const label = cleanLabel(start.label) ?? start.machine.hostname.slice(0, 60);
  const insert = db.prepare(`INSERT INTO main.runner_logins (user_code, secret_hash, label, machine, ip, helper_version, created_at, expires_at, want_agent, want_answer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_code) DO NOTHING RETURNING id`);
  for (let i = 0; i < 8; i++) {
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    if (await insert.get(code, start.credentialHash, label, JSON.stringify(start.machine), ip, start.helperVersion, nowMs, nowMs + LOGIN_TTL_MS, start.scopes?.agent === false ? 0 : 1, start.scopes?.answer === true ? 1 : 0)) {
      return { userCode: showCode(code), verifyUrl: `${baseUrl}/connect?runner=${showCode(code)}`, interval: POLL_INTERVAL_S, expiresIn: LOGIN_TTL_MS / 1000 };
    }
  }
  throw new HttpError(503, "could not make a user code; try again");
}

/** The state of the login a credential started, or null when the server knows neither the login nor the credential. */
export async function pollLogin(db: Db, credential: string, nowMs: number = Date.now()): Promise<LoginPollReply | null> {
  const hash = sha256hex(credential);
  const row = await db.prepare("SELECT id, state, expires_at FROM main.runner_logins WHERE secret_hash = ?").get(hash) as { id: number; state: LoginState; expires_at: number } | undefined;
  if (!row) {
    // The login's row is pruned an hour after it expired; its approved credential still answers.
    return await db.prepare("SELECT 1 FROM main.mcp_tokens WHERE token_hash = ? AND kind = 'runner' AND expires_at > ?").get(hash, new Date(nowMs).toISOString()) ? { state: "approved" } : null;
  }
  if (row.state === "pending" && Number(row.expires_at) <= nowMs) {
    await db.prepare("UPDATE main.runner_logins SET state = 'expired' WHERE id = ? AND state = 'pending'").run(row.id);
    return { state: "expired" };
  }
  return { state: row.state };
}

type Row = { id: number; secret_hash: string; label: string | null; machine: string | null; ip: string | null; helper_version: string | null; created_at: number; expires_at: number; want_agent: number; want_answer: number };

async function pendingRow(db: Db, code: string, nowMs: number): Promise<Row | null> {
  return (await db.prepare("SELECT id, secret_hash, label, machine, ip, helper_version, created_at, expires_at, want_agent, want_answer FROM main.runner_logins WHERE user_code = ? AND state = 'pending' AND expires_at > ?")
    .get(code, nowMs) as Row | undefined) ?? null;
}

const machineOf = (r: Row): Machine | null => (r.machine ? JSON.parse(r.machine) as Machine : null);

/** The login waiting for approval under a normalized user code, for the approval card; null when there is none. */
export async function pendingLogin(db: Db, code: string, yourIp: string, nowMs: number = Date.now()): Promise<PendingRunnerLogin | null> {
  const r = await pendingRow(db, code, nowMs);
  if (!r) return null;
  return {
    label: r.label ?? "", machine: machineOf(r) ?? { hostname: "", platform: "", arch: "" }, ip: r.ip ?? "", yourIp,
    startedAt: new Date(Number(r.created_at)).toISOString(), helperVersion: r.helper_version ?? "", expiresAt: new Date(Number(r.expires_at)).toISOString(),
    scopes: { agent: r.want_agent === 1, answer: r.want_answer === 1 },
  };
}

/**
 * Approves a waiting login for `login`: inserts its runner credential (at most MCP_TOKENS_PER_LOGIN runners, else 409) and marks
 * the login approved with the approver's `scopes`. `rawLabel` replaces the runner's own label when given. A login started from
 * another address than the approver's (`approverIp`, addressKey) is approved only with `otherMachine`, the approver's statement
 * that they started it elsewhere; 409 otherwise. Null when no login waits under the code. The caller checks who may grant `answer`.
 */
export async function approveLogin(db: Db, login: string, code: string, rawLabel: unknown, scopes: Scopes, approverIp: string, otherMachine: boolean, nowMs: number = Date.now()): Promise<{ row: McpTokenRow; machine: Machine | null; ip: string | null } | null> {
  const label = rawLabel === undefined ? undefined : cleanLabel(rawLabel);
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = await pendingRow(db, code, nowMs);
    if (!r) {
      db.exec("ROLLBACK");
      return null;
    }
    if (!otherMachine && !sameAddress(r.ip ?? "", approverIp)) {
      throw new HttpError(409, "this login was started from another address than yours; approve it only if you started it on another machine, and say so (otherMachine)");
    }
    const row = await addRunnerToken(db, login, r.secret_hash, label ?? r.label, r.machine, scopes);
    await db.prepare("UPDATE main.runner_logins SET state = 'approved', login = ?, token_id = ? WHERE id = ?").run(login, row.id, r.id);
    db.exec("COMMIT");
    return { row, machine: machineOf(r), ip: r.ip };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Denies a waiting login; what it asked for, or null when no login waits under the code. */
export async function denyLogin(db: Db, login: string, code: string, nowMs: number = Date.now()): Promise<{ label: string | null; machine: Machine | null; ip: string | null } | null> {
  const r = await pendingRow(db, code, nowMs);
  if (!r) return null;
  if ((await db.prepare("UPDATE main.runner_logins SET state = 'denied', login = ? WHERE id = ? AND state = 'pending'").run(login, r.id)).changes !== 1) return null;
  return { label: r.label, machine: machineOf(r), ip: r.ip };
}
