// The stored link between an implement workflow and its PR (item_workflows.pr_number): its writer at every event, its readers with and without
// it, and both against the rules it stands for (test/legacy-link.ts) (SQLite; Postgres when AUTOCRAFT_TEST_PG_URL is set).
import assert from "node:assert/strict";
import type { Db } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import * as kx from "../../src/db/kx.ts";
import { loadImplementFacts } from "../../src/data/implement/index.ts";
import { implementsLive, worksOnPr } from "../../src/data/workflow/fragments.ts";
import { linkWorkflows, listWorkflows, loadLinks, moveWorkflows, saveWorkflows, startWorkflows, type WorkflowState } from "../../src/data/workflow/index.ts";
import { workOf } from "../../src/workflow/work.ts";
import { expectFlat } from "../helpers/query-count.ts";
import * as legacy from "../legacy-link.ts";
import { prng } from "../random-pr.ts";
import { both, openApp } from "./planner-helpers.ts";

/** Minute `m` of the tests' day. */
const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
const REPO = "o/a";
const issue = (number: number) => ({ repo: REPO, number });
const start = (number: number, m: number) => ({ repo: REPO, number, kind: "issue" as const, entry: "implement" as const, weight: 5, startedBy: "ann", startedVia: "cli" as const, at: at(m) });

type AttemptIn = { number: number; state?: string; made: number; moved?: number; pr?: number | null };
/** Rows as the implement module and the sync write them, straight into the tables. */
const rows = (db: Db) => {
  const q = queryDb(db), k = q.k as any;
  let tries = 0;
  return {
    attempt: async (a: AttemptIn): Promise<number> => Number(((await q.all(k.insertInto("main.implementations").values({
      repo: REPO, number: a.number, queued_by: "ann", state: a.state ?? "opening", attempt: ++tries, text_hash: "h", pr_number: a.pr ?? null, created_at: at(a.made), updated_at: at(a.moved ?? a.made),
    }).returning("id"))) as { id: number | string }[])[0]!.id),
    /** The attempt's step: what openImplementationPr and the advance pass write. */
    move: (id: number, m: number, set: { state?: string; pr_number?: number }) => q.run(k.updateTable("main.implementations").set({ ...set, updated_at: at(m) }).where("id", "=", id)),
    pr: async (number: number, state: "OPEN" | "CLOSED" | "MERGED" = "OPEN", closed: number | null = null) => {
      await q.run(k.insertInto("main.items").values({ repo: REPO, number, kind: "pr", state, closed_at: closed === null ? null : at(closed) })
        .onConflict((oc: any) => oc.columns(["repo", "number"]).doUpdateSet({ state, closed_at: closed === null ? null : at(closed) })));
    },
    /** A workflow as a writer that does not know the column makes it. */
    unlinked: async (number: number, m: number, state: WorkflowState = "running"): Promise<number> => Number(((await q.all(k.insertInto("main.item_workflows").values({
      repo: REPO, number, kind: "issue", entry: "implement", weight: 5, state, started_by: "ann", started_at: at(m), started_via: "cli", plan: "[]", updated_at: at(m),
    }).returning("id"))) as { id: number | string }[])[0]!.id),
    stored: async (id: number): Promise<number | null> => (await listWorkflows(db, { ids: [id] }))[0]!.prNumber,
  };
};
const startOne = async (db: Db, number: number, m: number): Promise<number> => (await startWorkflows(db, [start(number, m)])).get(`${REPO}#${number}`)!;
const end = (db: Db, id: number, m: number, state: WorkflowState = "stopped") => saveWorkflows(db, [{ id, patch: { state }, at: at(m) }]);
const links = async (db: Db, number: number, o: { ended?: true } = {}) => (await loadLinks(db, { issues: [issue(number)] }, o)).map((l) => [l.workflowId, l.pr] as const);

