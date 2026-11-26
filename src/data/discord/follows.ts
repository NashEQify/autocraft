// What the bot's threads and command replies follow (`discord_follows`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { FollowRow, Ref } from "./types.ts";

const COLS = ["target_hash", "repo", "number", "kind", "channel_hash", "sealed", "command", "login", "at"] as const;
type Row = { target_hash: string; repo: string; number: number; kind: string; channel_hash: string; sealed: string; command: string; login: string; at: string };
const rowOf = (r: Row): FollowRow => ({
  targetHash: r.target_hash, repo: r.repo, number: Number(r.number), kind: r.kind === "reply" ? "reply" : "thread", channelHash: r.channel_hash,
  sealed: r.sealed, command: r.command, login: r.login, at: r.at,
});

/** The rows of each target; a target with no rows is absent. */
export async function loadFollows(db: Db, targetHashes: string[]): Promise<Map<string, FollowRow[]>> {
  const q = queryDb(db);
  const out = new Map<string, FollowRow[]>();
  for (const part of kx.chunks([...new Set(targetHashes)])) {
    for (const r of await q.all(q.k.selectFrom("main.discord_follows").select(COLS).where(kx.inList(db, "target_hash", part)), { label: "discord.loadFollows" })) {
      const f = rowOf(r);
      const list = out.get(f.targetHash);
      if (list) list.push(f); else out.set(f.targetHash, [f]);
    }
  }
  return out;
}

/** The rows that follow each item; an item nobody follows is absent. */
export async function loadFollowsOfItems(db: Db, refs: Ref[]): Promise<Map<Ref, FollowRow[]>> {
  const q = queryDb(db);
  const out = new Map<Ref, FollowRow[]>();
  if (!refs.length) return out;
  const rows = await q.all(q.k.selectFrom("main.discord_follows as f").select(COLS.map((c) => `f.${c}` as const)).where(kx.refIn(db, "f", refs)), { label: "discord.loadFollowsOfItems" });
  for (const r of rows) {
    const f = rowOf(r);
    const key = `${f.repo}#${f.number}`;
    const list = out.get(key);
    if (list) list.push(f); else out.set(key, [f]);
  }
  return out;
}

/** Upserts rows by (target, item): an item named again takes the newer command, sender and time. Rows older than `before` go. */
export async function saveFollows(db: Db, rows: FollowRow[], before: string): Promise<void> {
  const q = queryDb(db);
  const unique = [...new Map(rows.map((r) => [`${r.targetHash}\0${r.repo}\0${r.number}`, r])).values()];
  await db.write(async () => {
    await q.run(q.k.deleteFrom("main.discord_follows").where("at", "<", before));
    for (const part of kx.batches(unique)) {
      await q.run(q.k.insertInto("main.discord_follows").values(part.map((r) => ({
        target_hash: r.targetHash, repo: r.repo, number: r.number, kind: r.kind, channel_hash: r.channelHash, sealed: r.sealed, command: r.command, login: r.login, at: r.at,
      }))).onConflict((oc) => oc.columns(["target_hash", "repo", "number"]).doUpdateSet(kx.excluded(["kind", "channel_hash", "sealed", "command", "login", "at"]))));
    }
  });
}

/** Deletes the rows of targets, or of the channels they were sent in. */
export async function removeFollows(db: Db, hashes: string[]): Promise<number> {
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks([...new Set(hashes)])) {
    n += Number((await q.run(q.k.deleteFrom("main.discord_follows").where((eb) => eb.or([kx.inList(db, "target_hash", part), kx.inList(db, "channel_hash", part)])))).changes);
  }
  return n;
}

/** Every row's target and seal, for the deletion request by user id (the sender is sealed in the row); read on its own, never fused. */
export async function loadSealedFollows(db: Db): Promise<{ targetHash: string; sealed: string }[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_follows").select(["target_hash", "sealed"]), { alone: true, label: "discord.loadSealedFollows" });
  return rows.map((r) => ({ targetHash: r.target_hash, sealed: r.sealed }));
}

/** Deletes rows by (target, seal). */
export async function removeSealedFollows(db: Db, rows: { targetHash: string; sealed: string }[]): Promise<number> {
  const q = queryDb(db);
  let n = 0;
  for (const part of kx.chunks(rows.map((r): [string, string] => [r.targetHash, r.sealed]))) {
    n += Number((await q.run(q.k.deleteFrom("main.discord_follows").where(kx.tupleIn(db, ["target_hash", "sealed"], part, ["text", "text"])))).changes);
  }
  return n;
}
