// A Retry on a refused merge lets the merge step try again at once, instead of waiting for CI or the mergeable state to change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrFacts } from "../src/core/facts.ts";
import { mergeDecisionId } from "../src/core/rules.ts";
import { world } from "./world-db.ts";

test("a retry after a refused merge clears the refusal at that head", async () => {
  const w = await (await (await (await world()).repo()).pr(1)).review(1);
  const head = (await w.db.get(w.db.k.selectFrom("items").select("head_oid").where("repo", "=", "app").where("number", "=", 1)))!.head_oid!;
  await w.db.run(w.db.k.insertInto("merges").values({ repo: "app", number: 1, head_oid: head, run_id: "m", at: "2026-01-01T00:00:00Z", path: "operator", outcome: "refused", reason: "safe-merge: REFUSED", ci: "success", mergeable: "MERGEABLE" }));
  const last = async () => (await loadPrFacts(w.db)).find((f) => f.number === 1)!.lastMerge;
  assert.equal((await last())?.outcome, "refused");
  await w.db.run(w.db.k.insertInto("audit").values({ at: "2026-01-01T00:05:00Z", login: "op", action: "retry", target: mergeDecisionId("app", 1, head) }));
  assert.equal(await last(), null);
});