both("opening a PR links the issue's live workflow and nothing else of it: a command that read the workflow before still applies, and a second run writes nothing", async ({ db }) => {
  const r = rows(db);
  const w = await startOne(db, 1, 10);
  const before = (await listWorkflows(db, { ids: [w] }))[0]!;
  assert.deepEqual(await links(db, 1), []);
  const i = await r.attempt({ number: 1, made: 11 });
  assert.deepEqual(await linkWorkflows(db), [], "an attempt without a PR");
  await r.pr(100);
  await r.move(i, 12, { pr_number: 100 });
  assert.deepEqual(await linkWorkflows(db, { issues: [issue(2)] }), []);
  assert.deepEqual(await linkWorkflows(db, { issues: [issue(1)] }), [{ workflowId: w, repo: REPO, issue: 1, pr: 100, live: true }]);
  assert.deepEqual(await linkWorkflows(db), []);
  const after = (await listWorkflows(db, { ids: [w] }))[0]!;
  assert.deepEqual(after, { ...before, prNumber: 100 });
  assert.equal((await moveWorkflows(db, [{ id: w, patch: { state: "waiting" }, at: at(13), was: { state: before.state, updatedAt: before.updatedAt } }])).size, 1);
  // Two writers with the same reading: one writes.
  await queryDb(db).run((queryDb(db).k as any).updateTable("main.item_workflows").set({ pr_number: null }).where("id", "=", w));
  const both2 = await Promise.all([linkWorkflows(db), linkWorkflows(db)]);
  assert.equal(await r.stored(w), 100);
  assert.ok(both2.flat().length >= 1);
});

both("without a live workflow the newest ended one takes the PR an attempt opens, whatever it was linked to before", async ({ db }) => {
  const r = rows(db);
  const w = await startOne(db, 1, 10);
  const i = await r.attempt({ number: 1, made: 11, pr: 100 });
  await r.pr(100);
  await linkWorkflows(db);
  await r.move(i, 12, { state: "closed" });
  await r.pr(100, "CLOSED", 12);
  const j = await r.attempt({ number: 1, made: 13 });
  await end(db, w, 14);
  await r.pr(101);
  await r.move(j, 15, { pr_number: 101 });
  assert.deepEqual((await linkWorkflows(db, { issues: [issue(1)] })).map((l) => [l.pr, l.live]), [[101, false]]);
  assert.deepEqual(await links(db, 1), [], "live workflows only");
  assert.deepEqual(await links(db, 1, { ended: true }), [[w, 101]]);
});

both("a start takes over the PR of an attempt that has not ended, and neither that of one that has nor one merged or closed before it", async ({ db }) => {
  const r = rows(db);
  for (const [n, o] of [[1, {}], [2, { state: "closed" }], [3, { state: "pr-opened" }]] as const) {
    await r.attempt({ number: n, made: 5, ...o, pr: 100 + n });
    await r.pr(100 + n, n === 3 ? "MERGED" : "OPEN", n === 3 ? 6 : null);
  }
  const ids = await startWorkflows(db, [start(1, 10), start(2, 10), start(3, 10)]);
  const [a, b, c] = [1, 2, 3].map((n) => ids.get(`${REPO}#${n}`)!);
  assert.deepEqual([await r.stored(a!), await r.stored(b!), await r.stored(c!)], [101, null, null]);
  assert.deepEqual(await linkWorkflows(db), []);
  // The end of the attempt whose PR was merged before the start, recorded after it: still none of the workflow's.
  await queryDb(db).run((queryDb(db).k as any).updateTable("main.implementations").set({ state: "merged", updated_at: at(12) }).where("number", "=", 3));
  assert.deepEqual(await linkWorkflows(db), []);
  assert.deepEqual(await links(db, 3), []);
});

