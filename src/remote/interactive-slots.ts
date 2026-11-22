// Each user's "Interactive slots" for their user-local helpers, stored in `user_settings` under `interactive_slots`: the calls
// all their helpers may hold on the interactive lane together (claimCall with `interactiveLane`). Only interactive calls
// (INTERACTIVE_PROMPTS) use these slots, and interactive calls use no other slot. No row means the role's default.
import { audit } from "../dash/audit.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

export const INTERACTIVE_SLOTS_KEY = "interactive_slots";
export const INTERACTIVE_SLOTS_MAX = 4;
/** Prompt id prefixes of calls a person waits for; each is withdrawn after a few seconds without a taker, so it takes only a free interactive slot. */
export const INTERACTIVE_PROMPTS: readonly string[] = ["discord."];
export const interactive = (r: { prompt_id: string }): boolean => INTERACTIVE_PROMPTS.some((p) => r.prompt_id.startsWith(p));

/** The slots of a stored value (undefined: no row): the role's default, 1 for an operator and 0 for others. */
export function interactiveSlotsOf(value: string | undefined, role: string): number {
  const n = value !== undefined ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= INTERACTIVE_SLOTS_MAX ? n : role === "operator" ? 1 : 0;
}

export async function userInteractiveSlots(db: Db, login: string, role: string): Promise<number> {
  return interactiveSlotsOf((await db.get(db.k.selectFrom("main.user_settings").select("value").where("login", "=", login).where("key", "=", INTERACTIVE_SLOTS_KEY)))?.value, role);
}

/** A count from a request body, checked: a whole number from 0 to INTERACTIVE_SLOTS_MAX; throws with the reason for a bad one. */
export function parseInteractiveSlots(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > INTERACTIVE_SLOTS_MAX) throw new Error(`interactiveSlots must be a whole number from 0 to ${INTERACTIVE_SLOTS_MAX}`);
  return raw;
}

/** Stores the user's slots; a change is audited. */
export async function setUserInteractiveSlots(db: Db, login: string, role: string, slots: number): Promise<number> {
  const was = await userInteractiveSlots(db, login, role);
  await db.run(db.k.insertInto("main.user_settings").values({ login, key: INTERACTIVE_SLOTS_KEY, value: String(slots), updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["login", "key"]).doUpdateSet(excluded(["value", "updated_at"]))));
  if (was !== slots) await audit(db, login, "interactive-slots", login, { interactiveSlots: slots, was });
  return slots;
}
