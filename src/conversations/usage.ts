// What counts against the Act step's daily limit: the Act jobs' items and the GitHub writes that conversation cards made.
import { GITHUB_ACTIONS } from "../github/actions.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

/** Items of Act jobs plus finished, successful conversation-card GitHub writes since the later of the UTC day start and the operator's last reset of the Act count. */
export async function actUsedToday(db: Db, ms: number = Date.now()): Promise<number> {
  const day = `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const reset = await setting(db, "limit_reset_at:act");
  const since = reset && reset > day ? reset : day;
  const actions = Object.keys(GITHUB_ACTIONS);
  const jobs = (await db.get(db.k.selectFrom("jobs").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("items"), eb.lit(0)).as("n"))
    .where("step", "=", "act").where("started_at", ">=", since)))!.n;
  const cards = (await db.get(db.k.selectFrom("audit").select((eb) => eb.fn.countAll<number>().as("n")).where("at", ">=", since)
    .where((eb) => kx.like(db, "details", eb.val('%"source":"conversation"%')))
    .where((eb) => kx.like(db, "details", eb.val('%"state":"done"%')))
    .where(kx.inList(db, "action", actions))))!.n;
  return jobs + cards;
}

/** The Act step's daily limit, or null when it has none. */
export async function actLimit(db: Db): Promise<number | null> {
  const row = await db.get(db.k.selectFrom("stage_limits").select("per_day").where("step", "=", "act"));
  return row?.per_day ?? null;
}
