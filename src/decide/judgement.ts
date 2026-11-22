// The judgement model: the model that prepares every question for a person (the prepare step). An operator picks it.
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

export const JUDGEMENT_MODELS = ["opus", "sonnet"] as const;
export type JudgementModel = (typeof JUDGEMENT_MODELS)[number];
const KEY = "judgement_model";

export async function judgementModel(db: Db): Promise<JudgementModel> {
  const v = await setting(db, KEY);
  return (JUDGEMENT_MODELS as readonly string[]).includes(v ?? "") ? (v as JudgementModel) : "opus";
}

export async function setJudgementModel(db: Db, model: string): Promise<void> {
  if (!(JUDGEMENT_MODELS as readonly string[]).includes(model)) throw new Error(`not a judgement model: ${model}`);
  await db.run(db.k.insertInto("settings").values({ key: KEY, value: model }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
}
