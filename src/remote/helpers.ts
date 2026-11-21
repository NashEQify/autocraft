// The readiness of the user-local helpers (Task Runners): each sends its status (POST ROUTES.status) on every change and at
// least every STATUS_EVERY_S while it runs; the last one is kept per runner credential, with its slots and busy count. The
// planner's room counts only runners whose last status is `ready` and fresh, by their free slots (room.ts); the Connect
// page (GET /api/runners) and my_work list the user's own.
import { HttpError } from "../dash/server/util.ts";
import { cooloffOf } from "./cooloff.ts";
import { isTier } from "./mode.ts";
import { scaled } from "./time-scale.ts";
import { READINESS, STATUS_EVERY_S, type HarnessId, type HelperInfo, type HelperStatus, type Machine, type Readiness, type Reserve, type Tier, type UsageReading, type UsageWindow } from "./protocol.ts";
import type { Db } from "../db/index.ts";

/** A status this old no longer counts: one report interval and a minute of slack. */
export const STATUS_FRESH_MS = scaled((STATUS_EVERY_S + 60) * 1000);

const HARNESSES: HarnessId[] = ["claude", "codex"];
const REASON_MAX = 300;

const isoTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const percent = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

function parseWindow(v: unknown, name: string): UsageWindow | null {
  if (v === null || v === undefined) return null;
  const w = v as Record<string, unknown>;
  if (typeof v !== "object" || !percent(w.usedPercent) || !(w.resetsAt === null || isoTime(w.resetsAt))) throw new HttpError(400, `usage.${name} must be { usedPercent: 0-100, resetsAt: ISO time or null }`);
  return { usedPercent: w.usedPercent, resetsAt: w.resetsAt as string | null };
}

/** The status body, checked; throws HttpError 400 for a malformed one. */
export function parseStatus(raw: unknown): HelperStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "the body must be a HelperStatus object");
  const s = raw as Record<string, unknown>;
  if (!READINESS.includes(s.readiness as Readiness)) throw new HttpError(400, `readiness must be one of ${READINESS.join(", ")}`);
  if (s.until !== undefined && s.until !== null && !isoTime(s.until)) throw new HttpError(400, "until must be an ISO time");
  if (s.reason !== undefined && typeof s.reason !== "string") throw new HttpError(400, "reason must be a string");
  if (!HARNESSES.includes(s.harness as HarnessId)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
  const models: Partial<Record<Tier, string>> = {};
  if (!s.models || typeof s.models !== "object" || Array.isArray(s.models)) throw new HttpError(400, "models must map a tier to a model");
  for (const [t, m] of Object.entries(s.models as Record<string, unknown>)) {
    if (!isTier(t) || typeof m !== "string" || !m || m.length > 100) throw new HttpError(400, `models.${t}: a known tier with a model name`);
    models[t] = m;
  }
  const r = s.reserve as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || !percent(r.fiveHour) || !percent(r.weekly)) throw new HttpError(400, "reserve must be { fiveHour, weekly }, each 0-100");
  let usage: UsageReading | undefined;
  if (s.usage !== undefined && s.usage !== null) {
    const u = s.usage as Record<string, unknown>;
    if (typeof u !== "object" || !isoTime(u.at)) throw new HttpError(400, "usage must be { fiveHour, weekly, at }");
    usage = { fiveHour: parseWindow(u.fiveHour, "fiveHour"), weekly: parseWindow(u.weekly, "weekly"), at: u.at };
  }
  const reason = typeof s.reason === "string" ? s.reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX) : "";
  const count = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 64) throw new HttpError(400, `${name} must be a whole number from 0 to 64`);
    return v;
  };
  const slots = count(s.slots, "slots"), busy = count(s.busy, "busy");
  let lastError: HelperStatus["lastError"];
  if (s.lastError !== undefined && s.lastError !== null) {
    const e = s.lastError as Record<string, unknown>;
    if (typeof e !== "object" || typeof e.text !== "string" || !isoTime(e.at)) throw new HttpError(400, "lastError must be { text, at }");
    lastError = { text: e.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX), at: e.at };
  }
  if (s.helperVersion !== undefined && (typeof s.helperVersion !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(s.helperVersion))) throw new HttpError(400, "helperVersion must be a version string");
  let machine: Machine | undefined;
  if (s.machine !== undefined) {
    const m = s.machine as Record<string, unknown>;
    const field = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
    if (!m || typeof m !== "object" || !field(m.hostname, 253) || !field(m.platform, 40) || !field(m.arch, 40)) throw new HttpError(400, "machine must be { hostname, platform, arch }");
    machine = { hostname: m.hostname, platform: m.platform, arch: m.arch };
  }
  return {
    slots, busy: Math.min(busy, slots), ...(lastError && { lastError }), ...(typeof s.helperVersion === "string" && { helperVersion: s.helperVersion }), ...(machine && { machine }),
    readiness: s.readiness as Readiness, ...(isoTime(s.until) && { until: s.until }), ...(reason && { reason }),
    harness: s.harness as HarnessId, models, reserve: { fiveHour: r.fiveHour as number, weekly: r.weekly as number }, ...(usage && { usage }),
  };
}

