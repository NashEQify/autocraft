// Each user's plan-usage reserve for the user-local helper, stored in `user_settings`. Only the user sets their own; the
// claim reply and the status reply carry it, and the helper claims only while every window keeps more than it free.
import { audit } from "../dash/audit.ts";
import type { Reserve } from "./protocol.ts";
import type { Db } from "../db/index.ts";

export const DEFAULT_RESERVE: Reserve = { fiveHour: 20, weekly: 20 };
/** The highest reserve a user may set: above it a helper would hardly ever claim. */
export const MAX_RESERVE = 90;
const KEYS = { fiveHour: "reserve_five_hour", weekly: "reserve_weekly" } as const;

/** The user's reserve, with the default for a window they never set. */
export async function userReserve(db: Db, login: string): Promise<Reserve> {
  const rows = await db.prepare("SELECT key, value FROM main.user_settings WHERE login = ? AND key IN (?, ?)").all(login, KEYS.fiveHour, KEYS.weekly) as { key: string; value: string }[];
  const out = { ...DEFAULT_RESERVE };
  for (const r of rows) {
    const n = Number(r.value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_RESERVE) continue;
    if (r.key === KEYS.fiveHour) out.fiveHour = n;
    else out.weekly = n;
  }
  return out;
}

/** A reserve from a request body, checked; throws with the reason for a bad one. */
export function parseReserve(raw: unknown): Reserve {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("reserve must be an object with fiveHour and weekly");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "fiveHour" && k !== "weekly") throw new Error(`reserve has no field ${k}`);
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_RESERVE;
  if (!ok(r.fiveHour) || !ok(r.weekly)) throw new Error(`reserve.fiveHour and reserve.weekly must be whole numbers from 0 to ${MAX_RESERVE}`);
  return { fiveHour: r.fiveHour, weekly: r.weekly };
}

/** Stores the user's reserve; a change is audited. */
export async function setUserReserve(db: Db, login: string, reserve: Reserve): Promise<Reserve> {
  const was = await userReserve(db, login);
  const at = new Date().toISOString();
  const put = db.prepare("INSERT INTO main.user_settings (login, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (login, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  await put.run(login, KEYS.fiveHour, String(reserve.fiveHour), at);
  await put.run(login, KEYS.weekly, String(reserve.weekly), at);
  if (was.fiveHour !== reserve.fiveHour || was.weekly !== reserve.weekly) await audit(db, login, "usage-reserve", login, { reserve, was });
  return reserve;
}
