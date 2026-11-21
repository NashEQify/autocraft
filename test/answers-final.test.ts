// An operator's answer is final: a pre-approval whose review cannot proceed asks a Merge question, and a sure re-review keeps an answered merge.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mergeDecisionId } from "../src/core/rules.ts";
import { advancePreapprovals, preapprovalOf, runPipelineStep } from "../src/preapproval/index.ts";
import { markReviewsStale } from "../src/review/discussion.ts";
import { recordReviewFailure, reviewHold } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { OPERATOR, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
const fresh = async (): Promise<World> => (current = await (await world()).repo());
afterEach(() => current?.close());

const save = async (w: World, n: number, head: string, verdict: "take" | "hold", sure: boolean, blocked: string[] = []) =>
  await saveOpus(w.db, "rv", { repo: "app", number: n, head_oid: head }, {
    mode: "full", base: null, model: "m",
    review: { ref: `app#${n}`, verdict, sure, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: blocked },
  });
const startPushed = async (w: World, n: number, to: string) => {
  await runPipelineStep(w.db, { repo: "app", number: n, step: { kind: "fixup", instructions: "rename a to b", merge: true }, by: OPERATOR });
  const fix = (await w.rows("SELECT id FROM operator_fixups WHERE number = ? ORDER BY id DESC", n))[0]!.id as number;
  await w.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at, source, operator_fix) VALUES ('app', ?, ?, ?, 'pushed', 1, ?, 'operator', ?)").run(n, `sha${n}`, to, T0, fix);
  await w.synced(n, to);
};
const settle = async (w: World) => { for (let i = 0; i < 5; i++) await advancePreapprovals(w.db); };

describe("pre-approval and review holds", () => {
  test("the fix-up push lifts a blocked hold; a review that failed for good asks a Merge question", async () => {
    const w = await (await (await (await (await (await fresh()).pr(1)).review(1, { verdict: "take-fix" })).pr(2)).pr(3)).review(3, { verdict: "take-fix" });
    await w.db.run(w.db.k.updateTable("opus_reviews").set({ verdict: "hold" }).where("number", "=", 1));
    await save(w, 1, "sha1", "hold", true, ["app#2"]);
    await startPushed(w, 1, "sha1b");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review", String((await preapprovalOf(w.db, "app", 1))?.reason));
    assert.equal(await reviewHold(w.db, "app", 1, "sha1b"), null);

    await startPushed(w, 3, "sha3b");
    for (let i = 0; i < 4; i++) await recordReviewFailure(w.db, "app", 3, "sha3b");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 3))?.state, "asked");
    assert.equal((await w.rows("SELECT 1 FROM decisions WHERE id = ?", mergeDecisionId("app", 3, "sha3b"))).length, 1);
  });
});

describe("a re-review at the same head", () => {
  test("keeps an answered, unapplied merge answer while sure take, and withdraws it with the reason on a hold", async () => {
    const w = await (await (await (await fresh()).pr(1)).review(1)).answer(1, "merge");
    const id = mergeDecisionId("app", 1, "sha1");
    await save(w, 1, "sha1", "take", true);
    assert.equal((await w.rows("SELECT answer FROM decisions WHERE id = ?", id))[0]?.answer, "merge");
    await save(w, 1, "sha1", "hold", true);
    assert.equal((await w.rows("SELECT 1 FROM decisions WHERE id = ?", id)).length, 0);
    assert.match(String((await w.rows("SELECT answer_note FROM decisions WHERE id LIKE ?", `${id}~replaced-%`))[0]?.answer_note), /new review is a hold/);
  });
});

describe("a review that failed for good", () => {
  test("a request newer than the last failure grants exactly one more try", async () => {
    const w = await (await fresh()).pr(1);
    const t = Date.now() - 60_000;
    for (let i = 0; i < 4; i++) await recordReviewFailure(w.db, "app", 1, "h", t);
    const held = await reviewHold(w.db, "app", 1, "h");
    assert.equal(held?.kind, "failed");
    assert.match(held!.wait, /Review again/);
    await markReviewsStale(w.db, OPERATOR, "app", 1);
    assert.equal(await reviewHold(w.db, "app", 1, "h"), null);
    // The extra try fails too: final again until the next request.
    await recordReviewFailure(w.db, "app", 1, "h", Date.now() + 1000);
    assert.equal((await reviewHold(w.db, "app", 1, "h"))?.kind, "failed");
  });
});

describe("a sure take-fix review of a pre-approved fix-up", () => {
  test("the pipeline's fix-up runs, its push continues the pre-approval, and a take moves it to ci", async () => {
    const w = await (await (await fresh()).pr(1)).review(1, { verdict: "take-fix" });
    await startPushed(w, 1, "sha1b");
    await settle(w);
    await w.review(1, { verdict: "take-fix", head: "sha1b" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
    assert.equal((await w.rows("SELECT 1 FROM decisions WHERE id = ?", mergeDecisionId("app", 1, "sha1b"))).length, 0);
    const kinds = (await w.prPlan(1)).actions.map((a) => `${a.kind}:${String(a.params?.source ?? "")}`);
    assert.ok(kinds.includes("fixup:review"), kinds.join());

    await w.db.prepare("INSERT INTO fixups (repo, number, from_head, to_head, state, attempt, created_at, source) VALUES ('app', 1, 'sha1b', 'sha1c', 'pushed', 1, ?, 'review')").run(T0);
    await w.synced(1, "sha1c");
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.head, "sha1c");
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "review");
    await w.review(1, { head: "sha1c" });
    await settle(w);
    assert.equal((await preapprovalOf(w.db, "app", 1))?.state, "ci");
  });
});