both("the link stays when the attempt ends, its PR closes and reopens, and the workflow stops; a restart links its own row, an attempt made for it is its own", async ({ db }) => {
  const r = rows(db);
  const w = await startOne(db, 1, 10);
  const i = await r.attempt({ number: 1, made: 11, pr: 100 });
  await r.pr(100);
  await linkWorkflows(db);
  for (const [m, state] of [[12, "CLOSED"], [13, "OPEN"]] as const) {
    await r.pr(100, state, state === "OPEN" ? null : m);
    await r.move(i, 12, { state: "closed" });
    assert.deepEqual(await linkWorkflows(db), []);
    assert.deepEqual(await links(db, 1), [[w, 100]]);
  }
  // A second attempt has no PR yet, then one: the newest is the workflow's.
  const j = await r.attempt({ number: 1, made: 14 });
  assert.deepEqual(await linkWorkflows(db), []);
  assert.deepEqual(await links(db, 1), [[w, 100]]);
  await r.pr(101);
  await r.move(j, 15, { pr_number: 101 });
  await linkWorkflows(db);
  assert.deepEqual(await links(db, 1), [[w, 101]]);
  assert.deepEqual(await loadLinks(db, { prs: [{ repo: REPO, number: 100 }] }, { ended: true }), [], "the older PR is none of its work, reopened or not");
  await end(db, w, 16);
  const w2 = await startOne(db, 1, 17);
  assert.deepEqual(await links(db, 1, { ended: true }), [[w, 101], [w2, 101]], "both worked on it");
  await r.move(j, 18, { state: "closed" });
  await r.attempt({ number: 1, made: 19, pr: 102 });
  await r.pr(102);
  await linkWorkflows(db);
  assert.deepEqual(await links(db, 1, { ended: true }), [[w, 101], [w2, 102]]);
  assert.deepEqual((await loadLinks(db, { workflowIds: [w2] })).map((l) => l.pr), [102]);
  assert.deepEqual((await loadLinks(db, { prs: [{ repo: REPO, number: 102 }] })).map((l) => l.workflowId), [w2]);
});

both("a carried-over PR stays the workflow's when a new attempt starts after its end", async ({ db }) => {
  const r = rows(db);
  const i = await r.attempt({ number: 1, made: 5, pr: 100 });
  await r.pr(100);
  const w = await startOne(db, 1, 10);
  await r.pr(100, "CLOSED", 11);
  await r.move(i, 12, { state: "closed" });
  await r.attempt({ number: 1, made: 13 });
  assert.deepEqual(await links(db, 1), [[w, 100]]);
  assert.deepEqual(await linkWorkflows(db), []);
});

both("rows written without the link read as the linked ones do, and one run links them; a second PR opened without it is linked then too", async ({ db }) => {
  const r = rows(db);
  const stopped = await r.unlinked(1, 10, "stopped");
  const i = await r.attempt({ number: 1, made: 11, pr: 100 });
  await r.pr(100);
  const w = await r.unlinked(1, 20);
  const read = async () => [await links(db, 1, { ended: true }), await loadLinks(db, { prs: [{ repo: REPO, number: 100 }] }, { ended: true })];
  const plain = await read();
  assert.deepEqual(plain[0], [[stopped, 100], [w, 100]]);
  assert.equal((await linkWorkflows(db)).length, 2);
  assert.deepEqual(await read(), plain);
  assert.deepEqual(await linkWorkflows(db), []);
  await r.move(i, 21, { state: "closed" });
  await r.attempt({ number: 1, made: 22, pr: 101 });
  await r.pr(101);
  assert.deepEqual((await linkWorkflows(db)).map((l) => [l.workflowId, l.pr]), [[w, 101]]);
  assert.deepEqual(await links(db, 1, { ended: true }), [[stopped, 100], [w, 101]]);
});

// ---- against the rules the link stands for -------------------------------------------------------------------

type Wf = { id: number; number: number; state: string; started: number; born: number };
type Att = { id: number; number: number; state: string; made: number; moved: number; pr: number | null; born: number };
type Pr = { number: number; state: "OPEN" | "CLOSED" | "MERGED"; closed: number | null; mirrored: boolean };
/** One issue's history: what each checkpoint's database holds of it. */
type Snapshot = { wfs: Wf[]; atts: Att[]; prs: Pr[] };

