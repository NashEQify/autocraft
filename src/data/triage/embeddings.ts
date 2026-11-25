// Item embeddings (blobs; loaders marked `alone`) (M09 triage-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { EmbedDiffRow, EmbeddingMark, EmbeddingPut, RefKey, StreamedEmbedding } from "./types.ts";

/** Stored vector hash per item. */
export async function loadEmbeddingHashes(db: Db, keys: KeySource, model: string): Promise<Map<RefKey, string>> {
  throw new Error("not built: triage.loadEmbeddingHashes");
}

/** Tracked items whose vector is missing, from another model or at another hash (closed items); every tracked item with `all`. */
export async function listEmbedDiff(db: Db, model: string, all: boolean): Promise<EmbedDiffRow[]> {
  throw new Error("not built: triage.listEmbedDiff");
}

/** `LIMIT 1` probe for `embedDue`. */
export async function hasEmbedDiff(db: Db, model: string): Promise<boolean> {
  throw new Error("not built: triage.hasEmbedDiff");
}

/** `kx.replaceRows`, one statement per 500 rows; the embed loop commits per batch of 32. */
export async function saveEmbeddings(db: Db, rows: EmbeddingPut[]): Promise<void> {
  throw new Error("not built: triage.saveEmbeddings");
}

/** Deletes rows of untracked repos or items not in the mirror. */
export async function pruneEmbeddings(db: Db): Promise<number> {
  throw new Error("not built: triage.pruneEmbeddings");
}

/** Vectors by item. Marked `alone`. */
export async function loadEmbeddingVectors(db: Db, keys: KeySource, model?: string): Promise<Map<RefKey, { model: string; vec: Uint8Array }>> {
  throw new Error("not built: triage.loadEmbeddingVectors");
}

/** Row count, max rowid and tracked set for `VectorIndex.check`. */
export async function embeddingIndexMark(db: Db): Promise<EmbeddingMark> {
  throw new Error("not built: triage.embeddingIndexMark");
}

/** One page of up to 1,000 vectors; a metered stream, skipped by the query-growth check. Marked `alone`. */
export async function streamEmbeddings(db: Db, model: string, after: number, limit: number): Promise<StreamedEmbedding[]> {
  throw new Error("not built: triage.streamEmbeddings");
}
