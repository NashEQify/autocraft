// reads: mirror.items, control.tracked_repos
// loadTriageFacts reads `items.embed_hash` for its per-item row; listEmbedDiff and pruneEmbeddings join the mirror and the tracked repos;
// the duplicate edge read joins pairs to items on the checked hashes.
export {};