const LIVE = ["running", "waiting", "blocked", "recommending"];
const ENDED_ATTEMPTS = ["merged", "closed", "failed", "cancelled"];
const STEPS = 4, EVENTS = 4;

/** A random history of issue `n` in STEPS checkpoints: up to three workflows and attempts, their PRs mirrored or not. Ids grow with time. */
function history(n: number, x: () => number, id: () => number): Snapshot[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(x() * xs.length)]!;
  const wfs: Wf[] = [], atts: Att[] = [], prs: Pr[] = [], out: Snapshot[] = [];
  let m = 0;
  for (let step = 0; step < STEPS; step++) {
    for (let e = 0; e < EVENTS; e++) {
      m++;
      const live = wfs.find((w) => LIVE.includes(w.state)), cur = atts.find((a) => !ENDED_ATTEMPTS.includes(a.state)), pr = prs.length ? pick(prs) : null;
      const can: (() => void)[] = [];
      if (!live && wfs.length < 3) {
        const add = (state: string) => wfs.push({ id: id(), number: n, state, started: m, born: step });
        can.push(() => add(pick(LIVE)), () => add(pick(LIVE)), () => add(pick(["backlog", "closed", "stopped"])));
      }
      if (live) can.push(() => { live.state = pick(["done", "stopped", "closed", "backlog"]); });
      if (!cur && atts.length < 3) for (let i = 0; i < (live ? 3 : 1); i++) can.push(() => atts.push({ id: id(), number: n, state: pick(["planning", "implementing"]), made: m, moved: m, pr: null, born: step }));
      if (cur && cur.pr === null) for (let i = 0; i < 3; i++) can.push(() => {
        cur.pr = 100_000 + n * 10 + prs.length;
        Object.assign(cur, { state: "pr-opened", moved: m });
        prs.push({ number: cur.pr, state: "OPEN", closed: null, mirrored: x() < 0.9 });
      });
      if (cur) can.push(() => Object.assign(cur, { state: pick(ENDED_ATTEMPTS), moved: m }));
      if (pr) {
        if (pr.state === "OPEN") can.push(() => Object.assign(pr, { state: pick(["CLOSED", "CLOSED", "MERGED"]), closed: m }));
        else if (pr.state === "CLOSED") can.push(() => Object.assign(pr, { state: "OPEN", closed: null }));
        if (!pr.mirrored) can.push(() => { pr.mirrored = true; });
      }
      if (can.length) pick(can)();
    }
    out.push(structuredClone({ wfs, atts, prs }));
  }
  return out;
}

/** Writes checkpoint `step` of every history into `repo` (ids shifted by `shift`), over the rows the checkpoints before it wrote. */
async function write(db: Db, repo: string, shift: number, step: number, all: Snapshot[][]): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  const now = all.map((h) => h[step]!);
  const put = async (table: string, cols: Record<string, unknown>[], old: Record<string, any>[], keys: string[]) => {
    await kx.updateFrom(db, table, keys, old as never);
    for (const b of kx.batches(cols)) await q.run(k.insertInto(table).values(b));
  };
  await db.write(async () => {
    const wfs = now.flatMap((s) => s.wfs), atts = now.flatMap((s) => s.atts);
    await put("main.item_workflows",
      wfs.filter((w) => w.born === step).map((w) => ({ id: w.id + shift, repo, number: w.number, kind: "issue", entry: "implement", state: w.state, started_by: "ann", started_at: at(w.started), started_via: "cli", updated_at: at(w.started) })),
      wfs.filter((w) => w.born < step).map((w) => ({ id: w.id + shift, state: w.state })), ["id"]);
    await put("main.implementations",
      atts.filter((a) => a.born === step).map((a) => ({ id: a.id + shift, repo, number: a.number, queued_by: "ann", state: a.state, attempt: a.id, text_hash: "h", pr_number: a.pr, created_at: at(a.made), updated_at: at(a.moved) })),
      atts.filter((a) => a.born < step).map((a) => ({ id: a.id + shift, state: a.state, pr_number: a.pr, updated_at: at(a.moved) })), ["id"]);
    const prs = now.flatMap((s) => s.prs).filter((p) => p.mirrored).map((p) => ({ repo, number: p.number, kind: "pr", state: p.state, closed_at: p.closed === null ? null : at(p.closed) }));
    for (const b of kx.batches(prs)) await q.run(k.insertInto("main.items").values(b).onConflict((oc: any) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["state", "closed_at"]))));
  });
}