/**
 * Keeps a helper's status as the last one of its credential, and the machine it names on the credential. Rows of deleted
 * credentials go with the dashboard's minute maintenance (pruneRemote).
 */
export async function storeStatus(db: Db, tokenId: number, login: string, s: HelperStatus, nowMs: number = Date.now()): Promise<void> {
  await db.prepare(`INSERT INTO main.remote_helpers (token_id, login, readiness, until, reason, harness, models, reserve, usage, reported_at, slots, busy, last_error, helper_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_id) DO UPDATE SET login = excluded.login, readiness = excluded.readiness, until = excluded.until, reason = excluded.reason, harness = excluded.harness,
      models = excluded.models, reserve = excluded.reserve, usage = excluded.usage, reported_at = excluded.reported_at,
      slots = excluded.slots, busy = excluded.busy, last_error = excluded.last_error, helper_version = COALESCE(excluded.helper_version, remote_helpers.helper_version)`)
    .run(tokenId, login, s.readiness, s.until ?? null, s.reason ?? null, s.harness, JSON.stringify(s.models), JSON.stringify(s.reserve), s.usage ? JSON.stringify(s.usage) : null, nowMs, s.slots, s.busy, s.lastError ? JSON.stringify(s.lastError) : null, s.helperVersion ?? null);
  if (s.machine) await db.prepare("UPDATE main.mcp_tokens SET machine = ? WHERE id = ? AND machine IS NOT ?").run(JSON.stringify(s.machine), tokenId, JSON.stringify(s.machine));
}

/** Whether the login has a Task Runner whose last status is fresh (the MCP Connector then offers the task tools). */
export async function hasFreshRunner(db: Db, login: string, nowMs: number = Date.now()): Promise<boolean> {
  return await db.prepare(`SELECT 1 FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id
    WHERE t.login = ? AND t.kind = 'runner' AND t.expires_at > ? AND h.reported_at >= ? LIMIT 1`).get(login, new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS) !== undefined;
}

/** The login's helpers: every live Task Runner credential, with its last status. */
export async function listHelpers(db: Db, login: string, nowMs: number = Date.now()): Promise<HelperInfo[]> {
  const rows = await db.prepare(`SELECT t.id, t.label, t.last_used_at, h.readiness, h.until, h.reason, h.harness, h.models, h.reserve, h.usage, h.reported_at, h.slots, h.busy, h.last_error
      FROM main.mcp_tokens t LEFT JOIN main.remote_helpers h ON h.token_id = t.id
    WHERE t.login = ? AND t.kind = 'runner' AND t.expires_at > ? ORDER BY t.created_at DESC, t.id DESC`).all(login, new Date(nowMs).toISOString()) as
    { id: number; label: string | null; last_used_at: string | null; readiness: Readiness | null; until: string | null; reason: string | null; harness: HarnessId | null; models: string | null; reserve: string | null; usage: string | null; reported_at: number | null; slots: number | null; busy: number | null; last_error: string | null }[];
  const cooloff = await cooloffOf(db, login, nowMs);
  return rows.map((r) => {
    const reported = r.reported_at === null ? null : Number(r.reported_at);
    const used = r.last_used_at ? Date.parse(r.last_used_at) : null;
    const seen = Math.max(reported ?? -Infinity, used ?? -Infinity);
    // The server's own cool-off of the login shows even before the helper has reported it.
    const cooled = cooloff !== null && r.readiness !== "cooled-off";
    return {
      tokenId: Number(r.id), label: r.label, slots: r.slots === null ? null : Number(r.slots), busy: r.busy === null ? null : Number(r.busy),
      lastError: r.last_error ? JSON.parse(r.last_error) as { text: string; at: string } : null,
      ...(cooled ? { readiness: "cooled-off" as const, until: new Date(cooloff.until).toISOString(), reason: cooloff.reason } : { readiness: r.readiness, until: r.until, reason: r.reason }),
      fresh: reported !== null && nowMs - reported <= STATUS_FRESH_MS,
      lastSeen: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
      harness: r.harness, models: r.models ? JSON.parse(r.models) as Partial<Record<Tier, string>> : {},
      reserve: r.reserve ? JSON.parse(r.reserve) as Reserve : null, usage: r.usage ? JSON.parse(r.usage) as UsageReading : null,
    };
  });
}
