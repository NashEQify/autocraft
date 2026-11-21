// What can keep a PR's review from changing: another open item the review named as the reason for its hold.
import { isHiddenRepo, type HiddenRepos } from "../hidden-sql.ts";
import { filterSeq, someSeq } from "../async-seq.ts";
import type { NotNull } from "kysely";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

const REF = /^([\w.-]+)#(\d+)$/;

/** The end of a review wait on blocking items: "<ref>, <ref>, which blocks its review". */
export const BLOCKS_REVIEW = ", which blocks its review";

/** The items a review wait names as its blockers; empty for any other wait. */
export function blockersOfWait(wait: string | null): string[] {
  if (!wait?.endsWith(BLOCKS_REVIEW)) return [];
  return wait.slice(0, -BLOCKS_REVIEW.length).split(", ").filter((r) => REF.test(r));
}

/** The stored `blocked_by` value (JSON array of refs) as a list. */
export function storedBlockedBy(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/**
 * The refs that still block: a tracked item that is open and, for an issue, has an unanswered decision. An untracked, closed or
 * merged item, or an issue with nothing left to decide, blocks nothing.
 */
export async function openBlockers(db: Db, refs: readonly string[]): Promise<string[]> {
  return await filterSeq(refs, async (ref) => {
    const m = REF.exec(ref);
    if (!m) return false;
    const i = await db.get(db.k.selectFrom("main.items").select(["kind", "state"]).where("repo", "=", m[1]!).where("number", "=", Number(m[2])));
    if (!i || i.state !== "OPEN") return false;
    return i.kind === "pr" || !!await db.get(db.k.selectFrom("main.decisions").select((eb) => eb.lit(1).as("one")).where("repo", "=", m[1]!).where("number", "=", Number(m[2])).where("answer", "is", null).limit(1));
  });
}

/** A hold's blocker list is ignored after this long: the PR then gets one fresh review. */
export const BLOCKED_EXPIRES_MS = 14 * 24 * 3600_000;

/**
 * The blockers of the review of `self` made at `at` that still hold: open (openBlockers), not past BLOCKED_EXPIRES_MS, and not
 * themselves waiting on `self` (two PRs blocking each other would never be reviewed).
 */
export async function activeBlockers(db: Db, self: string, stored: string | null | undefined, at: string, nowMs: number = Date.now()): Promise<string[]> {
  const refs = storedBlockedBy(stored);
  if (!refs.length || nowMs - Date.parse(at) > BLOCKED_EXPIRES_MS) return [];
  return await filterSeq((await openBlockers(db, refs)), async (ref) => {
    const [repo, n] = ref.split("#");
    const l = await db.get(db.k.selectFrom("main.opus_reviews as o").select(["o.verdict", "o.blocked_by"]).$narrowType<{ verdict: NotNull }>()
      .where("o.repo", "=", repo!).where("o.number", "=", Number(n)).where("o.verdict", "is not", null).orderBy("o.at", "desc").orderBy(kx.rowid("main.opus_reviews", "o"), "desc").limit(1));
    return !(l?.verdict === "hold" && storedBlockedBy(l.blocked_by).includes(self));
  });
}

type BlockerReads = { item: Map<string, { kind: string; state: string }>; pending: Set<string>; latest: Map<string, { verdict: string; blocked_by: string | null }> };

/** What openBlockers and activeBlockers read per ref, read once for many refs (keys `repo#number`). */
async function blockerReads(db: Db, refs: string[]): Promise<BlockerReads> {
  const keys = new Map<string, [string, number]>();
  for (const ref of refs) { const m = REF.exec(ref); if (m) keys.set(`${m[1]}#${Number(m[2])}`, [m[1]!, Number(m[2])]); }
  const out: BlockerReads = { item: new Map(), pending: new Set(), latest: new Map() };
  if (!keys.size) return out;
  const pairs = [...keys.values()];
  for (const r of await db.all(db.k.selectFrom("main.items as i").select(["i.repo", "i.number", "i.kind", "i.state"]).where(kx.refIn(db, "i", pairs)))) out.item.set(`${r.repo}#${r.number}`, r);
  for (const r of await db.all(db.k.selectFrom("main.decisions as d").select(["d.repo", "d.number"]).distinct().where(kx.refIn(db, "d", pairs)).where("d.answer", "is", null)))
    out.pending.add(`${r.repo}#${r.number}`);
  const ranked = db.k.selectFrom("main.opus_reviews as o")
    .select((eb) => ["o.repo", "o.number", "o.verdict", "o.blocked_by", eb.fn.agg<number>("row_number", []).over((w) => w.partitionBy(["o.repo", "o.number"]).orderBy("o.at", "desc").orderBy(kx.rowid("main.opus_reviews", "o"), "desc")).as("k")])
    .where(kx.refIn(db, "o", pairs)).where("o.verdict", "is not", null);
  for (const r of await db.all(db.k.selectFrom(ranked.as("r")).select(["r.repo", "r.number", "r.verdict", "r.blocked_by"]).$narrowType<{ verdict: NotNull }>().where("r.k", "=", 1))) out.latest.set(`${r.repo}#${r.number}`, r);
  return out;
}

/** activeBlockers from reads made for many reviews at once. */
function activeFrom(reads: BlockerReads, self: string, stored: string | null | undefined, at: string, nowMs: number): string[] {
  const refs = storedBlockedBy(stored);
  if (!refs.length || nowMs - Date.parse(at) > BLOCKED_EXPIRES_MS) return [];
  return refs.filter((ref) => {
    const m = REF.exec(ref);
    if (!m) return false;
    const k = `${m[1]}#${Number(m[2])}`;
    const i = reads.item.get(k);
    if (!i || i.state !== "OPEN" || (i.kind !== "pr" && !reads.pending.has(k))) return false;
    const l = reads.latest.get(k);
    return !(l?.verdict === "hold" && storedBlockedBy(l.blocked_by).includes(self));
  });
}

/** Whether any of the refs has an open decision: the wait is then on a person. */
export async function hasOpenQuestion(db: Db, refs: readonly string[]): Promise<boolean> {
  return await someSeq(refs, async (ref) => {
    const m = REF.exec(ref);
    return !!m && !!await db.get(db.k.selectFrom("main.decisions").select((eb) => eb.lit(1).as("one")).where("repo", "=", m[1]!).where("number", "=", Number(m[2])).where("answer", "is", null).limit(1));
  });
}

/** The rowid of the latest review with a verdict of the PR of the review `o` (an expression in a query that has `main.opus_reviews as o`). */
const latestRowid = (eb: kx.AnyEb) => kx.schemaEb(eb).selectFrom("main.opus_reviews as l").select(kx.rowid("main.opus_reviews", "l").as("rid"))
  .where("l.repo", "=", eb.ref("o.repo")).where("l.number", "=", eb.ref("o.number")).where("l.verdict", "is not", null)
  .orderBy("l.at", "desc").orderBy(kx.rowid("main.opus_reviews", "l"), "desc").limit(1);

/** Facts for an open decision naming the PRs whose review it holds (derived from their stored holds; the decision row is not written). PRs of repos in `hidden` are not named. */
export async function blocksFacts(db: Db, repo: string | null, number: number | null, hidden: HiddenRepos): Promise<string[]> {
  if (repo === null || number === null) return [];
  const me = `${repo}#${number}`;
  const rows = await db.all(db.k.selectFrom("main.opus_reviews as o").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "o.repo").onRef("i.number", "=", "o.number").on("i.state", "=", "OPEN"))
    .select(["o.repo", "o.number", "o.at", "o.blocked_by"]).$narrowType<{ blocked_by: NotNull }>()
    .where("o.verdict", "is not", null).where((eb) => kx.like(db, "o.blocked_by", eb.val(`%"${me}"%`)))
    .where((eb) => eb(kx.rowid("main.opus_reviews", "o"), "=", latestRowid(eb)))
    .where("o.verdict", "=", "hold").orderBy("o.repo").orderBy("o.number").limit(5));
  return (await filterSeq(rows, async (r) => !isHiddenRepo(hidden, r.repo) && (await activeBlockers(db, `${r.repo}#${r.number}`, r.blocked_by, r.at)).includes(me))).map((r) => `Blocks the review of ${r.repo}#${r.number}`);
}