type Reading = { live: Map<number, number>; all: Map<number, Map<number, number>> };
/** What the link says of every issue of `repo`: PR to its live workflow, and PR to every workflow on it (id to id), ids unshifted. */
async function reading(db: Db, repo: string, shift: number, numbers: number[]): Promise<Reading> {
  const out: Reading = { live: new Map(), all: new Map() };
  for (const ns of kx.chunks(numbers, KEYS)) for (const l of await loadLinks(db, { issues: ns.map((number) => ({ repo, number })) }, { ended: true })) {
    (out.all.get(l.pr) ?? out.all.set(l.pr, new Map()).get(l.pr)!).set(l.workflowId - shift, l.issue);
    if (l.live) { assert.ok(!out.live.has(l.pr), `two live workflows on #${l.pr}`); out.live.set(l.pr, l.workflowId - shift); }
  }
  return out;
}

const CASES = 400;
/** Keys of one load: SQLite walks the JSON key list once per row it compares. */
const KEYS = 200;
both(`over ${CASES} random histories the link, stored or not, gives what the rules before it gave, but for a PR over before the start, an older PR of the workflow, an earlier workflow's end and a carried-over PR`, async ({ db }) => {
  const x = prng(20260101);
  const numbers = Array.from({ length: CASES }, (_, i) => i + 1);
  let next = 0;
  const all = numbers.map((n) => history(n, x, () => ++next));
  const SHIFT = 1_000_000;
  const refs = (repo: string, ns: number[]) => ns.map((number) => ({ repo, number }));
  // The linked repo's rows get their link at a random half of the checkpoints, as ticks and openings between them would give it; the plain one's never.
  for (let step = 0; step < STEPS; step++) {
    await write(db, "o/linked", 0, step, all);
    await write(db, "o/plain", SHIFT, step, all);
    for (const ns of kx.chunks(numbers.filter(() => step === STEPS - 1 || x() < 0.5), KEYS)) await linkWorkflows(db, { issues: refs("o/linked", ns) });
  }
  for (const ns of kx.chunks(numbers, KEYS)) assert.deepEqual(await linkWorkflows(db, { issues: refs("o/linked", ns) }), [], "a second run");
  const last = all.map((h) => h.at(-1)!);
  const linked = await reading(db, "o/linked", 0, numbers), plain = await reading(db, "o/plain", SHIFT, numbers);
  const keyed = async <T>(ns: number[], load: (part: number[]) => Promise<T[]>): Promise<T[]> => { const out: T[] = []; for (const part of kx.chunks(ns, KEYS)) out.push(...await load(part)); return out; };
  const prNumbers = last.flatMap((s) => s.prs.map((p) => p.number));

  // The other readers of the same predicate agree with loadLinks.
  for (const [repo, shift, got] of [["o/linked", 0, linked], ["o/plain", SHIFT, plain]] as const) {
    const q = queryDb(db), k = q.k as any;
    const pairs = await q.all(k.selectFrom("main.item_workflows as w").innerJoin("main.implementations as a", (j: any) => j.onRef("a.repo", "=", "w.repo").onRef("a.number", "=", "w.number"))
      .where("w.repo", "=", repo).where("a.pr_number", "is not", null).where((eb: any) => worksOnPr(eb, "w", "a.pr_number")).select(["w.id as id", "a.pr_number as pr"])) as { id: number | string; pr: number | string }[];
    assert.deepEqual(pairs.map((p) => `${Number(p.id) - shift}:${p.pr}`).sort(), [...got.all].flatMap(([pr, ws]) => [...ws.keys()].map((w) => `${w}:${pr}`)).sort());
    const on = await q.all(k.selectFrom("main.items as it").where("it.repo", "=", repo).where((eb: any) => implementsLive(eb, "it.repo", "it.number")).select("it.number as n")) as { n: number | string }[];
    const mirrored = new Set(last.flatMap((s) => s.prs.filter((p) => p.mirrored).map((p) => p.number)));
    assert.deepEqual(on.map((r) => Number(r.n)).sort(), [...got.live.keys()].filter((n) => mirrored.has(n)).sort());
    const byPr = await keyed(prNumbers, (ns) => loadLinks(db, { prs: refs(repo, ns) }));
    assert.deepEqual(byPr.map((l) => `${l.workflowId - shift}:${l.pr}`).sort(), [...got.live].map(([pr, w]) => `${w}:${pr}`).sort());
  }

  const oldLive = new Map(await keyed(prNumbers, async (ns) => [...await legacy.loadPrWorkflows(db, refs("o/plain", ns), { others: true })]));
  const oldEnded = new Map(await keyed(prNumbers, async (ns) => [...await legacy.loadEndedWorkflows(db, refs("o/plain", ns))]));
  const oldStarted = new Set((await legacy.loadStartedPrs(db)).filter((r) => r.repo === "o/plain").map((r) => r.pr));
  const attempts = new Map(await keyed(numbers, async (ns) => [...(await loadImplementFacts(db, refs("o/plain", ns))).byIssue]));
  const seen = { c1: 0, c2: 0, c3: 0, c7: 0, c8: 0, live: 0, ended: 0 };

  for (const s of last) {
    const n = s.wfs[0]?.number ?? s.atts[0]?.number;
    if (n === undefined) continue;
    const prOf = new Map(s.prs.map((p) => [p.number, p]));
    // The rules, over the rows of this issue.
    const attemptOf = (a: Att, w: Wf) => !ENDED_ATTEMPTS.includes(a.state) || a.made >= w.started || (a.moved >= w.started && !s.atts.some((b) => b.id > a.id));
    const over = (pr: number, w: Wf) => { const p = prOf.get(pr)!; return p.mirrored && p.state !== "OPEN" && p.closed! < w.started; };
    const of = (pr: number) => s.atts.find((a) => a.pr === pr)!;
    const c1 = (pr: number, w: Wf) => attemptOf(of(pr), w) && over(pr, w);
    const c2 = (pr: number, w: Wf) => attemptOf(of(pr), w) && s.atts.some((b) => b.pr !== null && b.id > of(pr).id && attemptOf(b, w));
    // The workflow was linked while the carried-over attempt was the newest; a newer one took its place since.
    const c7 = (pr: number, w: Wf) => !attemptOf(of(pr), w) && of(pr).moved >= w.started;
    // An attempt made for a later workflow of the issue is not an earlier one's, whose end the old rule read once the later one was left out.
    const c8 = (pr: number, w: Wf) => s.wfs.some((v) => v.id > w.id && v.started <= of(pr).made);
    const state = new Map(s.wfs.map((w) => [w.id, w]));
    const live = s.wfs.find((w) => LIVE.includes(w.state)) ?? null;

    // A live workflow's PR: the pass's own rule, with C7 as the only difference.
    if (live) {
      const a = attempts.get(`o/plain#${n}`) ?? null;
      const cand = legacy.candidatePr(a, { startedAt: at(live.started) });
      const p = cand === null ? null : prOf.get(cand)!;
      const item = p?.mirrored ? { state: p.state as string, closed_at: p.closed === null ? null : at(p.closed) } : null;
      const want = legacy.overBefore(item, at(live.started)) ? null : cand;
      assert.equal(workOf(a, { startedAt: at(live.started) }, item).pr, want);
      const of_ = (r: Reading) => s.prs.find((q) => r.live.get(q.number) === live.id)?.number ?? null;
      assert.equal(of_(plain), want, `issue ${n}, not linked`);
      const got = of_(linked);
      if (got !== want) { assert.ok(got !== null && c7(got, live), `issue ${n}: linked to ${got}, the rule says ${want}`); seen.c7++; }
      else if (got !== null) seen.live++;
    }

    for (const p of s.prs) {
      const key = `o/plain#${p.number}` as const;
      const was = oldLive.get(key) ? oldLive.get(key)!.id - SHIFT : null;
      const now = plain.live.get(p.number) ?? null;
      if (was !== now) {
        assert.ok(was !== null && now === null && live, `issue ${n} #${p.number}: live ${was} became ${now}`);
        if (c1(p.number, live)) seen.c1++;
        else { assert.ok(c2(p.number, live), `issue ${n} #${p.number}: dropped with no reason`); seen.c2++; }
      }
      // The Task Runner's own rule: a current attempt. The link also covers one that ended while the workflow goes on.
      if (now !== null && !oldStarted.has(p.number)) { assert.ok(ENDED_ATTEMPTS.includes(of(p.number).state)); seen.c3++; }
      if (now === null && oldStarted.has(p.number)) assert.ok(live && c1(p.number, live), `issue ${n} #${p.number}: a working attempt's PR is not its work`);

      // How the PR's issue ended, as the ended-workflow loader reads it.
      const endOf = (r: Reading) => {
        const ws = [...(r.all.get(p.number)?.keys() ?? [])].map((id) => state.get(id)!)
          .filter((w) => w.state !== "done" || !s.prs.some((o) => o.mirrored && o.state === "MERGED" && o.closed! >= w.started)).sort((a, b) => b.id - a.id);
        return ws.length && !LIVE.includes(ws[0]!.state) ? ws[0]!.state : undefined;
      };
      const before = oldEnded.get(key);
      for (const [name, r] of [["plain", plain], ["linked", linked]] as const) {
        const after = endOf(r);
        if (after === before) { if (after) seen.ended++; continue; }
        const why = s.wfs.some((w) => c1(p.number, w)) ? "c1" : s.wfs.some((w) => c2(p.number, w)) ? "c2" : s.wfs.some((w) => c8(p.number, w)) ? "c8" : name === "linked" && s.wfs.some((w) => c7(p.number, w)) ? "c7" : null;
        assert.ok(why, `issue ${n} #${p.number} (${name}): ended ${before} became ${after}`);
        seen[why]++;
      }
    }
  }
  for (const [what, count] of Object.entries(seen)) assert.ok(count > 0, `no case of ${what}`);

  // The first run over rows written without the link changes no answer.
  assert.ok((await linkWorkflows(db)).length > 0);
  const first = await reading(db, "o/plain", SHIFT, numbers);
  assert.deepEqual([...first.all].map(([pr, ws]) => [pr, [...ws.keys()].sort()]).sort(), [...plain.all].map(([pr, ws]) => [pr, [...ws.keys()].sort()]).sort());
  assert.deepEqual([...first.live].sort(), [...plain.live].sort());
  assert.deepEqual(await linkWorkflows(db), []);
});

async function flat(n: number) {
  const o = await openApp("sqlite");
  const r = rows(o.db);
  for (let i = 1; i <= n; i++) {
    await r.unlinked(i, 10);
    await r.attempt({ number: i, made: 11, pr: 100 + i });
  }
  return {
    db: o.db, close: () => o.t.close(),
    run: async () => {
      await loadLinks(o.db, { issues: Array.from({ length: n }, (_, i) => issue(i + 1)) });
      assert.equal((await linkWorkflows(o.db)).length, n);
      await loadLinks(o.db, { prs: Array.from({ length: n }, (_, i) => issue(101 + i)) });
    },
  };
}

both("loadLinks and linkWorkflows issue as many statements for 40 workflows as for 4", async () => {
  await expectFlat(flat, 4, 40);
});
