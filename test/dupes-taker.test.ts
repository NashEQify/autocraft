// Duplicate pairs of a repo no Task Runner takes are not sent to Jev, and pairs whose Haiku batch no
// Task Runner took do not count as handled, so the dupes job ends idle and the planner parks it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VectorIndex } from "../src/embed/vectors.ts";
import { checkPairs, type PairKey } from "../src/dupes/check.ts";
import { runDupes } from "../src/dupes/index.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { T0, world } from "./world-db.ts";

test("pairs of a repo no Task Runner takes are neither sent to Jev nor counted as handled", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "crashes when opening" });
  await fillEmbedHashes(w.db);
  const hash = async (n: number) => (await w.db.get(w.db.k.selectFrom("items").select("embed_hash").where("repo", "=", "app").where("number", "=", n)))!.embed_hash!;
  const key: PairKey = { repo: "app", a: 1, b: 2, a_hash: await hash(1), b_hash: await hash(2), similarity: 0.9 };
  await w.db.run(w.db.k.insertInto("duplicate_pairs").values({ repo: "app", a: 1, b: 2, a_hash: key.a_hash, b_hash: key.b_hash, similarity: 0.9, created_at: T0 }));
  await w.db.run(w.db.k.insertInto("access").values({ login: "bob", role: "maintainer" }));
  const runner = await createToken(w.db, "bob", "runner", { kind: "runner" });
  await storeStatus(w.db, runner.row.id, "bob", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
  const index = { embedder: { id: "m" }, ready: async () => {} } as unknown as VectorIndex;
  const lines: string[] = [];
  await runDupes(w.db, { dryRun: true }, (l) => lines.push(l), { index, check: {} as never });
  assert.match(lines.join("\n"), /1 pairs to check/, "a Task Runner takes the pair");
  await setUserRepos(w.db, "bob", ["other"]);

  let jev = 0, haiku = 0;
  const handled: number[] = [];
  const check = { jev: async () => (jev++, 0.5), haiku: async () => (haiku++, null), now: () => new Date(T0) };
  const s = await runDupes(w.db, { onHandled: (n) => handled.push(n) }, () => {}, { index, check });
  assert.deepEqual([jev, haiku, s.checked, handled.length], [0, 0, 0, 0], "no pair was sent and none counted");

  // A pair Jev was unsure of whose Haiku batch nobody took: Jev's call counted while it ran, the skipped batch is taken off again.
  const c = await checkPairs(w.db, [key], check, (n) => handled.push(n));
  assert.deepEqual([jev, haiku, c.unanswered], [1, 0, 1]);
  assert.equal(handled.at(-1), 0, "the job ends with nothing handled");
});
