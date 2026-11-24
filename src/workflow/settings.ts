// Instance thresholds of the maintainer workflow's blockers 5 and 6, and each user's switch for the new dashboard.
import type { Db } from "../db/index.ts";
import { setting } from "../settings-read.ts";

/** A fix-up or implementation diff with more changed lines than this is a large fix (blocker 5). */
export const LARGE_FIX_KEY = "blocker_large_fix_lines";
export const LARGE_FIX_DEFAULT = 400;
/** A change outside the PR's purpose blocks (blocker 6) when the review counts at least this many changed lines outside it. */
export const OUTSIDE_PURPOSE_KEY = "blocker_outside_purpose_min";
export const OUTSIDE_PURPOSE_DEFAULT = 20;
/** `user_settings` key of a user's switch for the new dashboard ('1' when on); no row means off. */
export const UI_V2_KEY = "ui_v2";

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
};

export async function largeFixLines(db: Db): Promise<number> {
  return positiveInt(await setting(db, LARGE_FIX_KEY), LARGE_FIX_DEFAULT);
}

export async function outsidePurposeMin(db: Db): Promise<number> {
  return positiveInt(await setting(db, OUTSIDE_PURPOSE_KEY), OUTSIDE_PURPOSE_DEFAULT);
}

export async function uiV2(db: Db, login: string): Promise<boolean> {
  return await db.get(db.k.selectFrom("main.user_settings").select("value").where("login", "=", login).where("key", "=", UI_V2_KEY).where("value", "=", "1")) !== undefined;
}
