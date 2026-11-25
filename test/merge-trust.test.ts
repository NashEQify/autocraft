// Merge trust follows the code it covered: an operator's Merge answer does not carry to a head with changed pipeline code, and carried code is held to its source author's tier.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { advancePreapprovals, preapprovalOf } from "../src/preapproval/index.ts";
import { OPERATOR, REGULAR_ID, T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());
const kindsOf = async (w: World, n: number) => (await w.prPlan(n)).actions.map((a) => a.kind);

test("code carried from a closed duplicate by an author who is not whitelisted needs a Merge answer at the head", async () => {
  const w = (current = await (await (await (await (await (await (await (await (await (await (await world()).repo()).pr(5)).review(5, { verdict: "take" })).verified(5)).premerge(5, "clean")).pr(6)).pr(7, { author: "regular" })).review(7, { verdict: "take" })).verified(7)).premerge(7, "clean"));
  await w.db.run(w.db.k.updateTable("items").set({ state: "CLOSED", author: "stranger" }).where("number", "=", 6));
  await w.db.run(w.db.k.insertInto("items").values({ repo: "app", number: 8, kind: "pr", state: "CLOSED", title: "PR 8", author: "regular", author_id: REGULAR_ID, created_at: T0, updated_at: T0 }));
  const carry = async (kept: number, closed: number) => {
    const id = `app:dupegroup:${kept}`;
    await w.db.run(w.db.k.insertInto("dupe_carries").values({ decision_id: id, repo: "app", number: kept, state: "done", outcome: "pushed", updated_at: T0 }));
    await w.db.run(w.db.k.insertInto("dupe_group_items").values({ decision_id: id, repo: "app", number: closed, kind: "pr", role: "close", detail: JSON.stringify({ carry: ["the null check"] }), base_role: "close" }));
  };
  await carry(5, 6);
  await carry(7, 8);
  assert.ok(!(await kindsOf(w, 5)).includes("merge"), (await kindsOf(w, 5)).join());
  assert.ok((await kindsOf(w, 5)).includes("ask-merge"), (await kindsOf(w, 5)).join());
  assert.ok((await kindsOf(w, 7)).includes("merge"), (await kindsOf(w, 7)).join());
});