/** `blocksFacts` for every PR at once: the facts by blocked ref ("repo#number"), from one scan of the latest holds. For a page of decisions. */
export async function blocksIndex(db: Db, hidden: HiddenRepos): Promise<Map<string, string[]>> {
  const rows = await db.all(db.k.selectFrom("main.opus_reviews as o").innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "o.repo").onRef("i.number", "=", "o.number").on("i.state", "=", "OPEN"))
    .select(["o.repo", "o.number", "o.at", "o.blocked_by"]).$narrowType<{ blocked_by: NotNull }>()
    .where("o.verdict", "=", "hold").where((eb) => kx.like(db, "o.blocked_by", eb.val('%"%')))
    .where((eb) => eb(kx.rowid("main.opus_reviews", "o"), "=", latestRowid(eb)))
    .orderBy("o.repo").orderBy("o.number"));
  const out = new Map<string, string[]>();
  const nowMs = Date.now();
  const shown = rows.filter((r) => !isHiddenRepo(hidden, r.repo));
  const reads = await blockerReads(db, shown.flatMap((r) => (nowMs - Date.parse(r.at) > BLOCKED_EXPIRES_MS ? [] : storedBlockedBy(r.blocked_by))));
  for (const r of shown) {
    const self = `${r.repo}#${r.number}`;
    for (const ref of activeFrom(reads, self, r.blocked_by, r.at, nowMs)) {
      const facts = out.get(ref) ?? [];
      if (facts.length < 5) facts.push(`Blocks the review of ${self}`);
      out.set(ref, facts);
    }
  }
  return out;
}

