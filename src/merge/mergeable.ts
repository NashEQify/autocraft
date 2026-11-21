// A PR whose mergeable state GitHub keeps reporting as unknown. The checks step reads every waiting PR each minute; when a read still
// shows UNKNOWN after UNKNOWN_AFTER_MS, the PR is read again (GitHub computes the merge state when a PR is requested), at most
// UNKNOWN_REREADS times with UNKNOWN_GAP_MS between tries. The merge queue then asks a person (src/core/decide.ts).
import type { Querier } from "../mirror.ts";
import { refreshChecks, type PrChecks } from "../review/checks.ts";

import { spawn } from "node:child_process";
import { slugOf } from "../owners.ts";
import { mergeDecisionId, UNKNOWN_REREADS } from "../core/rules.ts";
import { withdrawMergeQuestion } from "./withdraw.ts";
import { readEnvFor } from "../github/read.ts";
import type { Db } from "../db/index.ts";
import { excluded, like, rowid } from "../db/kx.ts";

const PREFIX = "mergeable_unknown:";
const keyOf = (repo: string, n: number) => `${PREFIX}${repo}#${n}`;

export type UnknownState = { head: string; since: string; reads: number; rereads: number; stuck: boolean };

const parse = (v: string | null): UnknownState | null => { try { const x = JSON.parse(v as string) as UnknownState; return typeof x.since === "string" && typeof x.head === "string" ? x : null; } catch { return null; } };

/** GraphQL checks reads in a row that still showed an unknown state before GitHub's REST endpoint is asked (a count, not a clock). */
export const READS_BEFORE_REQUEST = 5;

/**
 * Follows PRs whose plan waits on GitHub's mergeable state: a take review at the head and CI success. Counts the consecutive checks reads
 * that still show an unknown state; a known state forgets the PR (and sets aside a Merge? question that was asked about the unknown state).
 */
export async function noteMergeable(db: Db, rows: PrChecks[], at: string): Promise<void> {
  const get = (k: string) => db.get(db.k.selectFrom("main.settings").select("value").where("key", "=", k));
  const set = (k: string, value: string) => db.run(db.k.insertInto("main.settings").values({ key: k, value }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  const del = (k: string) => db.run(db.k.deleteFrom("main.settings").where("key", "=", k));
  const taken = (repo: string, number: number, head: string) => db.get(db.k.selectFrom("final_reviews as l").select((eb) => eb.lit(1).as("one"))
    .where("l.repo", "=", repo).where("l.number", "=", number).where("l.head_oid", "=", head).where("l.verdict", "in", ["take", "take-fix"])
    .where((eb) => eb("l.head_oid", "=", eb.selectFrom("opus_reviews as r").select("r.head_oid").whereRef("r.repo", "=", "l.repo").whereRef("r.number", "=", "l.number")
      .where("r.verdict", "is not", null).orderBy("r.at", "desc").orderBy(rowid("opus_reviews", "r"), "desc").limit(1))));
  const open = (id: string) => db.get(db.k.selectFrom("decisions").select("id").where("id", "=", id).where("answer", "is", null)
    .where((eb) => like(db, "context", eb.val("%still reports the merge state as unknown%"))));
  for (const r of rows) {
    const k = keyOf(r.repo, r.number);
    const cur = await get(k);
    const known = r.mergeable === "MERGEABLE" || r.mergeable === "CONFLICTING";
    if (known || r.state !== "OPEN" || r.overall !== "success" || !await taken(r.repo, r.number, r.head_oid)) {
      if (cur) {
        await del(k);
        const prev = parse(cur.value);
        if (prev && known && await open(mergeDecisionId(r.repo, r.number, prev.head))) await withdrawMergeQuestion(db, r.repo, r.number, prev.head, at, "GitHub now reports the merge state");
      }
      continue;
    }
    const prev = cur ? parse(cur.value) : null;
    if (!prev || prev.head !== r.head_oid) await set(k, JSON.stringify({ head: r.head_oid, since: at, reads: 1, rereads: 0, stuck: false } satisfies UnknownState));
    else await set(k, JSON.stringify({ ...prev, reads: prev.reads + 1 } satisfies UnknownState));
  }
}

/** What the planner needs for one PR at a head, or null when its state is not unknown (or not noted yet). */
export async function unknownOf(db: Db, repo: string, n: number, head: string): Promise<UnknownState | null> {
  const row = await db.get(db.k.selectFrom("main.settings").select("value").where("key", "=", keyOf(repo, n)));
  const s = row ? parse(row.value) : null;
  return s && s.head === head ? s : null;
}

/** The mergeable state of a PR as GitHub's REST endpoint reports it (reading it starts GitHub's mergeability job); null while GitHub has not computed it. */
export type RestRead = (repo: string, number: number) => Promise<string | null>;

export const restMergeable: RestRead = async (repo, number) => {
  const args = ["api", `repos/${slugOf(repo)}/pulls/${number}`, "--jq", ".mergeable"];
  const env = await readEnvFor("gh", args);
  return new Promise((resolve, reject) => {
  const p = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", reject);
  p.on("close", (code) => (code === 0 ? resolve(out.trim() === "true" ? "MERGEABLE" : out.trim() === "false" ? "CONFLICTING" : null) : reject(new Error(err.trim().slice(0, 200) || `gh exited ${code}`))));
  });
};

/**
 * Requests a PR whose state stayed unknown for READS_BEFORE_REQUEST checks reads from GitHub's REST endpoint, which starts the mergeability job.
 * A null answer marks the PR stuck, and the merge queue asks a person. No clock: one request per PR and head. A known answer is stored by reading the PR's checks again.
 */
export async function rereadUnknown(db: Db, client: Querier, repo: string, log: (line: string) => void = () => {}, read: RestRead = restMergeable): Promise<number[]> {
  const rows = await db.all(db.k.selectFrom("main.settings").select(["key", "value"]).where((eb) => like(db, "key", eb.val(`${PREFIX}${repo}#%`))));
  const open = (number: number) => db.get(db.k.selectFrom("main.items").select((eb) => eb.lit(1).as("one")).where("repo", "=", repo).where("number", "=", number).where("kind", "=", "pr").where("state", "=", "OPEN"));
  const done: number[] = [], known: number[] = [];
  const set = (value: string, key: string) => db.run(db.k.updateTable("main.settings").set({ value }).where("key", "=", key));
  for (const r of rows) {
    const s = parse(r.value);
    const n = Number(r.key.slice(r.key.lastIndexOf("#") + 1));
    if (!Number.isInteger(n)) continue;
    if (!s || !await open(n)) { await db.run(db.k.deleteFrom("main.settings").where("key", "=", r.key)); continue; }
    if (s.stuck || s.rereads >= UNKNOWN_REREADS || s.reads < READS_BEFORE_REQUEST) continue;
    let state: string | null;
    try { state = await read(repo, n); } catch (e) { log(`checks: ${repo}#${n}: the REST read failed: ${String((e as Error).message ?? e)}`); continue; }
    done.push(n);
    if (state !== null) { known.push(n); continue; }
    await set(JSON.stringify({ ...s, rereads: s.rereads + 1, stuck: true } satisfies UnknownState), r.key);
  }
  if (known.length) await refreshChecks(db, client, repo, known, log);
  if (done.length) log(`checks: ${repo}: requested ${done.length} PR${done.length === 1 ? "" : "s"} with an unknown mergeable state from GitHub (${done.map((n) => `#${n}`).join(", ")})`);
  return done;
}
