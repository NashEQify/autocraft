// Instance thresholds of the maintainer workflow's blockers 5 and 6, and each user's switch for the new dashboard.
import { config, freshConfig, saveSettings, type Config } from "../data/control/index.ts";
import type { Db } from "../db/index.ts";

/** A fix-up or implementation diff with more changed lines than this is a large fix (blocker 5). */
export const LARGE_FIX_KEY = "blocker_large_fix_lines";
export const LARGE_FIX_DEFAULT = 400;
/** A change outside the PR's purpose blocks (blocker 6) when the review counts at least this many changed lines outside it. */
export const OUTSIDE_PURPOSE_KEY = "blocker_outside_purpose_min";
export const OUTSIDE_PURPOSE_DEFAULT = 20;
/** `user_settings` key of the switch for the new dashboard, which every user has now. */
export const UI_V2_KEY = "ui_v2";

/** The unit of work's settings snapshot, else the two threshold rows read now. */
async function thresholdConfig(db: Db): Promise<Config> {
  try {
    return config(db);
  } catch {
    return await freshConfig(db, [LARGE_FIX_KEY, OUTSIDE_PURPOSE_KEY]);
  }
}

export async function largeFixLines(db: Db): Promise<number> {
  return (await thresholdConfig(db)).blockerLargeFixLines;
}

export async function outsidePurposeMin(db: Db): Promise<number> {
  return (await thresholdConfig(db)).blockerOutsidePurposeMin;
}

/** The new dashboard is the only one. */
export async function uiV2(_db: Db, _login: string): Promise<boolean> {
  return true;
}

export type BlockerThresholds = { largeFixLines: number; outsidePurposeMin: number };
const THRESHOLD_KEYS: Record<keyof BlockerThresholds, string> = { largeFixLines: LARGE_FIX_KEY, outsidePurposeMin: OUTSIDE_PURPOSE_KEY };
const THRESHOLD_MAX = 100_000;

/** A threshold outside 1..THRESHOLD_MAX, or not a whole number. */
export class ThresholdError extends Error {}

export async function blockerThresholds(db: Db): Promise<BlockerThresholds> {
  const c = await thresholdConfig(db);
  return { largeFixLines: c.blockerLargeFixLines, outsidePurposeMin: c.blockerOutsidePurposeMin };
}

/** Stores the given thresholds (an instance setting; operators only, checked by the caller) and audits a change. */
export async function setBlockerThresholds(db: Db, by: string, input: unknown): Promise<BlockerThresholds> {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const was = await blockerThresholds(db);
  const next = { ...was };
  for (const k of Object.keys(THRESHOLD_KEYS) as (keyof BlockerThresholds)[]) {
    const v = b[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > THRESHOLD_MAX) throw new ThresholdError(`${k} must be a whole number from 1 to ${THRESHOLD_MAX}`);
    next[k] = v;
  }
  if (JSON.stringify(was) === JSON.stringify(next)) return next;
  const keys = Object.keys(THRESHOLD_KEYS) as (keyof BlockerThresholds)[];
  await saveSettings(db, keys.map((k) => ({ key: THRESHOLD_KEYS[k], value: String(next[k]) })), by, { action: "blocker-thresholds", target: "pipeline", details: { ...next, was } });
  return next;
}