/**
 * activeBlockers() and hasOpenQuestion() for many PRs, for one planner pass: the items, open decisions and latest reviews of the
 * refs are read in one batch (blockerReads) per new set of refs, starting with every ref a stored hold names.
 */
export function blockersLoader(db: Db): { active: (self: string, stored: string | null | undefined, at: string, nowMs: number) => Promise<string[]>; openQuestion: (refs: readonly string[]) => Promise<boolean> } {
  const reads: BlockerReads = { item: new Map(), pending: new Set(), latest: new Map() };
  const asked = new Set<string>();
  const key = (ref: string): string | null => { const m = REF.exec(ref); return m ? `${m[1]}#${Number(m[2])}` : null; };
  const ensure = async (refs: readonly string[]): Promise<void> => {
    const fresh = refs.filter((r) => { const k = key(r); if (k === null || asked.has(k)) return false; asked.add(k); return true; });
    if (!fresh.length) return;
    const r = await blockerReads(db, fresh);
    for (const [k, v] of r.item) reads.item.set(k, v);
    for (const k of r.pending) reads.pending.add(k);
    for (const [k, v] of r.latest) reads.latest.set(k, v);
  };
  let started = false;
  const start = async (): Promise<void> => {
    if (started) return;
    started = true;
    await ensure((await db.all(db.k.selectFrom("main.opus_reviews").select("blocked_by").distinct().where("verdict", "=", "hold").where("blocked_by", "is not", null))).flatMap((r) => storedBlockedBy(r.blocked_by)));
  };
  const openQuestion = async (refs: readonly string[]): Promise<boolean> => { await start(); await ensure(refs); return refs.some((r) => { const k = key(r); return k !== null && reads.pending.has(k); }); };
  const active = async (self: string, stored: string | null | undefined, at: string, nowMs: number): Promise<string[]> => {
    const refs = storedBlockedBy(stored);
    if (!refs.length || nowMs - Date.parse(at) > BLOCKED_EXPIRES_MS) return [];
    await start();
    await ensure(refs);
    return activeFrom(reads, self, stored, at, nowMs);
  };
  return { active, openQuestion };
}
