// The scope of the pipeline. A repo takes part only while its pipeline flag (tracked_repos.pipeline) is on; off means sync only.
// The pilot is an operator setting that narrows the enabled repos further to a list of items ("repo#number").
// Empty or absent means no pilot. A Fix PR the pipeline opened for a pilot issue, a follow-up issue it filed for a pilot PR, and a Fix PR it opened for such a follow-up issue count as pilot items.
// A fast-tracked item (src/fasttrack.ts) is in scope whatever its repo's flag and the pilot say.
// No Node imports besides the type, so candidate queries can use the SQL fragments.
import { quietSqlFor } from "./security/quiet.ts";
import { audit } from "./dash/audit.ts";
import { setting } from "./settings-read.ts";
import type { Db } from "./db/index.ts";

export const PILOT_KEY = "pilot_items";

export class PilotError extends Error {
  status = 400;
}

const REF = /^([A-Za-z0-9._-]+)(?:#([1-9][0-9]*))?$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/** The stored list; an unreadable value counts as no pilot. */
export async function pilotItems(db: Db): Promise<string[]> {
  const value = await setting(db, PILOT_KEY);
  if (value === undefined) return [];
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Tracked repos whose pipeline flag is on. */
export async function pipelineRepos(db: Db): Promise<Set<string>> {
  return new Set((await db.prepare("SELECT name FROM main.tracked_repos WHERE pipeline = 1").all() as { name: string }[]).map((r) => r.name));
}

export const pipelineOn = async (db: Db, repo: string): Promise<boolean> =>
  await db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ? AND pipeline = 1").get(repo) !== undefined;

/** Sets a tracked repo's pipeline flag. Returns false when nothing changed. */
export async function setRepoPipeline(db: Db, by: string, repo: string, on: boolean): Promise<boolean> {
  if (!NAME.test(repo) || !await db.prepare("SELECT 1 FROM main.tracked_repos WHERE name = ?").get(repo)) throw new PilotError(`${repo} is not tracked`);
  const changed = Number((await db.prepare("UPDATE main.tracked_repos SET pipeline = ? WHERE name = ? AND pipeline <> ?").run(on ? 1 : 0, repo, on ? 1 : 0)).changes) > 0;
  if (changed) await audit(db, by, "repo-pipeline", repo, { on });
  return changed;
}

/** The repos in scope without fast track: pipeline flag on, and, with a pilot set, named by one of its items. */
export async function baseScopeRepos(db: Db): Promise<Set<string>> {
  const on = await pipelineRepos(db);
  const items = await pilotItems(db);
  return items.length ? new Set([...on].filter((r) => new Set(items.map((i) => i.split("#")[0]!)).has(r))) : on;
}

/** The repos that take part: those of `baseScopeRepos` and those with a fast-tracked open item. */
export async function scopeRepos(db: Db): Promise<Set<string>> {
  const out = await baseScopeRepos(db);
  // A repo with a fast-tracked open item takes part for that item alone (see pilotSqlFor).
  for (const r of await db.prepare(`SELECT DISTINCT f.repo FROM main.fast_track f JOIN main.tracked_repos t ON t.name = f.repo
    JOIN main.items i ON i.repo = f.repo AND i.number = f.number AND i.state = 'OPEN'`).all() as { repo: string }[]) out.add(r.repo);
  return out;
}

/** Parses refs (repo#number) separated by whitespace or commas; throws on a malformed one, a whole-repo entry or an untracked repo. */
export async function parsePilotRefs(db: Db, input: unknown): Promise<string[]> {
  const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,]+/).filter(Boolean) : null;
  if (!parts || parts.some((p) => typeof p !== "string")) throw new PilotError("items must be a list of repo#number");
  const tracked = new Set((await db.prepare("SELECT name FROM main.tracked_repos").all() as { name: string }[]).map((r) => r.name));
  const out: string[] = [];
  for (const p of parts as string[]) {
    const m = REF.exec(p);
    if (!m) throw new PilotError(`not a repo#number: ${p}`);
    if (!m[2]) throw new PilotError(`${p} is a whole repo; switch it on or off with the Pipeline toggle on the Repos page`);
    if (!tracked.has(m[1]!)) throw new PilotError(`${m[1]} is not tracked`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 200) throw new PilotError("at most 200 items");
  return out;
}

/** Replaces the list; an empty list clears the pilot. Returns the stored list. */
export async function setPilot(db: Db, by: string, input: unknown): Promise<string[]> {
  const refs = await parsePilotRefs(db, input);
  if (refs.length) await db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(PILOT_KEY, JSON.stringify(refs));
  else await db.prepare("DELETE FROM main.settings WHERE key = ?").run(PILOT_KEY);
  await audit(db, by, refs.length ? "pilot-set" : "pilot-clear", PILOT_KEY, { items: refs });
  return refs;
}

const LIST = `(SELECT CASE WHEN json_valid(ps.value) THEN ps.value ELSE '[]' END FROM main.settings ps WHERE ps.key = '${PILOT_KEY}')`;

/** SQL condition on an item given by its repo and number expressions: it is fast-tracked, or its repo's pipeline flag is on, an outside-author hold (src/outside.ts) does not keep it back and, with a pilot set, it is a pilot item, the Fix PR of a pilot issue, a follow-up issue of a pilot PR or the Fix PR of such an issue. */
export const pilotSqlFor = (repo: string, number: string): string =>
  `(EXISTS (SELECT 1 FROM main.fast_track pft WHERE pft.repo = ${repo} AND pft.number = ${number})
    OR (EXISTS (SELECT 1 FROM main.tracked_repos pt WHERE pt.name = ${repo} AND pt.pipeline = 1)
    AND NOT EXISTS (SELECT 1 FROM main.outside_holds oh WHERE oh.repo = ${repo} AND oh.number = ${number})
    AND (COALESCE(json_array_length(${LIST}), 0) = 0
      OR EXISTS (SELECT 1 FROM json_each(${LIST}) pj WHERE pj.value = ${repo} || '#' || ${number})
      OR ${quietSqlFor(repo, number)}
      OR EXISTS (SELECT 1 FROM main.fix_attempts pf, json_each(${LIST}) pj WHERE pf.repo = ${repo} AND pf.pr_url LIKE '%/pull/' || ${number}
        AND pj.value = pf.repo || '#' || pf.number)
      OR EXISTS (SELECT 1 FROM main.fix_attempts pf2 JOIN main.postmerge_followups pm2 ON pm2.repo = pf2.repo AND pm2.issue_number = pf2.number, json_each(${LIST}) pj
        WHERE pf2.repo = ${repo} AND pf2.pr_url LIKE '%/pull/' || ${number} AND pj.value = pm2.repo || '#' || pm2.number)
      OR EXISTS (SELECT 1 FROM main.postmerge_followups pm, json_each(${LIST}) pj WHERE pm.repo = ${repo} AND pm.issue_number = ${number}
        AND pj.value = pm.repo || '#' || pm.number)))
    OR EXISTS (SELECT 1 FROM main.fix_attempts pg JOIN main.fast_track pgt ON pgt.repo = pg.repo AND pgt.number = pg.number
      WHERE pg.repo = ${repo} AND pg.pr_url LIKE '%/pull/' || ${number}))`;

/** The same for a row `alias` of items. */
export const pilotSql = (alias: string): string => pilotSqlFor(`${alias}.repo`, `${alias}.number`);

/** True when the item is in scope. */
export async function inPilot(db: Db, repo: string, number: number): Promise<boolean> {
  return !!await db.prepare(`SELECT 1 WHERE ${pilotSqlFor("?1", "CAST(?2 AS INTEGER)")}`).get(repo, number);
}
