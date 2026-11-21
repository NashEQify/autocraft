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
  const t = await db.prepare("SELECT title, body FROM main.items WHERE repo = ? AND number = ?").get(repo, number) as { title: string | null; body: string | null };
  return { repo, number, text: itemText(t.title, t.body), hash };
};

const DIFF_SQL = `SELECT i.repo, i.number, i.embed_hash AS hash FROM main.items i
    LEFT JOIN main.item_embeddings e ON e.repo = i.repo AND e.number = i.number
    WHERE i.repo IN (SELECT name FROM main.tracked_repos)
      AND (:all OR (i.state <> 'OPEN' AND (e.model IS NOT :model OR e.hash IS NOT i.embed_hash)))`;

/**
 * What to embed, shortest text first so batches pad little: the open items the Plans send here (every tracked item with `all`).
 * Closed items have no Plan; the ones with a missing or stale vector are added so that duplicate scans still find them.
 * Reads only; the item rows' missing hashes are filled by embedItems.
 */
export async function pending(db: Db, modelId: string, all = false, plans?: PlanSet): Promise<Todo[]> {
  // The first query runs on covering indexes; only the rows that differ are read in full.
  const diff = await db.prepare(DIFF_SQL).all({ all: all ? 1 : 0, model: modelId }) as unknown as { repo: string; number: number; hash: string }[];
  const planned = all ? [] : (await plannedItems(db, "embed", { model: modelId, run: null, ...(plans ? { plans } : {}) })).map((p) => ({ repo: p.facts.repo, number: p.facts.number, hash: p.facts.embedHash }));
  return (await mapSeq([...planned, ...diff], async (r) => await todoOf(db, r.repo, r.number, r.hash))).sort((a, b) => a.text.length - b.text.length);
}

/** Whether the embed step has work: open items the Plans send here, or closed ones with a missing or stale vector. */
export async function embedDue(db: Db, modelId: string, plans?: PlanSet): Promise<boolean> {
  if (plans ? plans.items.some((p) => p.plan.actions.some((a) => a.kind === "embed")) : (await plannedItems(db, "embed", { model: modelId, run: null })).length) return true;
  // Owner statements (src/memory/) are embedded by the same step.
  if (await statementsDue(db, modelId)) return true;
  return !!await db.prepare(`${DIFF_SQL} LIMIT 1`).get({ all: 0, model: modelId });
}

// Vectors of items that left the mirror or the tracked repos.
export async function prune(db: Db): Promise<number> {
  return Number((await db.prepare(`DELETE FROM main.item_embeddings WHERE repo NOT IN (SELECT name FROM main.tracked_repos)
    OR NOT EXISTS (SELECT 1 FROM main.items i WHERE i.repo = item_embeddings.repo AND i.number = item_embeddings.number)`).run()).changes);
}

export type Progress = { done: number; total: number; ms: number };

export async function embedItems(db: Db, embedder: Embedder,
  opts: { all?: boolean; batch?: number; onProgress?: (p: Progress) => void } = {}): Promise<{ embedded: number; pruned: number; ms: number }> {
  const start = performance.now();
  const pruned = await prune(db);
  await fillEmbedHashes(db);
  const todo = await pending(db, embedder.id, opts.all);
  const size = opts.batch ?? 32;
  const put = db.prepare(`INSERT OR REPLACE INTO main.item_embeddings (repo, number, model, hash, vec, at) VALUES (?,?,?,?,?,?)`);
  let done = 0;
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    const vecs = await embedder.embed(batch.map((t) => t.text), "item");
    const at = new Date().toISOString();
    await db.write(async () => {
      await forEachSeq(batch, async (t, k) => await put.run(t.repo, t.number, embedder.id, t.hash, toBlob(vecs[k]!), at));
    });
    done += batch.length;
    opts.onProgress?.({ done, total: todo.length, ms: performance.now() - start });
  }
  await embedStatements(db, embedder, size);
  return { embedded: done, pruned, ms: performance.now() - start };
}
