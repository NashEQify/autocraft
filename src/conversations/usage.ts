// What counts against the Act step's daily limit: the Act jobs' items and the GitHub writes that conversation cards made.
import { GITHUB_ACTIONS } from "../github/actions.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

/** Items of Act jobs plus finished, successful conversation-card GitHub writes since the later of the UTC day start and the operator's last reset of the Act count. */
export async function actUsedToday(db: Db, ms: number = Date.now()): Promise<number> {
  const day = `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const reset = await setting(db, "limit_reset_at:act");
  const since = reset && reset > day ? reset : day;
  const actions = Object.keys(GITHUB_ACTIONS);
  const jobs = (await db.prepare("SELECT COALESCE(SUM(items), 0) AS n FROM jobs WHERE step = 'act' AND started_at >= ?").get(since) as { n: number }).n;
  const cards = (await db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE at >= ? AND details LIKE '%"source":"conversation"%' AND details LIKE '%"state":"done"%' AND action IN (${actions.map(() => "?").join(",")})`).get(since, ...actions) as { n: number }).n;
  return jobs + cards;
}

/** The Act step's daily limit, or null when it has none. */
export async function actLimit(db: Db): Promise<number | null> {
  const row = await db.prepare("SELECT per_day FROM stage_limits WHERE step = 'act'").get() as { per_day: number | null } | undefined;
  return row?.per_day ?? null;
}
