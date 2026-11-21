// "Merge #n and open a follow-up issue": the press holds the issue, the Act step opens it once after the PR merged and drops it when the PR closes unmerged.
// A fix-up-and-merge follow-up still opens when someone else merges the PR during the fix-up (the merge itself cancels the pre-approval).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAct } from "../src/act/index.ts";
import { doCard } from "../src/conversations/act.ts";
import { decisionStamp } from "../src/conversations/cards.ts";
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
  const held = async () => await w.rows("SELECT number, state, issue_number, reason FROM held_followups ORDER BY number");
  assert.deepEqual((await held()).map((h) => h.state), ["held", "held"]);

  // PR 3: a fix-up-and-merge press; the PR is merged on GitHub at 10:00 and the pre-approval cancels itself after that.
  const pre = Number((await w.db.prepare("INSERT INTO preapprovals (repo, number, by, at, instructions, state, from_head, updated_at, fix_id, reason) VALUES ('app', 3, 'op', ?, 'rename', 'cancelled', 'sha3', '2026-01-02T10:05:00Z', 1, 'the PR was merged before the fix-up finished') RETURNING id").get(T0) as { id: number }).id);
  await w.db.prepare("INSERT INTO held_followups (card_id, preapproval_id, repo, number, issue_repo, title, body, by, at, updated_at) VALUES (0, ?, 'app', 3, 'app', 'Follow-up of 3', 'Body.', 'op', ?, ?)").run(pre, T0, T0);
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
