// reads: mirror.items, control.tracked_repos
// loadTriageFacts reads `items.embed_hash` for its per-item row; listEmbedDiff and pruneEmbeddings join the mirror and the tracked repos;
// the duplicate edge read joins pairs to items on the checked hashes.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { resolveKeys, type KeySource } from "../keys.ts";

/** The per-item triage row of `loadTriageFacts`. A stored hash equal to the item's `embed_hash` comes back as '' (the common case sends no copy). */
export type ItemFactRow = {
  repo: string; number: number; embed_hash: string | null; score: number | null; impact: string | null;
  pr_hash: string | null; e_hash: string | null; scan_hash: string | null; jev_failed: string | null;
};

const sameAsText = (eb: kx.AnyEb, col: string) => eb.case().when(eb.ref(col), "=", eb.ref("i.embed_hash")).then(eb.val("")).else(eb.ref(col)).end();

/** Rank score, priority impact and hash, embedding hash for `model`, scan hash and Jev-failed hash of each tracked item of `keys`: one statement. */
export async function loadItemFactRows(db: Db, keys: KeySource, model: string): Promise<ItemFactRow[]> {
  if (Array.isArray(keys) && keys.length === 0) return [];
  const q = queryDb(db);
  return await q.all(q.k.selectFrom(resolveKeys(db, keys, "kk"))
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "kk.repo").onRef("i.number", "=", "kk.number"))
    .innerJoin("main.tracked_repos as t", "t.name", "i.repo")
    .leftJoin("main.item_rank as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
    .leftJoin("main.item_priority as p", (j) => j.onRef("p.repo", "=", "i.repo").onRef("p.number", "=", "i.number"))
    .leftJoin("main.item_embeddings as e", (j) => j.onRef("e.repo", "=", "i.repo").onRef("e.number", "=", "i.number").on("e.model", "=", model))
    .leftJoin("main.duplicate_scans as s", (j) => j.onRef("s.repo", "=", "i.repo").onRef("s.number", "=", "i.number"))
    .leftJoin("main.classify_state as c", (j) => j.onRef("c.repo", "=", "i.repo").onRef("c.number", "=", "i.number").on("c.kind", "=", "jev_failed"))
    .select((eb) => ["i.repo", "i.number", "i.embed_hash", "r.score", "p.impact", sameAsText(eb, "p.text_hash").as("pr_hash"), sameAsText(eb, "e.hash").as("e_hash"),
      sameAsText(eb, "s.hash").as("scan_hash"), "c.value as jev_failed"])
    .orderBy("i.repo").orderBy("i.number"), { label: "triage.loadItemFactRows" }) as ItemFactRow[];
}
