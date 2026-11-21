// Embedding new and changed items into `item_embeddings`. Each batch commits on
// its own, so an interrupted run loses at most one batch and the next run picks
// up where it stopped.
import type { Embedder } from "./model.ts";
import { fillEmbedHashes } from "../itemhash.ts";
import { itemText } from "./text.ts";
import { plannedItems } from "../core/select-items.ts";
import type { PlanSet } from "../core/plan-set.ts";
import { embedStatements, statementsDue } from "../memory/statements.ts";
import { forEachSeq, mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

export type Todo = { repo: string; number: number; text: string; hash: string };

export const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

const todoOf = async (db: Db, repo: string, number: number, hash: string): Promise<Todo> => {
  const t = (await db.get(db.k.selectFrom("main.items").select(["title", "body"]).where("repo", "=", repo).where("number", "=", number)))!;
  return { repo, number, text: itemText(t.title, t.body), hash };
};

const diffQuery = (db: Db, all: boolean, model: string) => db.k.selectFrom("main.items as i")
  .leftJoin("main.item_embeddings as e", (j) => j.onRef("e.repo", "=", "i.repo").onRef("e.number", "=", "i.number"))
  .select(["i.repo", "i.number", "i.embed_hash as hash"])
  .$narrowType<{ hash: string }>()
  .where((eb) => eb("i.repo", "in", eb.selectFrom("main.tracked_repos").select("name")))
  .$if(!all, (q) => q.where((eb) => eb.and([
    eb("i.state", "<>", "OPEN"),
    eb.or([eb("e.model", "is distinct from", model), eb("e.hash", "is distinct from", eb.ref("i.embed_hash"))]),
  ])));

/**
 * What to embed, shortest text first so batches pad little: the open items the Plans send here (every tracked item with `all`).
 * Closed items have no Plan; the ones with a missing or stale vector are added so that duplicate scans still find them.
 * Reads only; the item rows' missing hashes are filled by embedItems.
 */
export async function pending(db: Db, modelId: string, all = false, plans?: PlanSet): Promise<Todo[]> {
  // The first query runs on covering indexes; only the rows that differ are read in full.
  const diff = await db.all(diffQuery(db, all, modelId));
  const planned = all ? [] : (await plannedItems(db, "embed", { model: modelId, run: null, ...(plans ? { plans } : {}) })).map((p) => ({ repo: p.facts.repo, number: p.facts.number, hash: p.facts.embedHash }));
  return (await mapSeq([...planned, ...diff], async (r) => await todoOf(db, r.repo, r.number, r.hash))).sort((a, b) => a.text.length - b.text.length);
}

/** Whether the embed step has work: open items the Plans send here, or closed ones with a missing or stale vector. */
export async function embedDue(db: Db, modelId: string, plans?: PlanSet): Promise<boolean> {
  if (plans ? plans.items.some((p) => p.plan.actions.some((a) => a.kind === "embed")) : (await plannedItems(db, "embed", { model: modelId, run: null })).length) return true;
  // Owner statements (src/memory/) are embedded by the same step.
  if (await statementsDue(db, modelId)) return true;
  return !!await db.get(diffQuery(db, false, modelId).limit(1));
}

// Vectors of items that left the mirror or the tracked repos.
export async function prune(db: Db): Promise<number> {
  return Number((await db.run(db.k.deleteFrom("main.item_embeddings").where((eb) => eb.or([
    eb("main.item_embeddings.repo", "not in", eb.selectFrom("main.tracked_repos").select("name")),
    eb.not(eb.exists(eb.selectFrom("main.items as i").select(eb.lit(1).as("one"))
      .whereRef("i.repo", "=", "main.item_embeddings.repo").whereRef("i.number", "=", "main.item_embeddings.number"))),
  ])))).changes);
}

export type Progress = { done: number; total: number; ms: number };

export async function embedItems(db: Db, embedder: Embedder,
  opts: { all?: boolean; batch?: number; onProgress?: (p: Progress) => void } = {}): Promise<{ embedded: number; pruned: number; ms: number }> {
  const start = performance.now();
  const pruned = await prune(db);
  await fillEmbedHashes(db);
  const todo = await pending(db, embedder.id, opts.all);
  const size = opts.batch ?? 32;
  let done = 0;
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    const vecs = await embedder.embed(batch.map((t) => t.text), "item");
    const at = new Date().toISOString();
    await db.write(async () => {
      // Delete and insert, not an upsert: a rewritten row gets a new rowid, which is how the vector index (vectors.ts) sees it changed.
      await forEachSeq(batch, async (t, k) => {
        await db.run(db.k.deleteFrom("main.item_embeddings").where("repo", "=", t.repo).where("number", "=", t.number));
        await db.run(db.k.insertInto("main.item_embeddings").values({ repo: t.repo, number: t.number, model: embedder.id, hash: t.hash, vec: toBlob(vecs[k]!), at }));
      });
    });
    done += batch.length;
    opts.onProgress?.({ done, total: todo.length, ms: performance.now() - start });
  }
  await embedStatements(db, embedder, size);
  return { embedded: done, pruned, ms: performance.now() - start };
}
