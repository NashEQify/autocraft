// "Merge #n and open a follow-up issue": the press holds the issue, the Act step opens it once after the PR merged and drops it when the PR closes unmerged.
// A fix-up-and-merge follow-up still opens when someone else merges the PR during the fix-up (the merge itself cancels the pre-approval).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAct } from "../src/act/index.ts";
import { doCard } from "../src/conversations/act.ts";
import { decisionStamp } from "../src/conversations/cards.ts";
import { answerSeqOf, filingOutcome, heldOf, heldVerdict, holdFollowup, HELD_STUCK_MS } from "../src/conversations/held.ts";
import { HEAD_FACT, MERGE_OPTIONS, mergeDecisionId } from "../src/core/rules.ts";
import { ask, getDecision } from "../src/decisions.ts";
import type { Exec } from "../src/fixup/git.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

test("a follow-up issue on a Merge card is opened once after the merge and dropped when the PR closes unmerged", async () => {
  current = await (await (await (await (await world()).repo()).pr(1)).pr(2)).pr(3);
  const w = current;
  const created: string[] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gh" && args[0] === "issue" && args[1] === "create") { created.push(args[args.indexOf("--title") + 1]!); return { code: 0, stdout: `https://github.com/storytold/app/issues/${100 + created.length}\n`, stderr: "" }; }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  const press = async (n: number) => {
    const id = mergeDecisionId("app", n, `sha${n}`);
    await ask(w.db, [{ id, kind: "merge", repo: "app", number: n, question: "Merge this PR?", facts: [`${HEAD_FACT}sha${n}`], options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: "merge", asked_at: T0 }]);
    const params = { kind: "resolution", steps: [{ kind: "open_issue", repo: "app", title: `Follow-up of ${n}`, body: "The parser still drops the last line." }], settle: { kind: "answer", decision: id, option: "merge", stamp: await decisionStamp(w.db, (await getDecision(w.db, id))!) } };
    const card = Number((await w.db.get(w.db.k.insertInto("conversation_cards").values({ turn_id: 0, repo: "app", number: n, kind: "resolution", params: JSON.stringify(params), description: "merge and open an issue" }).returning("id")))!.id);
    const r = await doCard(w.db, card, "op", { ...w.gh.actDeps(), exec } as never);
    assert.equal(r.card.state, "done", r.card.error ?? "");
    assert.equal((await getDecision(w.db, id))!.answer, "merge");
  };
  await press(1);
  await press(2);
  assert.deepEqual(created, [], "nothing is opened at the press");
  const held = async () => await w.db.all(w.db.k.selectFrom("held_followups").select(["number", "state", "issue_number", "reason"]).orderBy("number"));
  assert.deepEqual((await held()).map((h) => h.state), ["held", "held"]);

  // PR 3: a fix-up-and-merge press; the PR is merged on GitHub at 10:00 and the pre-approval cancels itself after that.
  const pre = (await w.db.get(w.db.k.insertInto("preapprovals").values({ repo: "app", number: 3, by: "op", at: T0, instructions: "rename", state: "cancelled", from_head: "sha3", updated_at: "2026-01-02T10:05:00Z", fix_id: 1, reason: "the PR was merged before the fix-up finished" }).returning("id")))!.id;
  await w.db.run(w.db.k.insertInto("held_followups").values({ card_id: 0, preapproval_id: pre, repo: "app", number: 3, issue_repo: "app", title: "Follow-up of 3", body: "Body.", by: "op", at: T0, updated_at: T0 }));
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED", merged_at: "2026-01-02T10:00:00Z" }).where("repo", "=", "app").where("number", "=", 3));
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED" }).where("repo", "=", "app").where("number", "=", 1));
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED" }).where("repo", "=", "app").where("number", "=", 2));
  for (let k = 0; k < 2; k++) await runAct(w.db, { repo: "app", dryRun: false }, () => {}, { ...w.gh.actDeps(), exec });

  assert.deepEqual(created, ["Follow-up of 1", "Follow-up of 3"], "each opened once, after the merge");
  const [one, two, three] = await held();
  assert.equal(three!.state, "filed");
  assert.equal(one!.state, "filed");
  assert.ok(one!.issue_number);
  assert.equal(two!.state, "dropped");
  assert.match(String(two!.reason), /closed without merging/);
});

test("a held row is dropped when its Merge answer was taken back, and a row left in filing is settled from its audit row", async () => {
  current = await (await (await world()).repo()).pr(1);
  const w = current;
  const audit = (action: string, at: string, target: string | null, details: string | null) => w.db.run(w.db.k.insertInto("audit").values({ at, login: "op", action, target, details }));
  const hold = async (decision: string | null, answerSeq: number | null) => {
    const id = await holdFollowup(w.db, { card_id: 0, choice_id: null, decision_id: decision, answer_seq: answerSeq, preapproval_id: null, repo: "app", number: 1, issue_repo: "app", title: "t", body: "b", by: "op", at: T0 });
    return (await heldOf(w.db, "app", 1)).find((h) => h.id === id)!;
  };
  const id = mergeDecisionId("app", 1, "sha1");
  await ask(w.db, [{ id, kind: "merge", repo: "app", number: 1, question: "Merge this PR?", facts: [`${HEAD_FACT}sha1`], options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: "merge", asked_at: T0 }]);
  await audit("answer", "2026-01-02T09:00:00Z", id, null);
  assert.equal(await answerSeqOf(w.db, id), 1);
  const row = await hold(id, 1);
  await w.db.run(w.db.k.updateTable("items").set({ state: "MERGED", merged_at: "2026-01-02T10:00:00Z" }).where("repo", "=", "app").where("number", "=", 1));
  await w.db.run(w.db.k.updateTable("decisions").set({ answer: "merge", answered_at: "2026-01-02T09:00:00Z" }).where("id", "=", id));
  assert.deepEqual(await heldVerdict(w.db, row), { file: true });
  await audit("undo", "2026-01-02T09:30:00Z", id, null);
  assert.deepEqual(await heldVerdict(w.db, row), { drop: "the Merge answer was taken back" });

  const filing = await hold(null, null);
  await w.db.run(w.db.k.updateTable("held_followups").set({ state: "filing", updated_at: T0 }).where("id", "=", filing.id));
  const stuck = (await heldOf(w.db, "app", 1)).find((h) => h.id === filing.id)!;
  const later = Date.parse(T0) + HELD_STUCK_MS + 1;
  assert.deepEqual(await filingOutcome(w.db, stuck, later), { state: "held" });
  await audit("act-open-issue", "2026-01-02T08:00:00Z", "app#1", "not json");
  await audit("act-open-issue", "2026-01-02T08:01:00Z", "app#1", JSON.stringify({ held: filing.id + 1, state: "done", url: "https://github.com/storytold/app/issues/5" }));
  assert.deepEqual(await filingOutcome(w.db, stuck, later), { state: "held" }, "another row's create does not settle this one");
  await audit("act-open-issue", "2026-01-02T08:02:00Z", "app#1", JSON.stringify({ held: filing.id, state: "done", url: "https://github.com/storytold/app/issues/7" }));
  assert.deepEqual(await filingOutcome(w.db, stuck, later), { state: "filed", number: 7, url: "https://github.com/storytold/app/issues/7" });
});
