// A vector that is embedded again gets a rowid above every other, which is how the dashboard's vector index (src/embed/vectors.ts)
// learns that a stored vector changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { embedItems } from "../src/embed/store.ts";
import type { Embedder } from "../src/embed/model.ts";
import * as kx from "../src/db/kx.ts";
import { world } from "./world-db.ts";

test("embedding an item again replaces its vector under a rowid above every other", async () => {
  const w = await (await (await (await world()).repo()).issue(1, { title: "crash on open" })).issue(2, { title: "slow export" });
  let x = 1;
  const embedder: Embedder = { id: "m", dim: 2, embed: async (texts) => texts.map(() => new Float32Array([x, 0])) };
  const rowids = async () => (await w.db.all(w.db.k.selectFrom("item_embeddings").select([kx.rowid("item_embeddings").as("rid")]))).map((r) => r.rid);
  const stored = async () => (await w.db.get(w.db.k.selectFrom("item_embeddings").select([kx.rowid("item_embeddings").as("rid"), "vec"]).where("number", "=", 1)))!;
  await embedItems(w.db, embedder, { all: true });
  const first = await stored();
  const before = Math.max(...await rowids());
  assert.equal(first.rid, before);
  // Item 1 held the highest rowid; a shorter title makes it the first one embedded again.
  await w.db.run(w.db.k.updateTable("main.items").set({ title: "x" }).where("number", "=", 1));
  x = 2;
  await embedItems(w.db, embedder, { all: true });
  const second = await stored();
  assert.ok(second.rid > before);
  assert.notDeepEqual(second.vec, first.vec);
  assert.equal((await w.db.all(w.db.k.selectFrom("item_embeddings").select("number"))).length, 2);
});
