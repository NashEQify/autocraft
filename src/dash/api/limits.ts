// The pipeline switch and the paused stages, as the health list and the Needs page show them: a few reads, not the Pipeline page's full stage state.
import { STEP_STAGE } from "../../core/push-outcome.ts";
import { PIPELINE_DRAIN } from "../../core/rules.ts";
import { DEFAULT_PER_DAY, KEY_AT, KEY_BY, KEY_ENABLED, LIMIT_STEPS } from "../../runner/autopilot.ts";
import { loadSteps } from "../../runner/steps.ts";
import type { Db } from "../../db/index.ts";

export type PipelineSwitch = { enabled: boolean; draining: boolean; changedBy: string | null; changedAt: string | null };

export async function pipelineSwitch(db: Db): Promise<PipelineSwitch> {
  const v = new Map((await db.prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)").all(KEY_ENABLED, KEY_BY, KEY_AT) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  return { enabled: v.get(KEY_ENABLED) === "1", draining: v.get(KEY_ENABLED) === PIPELINE_DRAIN, changedBy: v.get(KEY_BY) ?? null, changedAt: v.get(KEY_AT) ?? null };
}

/** Stages whose daily limit is 0 and whose breaker has not tripped (a tripped one is listed as the breaker), in stage-limit order. */
export async function zeroLimits(db: Db): Promise<{ step: string; title: string }[]> {
  const steps = await loadSteps();
  const perDay = new Map((await db.prepare("SELECT step, per_day FROM stage_limits").all() as { step: string; per_day: number | null }[]).map((r) => [r.step, r.per_day]));
  const tripped = new Set((await db.prepare("SELECT stage FROM stage_trips WHERE active").all() as { stage: string }[]).map((r) => r.stage));
  return LIMIT_STEPS
    .filter((step) => (perDay.has(step) ? perDay.get(step) : (DEFAULT_PER_DAY[step] ?? null)) === 0 && !(STEP_STAGE[step] && tripped.has(STEP_STAGE[step]!)))
    .map((step) => ({ step, title: steps.get(step)?.title ?? step }));
}
