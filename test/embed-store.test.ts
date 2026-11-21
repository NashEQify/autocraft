// A vector that is embedded again gets a new rowid, which is how the dashboard's vector index (src/embed/vectors.ts)
// learns that a stored vector changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { embedItems } from "../src/embed/store.ts";
import type { Embedder } from "../src/embed/model.ts";
import * as kx from "../src/db/kx.ts";
import { world } from "./world-db.ts";

test("embedding an item again replaces its vector under a new rowid", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "slow export" });
  let x = 1;
  const embedder: Embedder = { id: "m", dim: 2, embed: async (texts) => texts.map(() => new Float32Array([x, 0])) };
  const stored = async () => (await w.db.get(w.db.k.selectFrom("item_embeddings").select([kx.rowid("item_embeddings").as("rid"), "vec"]).where("number", "=", 1)))!;
  await embedItems(w.db, embedder, { all: true });
  const first = await stored();
  x = 2;
  await embedItems(w.db, embedder, { all: true });
  const second = await stored();
  assert.ok(second.rid > first.rid);
  assert.notDeepEqual(second.vec, first.vec);
  assert.equal((await w.db.all(w.db.k.selectFrom("item_embeddings").select("number"))).length, 2);
});
