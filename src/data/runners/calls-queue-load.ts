// The queue read behind `loadQueue` and the claim's wave B (not exported by index.ts).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import { indexedBy, inList, literal } from "../../db/kx.ts";
import type { ItemRef } from "../../../web/src/api/types.ts";
import { loadRunningCounts } from "../inference/index.ts";
import { cachedQueue, keepParsed, parsedOf, queueSignature, storeQueue, type Parsed } from "./calls-shared.ts";
import { loadItemAuthors } from "../mirror/authors.ts";
import { judges } from "./calls-shared.ts";
import type { QueuedCall, QueueSnapshot, Tier } from "./types.ts";

/** The count and newest id of the queued calls: the cache's signature. */
export async function loadQueueSignature(db: Db): Promise<string> {
  const q = queryDb(db);
  const r = (await q.get(q.k.selectFrom("main.remote_calls").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max<number | null>("id").as("m")]).where("state", "=", literal("queued"))))!;
  return queueSignature(Number(r.n), r.m === null ? null : Number(r.m));
}

/** The queue for a signature already read (`signature`; read here when not given): the cached one on a hit, else one wave of 3 statements. */
export async function loadQueueFor(db: Db, now: number, signature?: string): Promise<QueueSnapshot> {
  const sig = signature ?? await loadQueueSignature(db);
  const hit = cachedQueue(db, sig, now);
  if (hit) return hit;
  const q = queryDb(db);
  const known = parsedOf(db);
  const [queued, texts, running] = await db.together(async () => await Promise.all([
    q.all(q.k.selectFrom(indexedBy(db, "main.remote_calls", "remote_calls_waiting", "c")).select(["id", "class as cls", "level", "step", "repo", "since", "seen_at", "prompt_id", "prompt_version", "tier", "parent_id", "sticky_login",
      "released_by", "released_at", "picked_by", "picked_at", "pick_until", "asked_model", "queued_ms", "queued_since", "error", "job_id"]).where("state", "=", literal("queued"))),
    // The parts that never change, only for calls not parsed before.
    q.all(q.k.selectFrom("main.remote_calls").select(["id", "items", "authors", "for_login", "bound_slot", "timeout_ms", "refused_token"]).where("state", "=", literal("queued"))
      .where(inList(db, "id", [...known.keys()], "bigint", true))),
    loadRunningCounts(db, now),
  ]));
  const text = new Map(texts.map((t) => [Number(t.id), t]));
  // Calls queued before authors were stored on the row, in one more read.
  const unauthored = queued.filter((r) => !known.has(Number(r.id)) && text.get(Number(r.id))?.authors === null && judges(r.prompt_id));
  const legacy = unauthored.length ? await loadItemAuthors(db, unauthored.flatMap((r) => (JSON.parse(text.get(Number(r.id))!.items) as ItemRef[]).map((i) => ({ repo: i.repo, number: i.number })))) : new Map<string, string[]>();
  const seen = new Map<number, Parsed>();
  const calls = queued.map((r): QueuedCall => {
    const id = Number(r.id);
    let p = known.get(id);
    if (!p) {
      const x = text.get(id)!;
      const refs = JSON.parse(x.items) as ItemRef[];
      const authors = x.authors !== null ? JSON.parse(x.authors) as string[] : refs.flatMap((i) => legacy.get(`${i.repo}#${i.number}`) ?? []);
      p = { refs, repos: [...new Set([...refs.map((i) => i.repo), ...(r.repo ? [r.repo] : [])])], authors: new Set(authors), forLogin: x.for_login?.toLowerCase() ?? null, boundSlot: Number(x.bound_slot) === 1,
        refusedToken: x.refused_token == null ? null : Number(x.refused_token), timeoutMs: Number(x.timeout_ms) };
    }
    seen.set(id, p);
    return {
      id, promptId: r.prompt_id, promptVersion: r.prompt_version, tier: r.tier as Tier, step: r.step, parentId: r.parent_id, stickyLogin: r.sticky_login, seenAt: Number(r.seen_at),
      timeoutMs: p.timeoutMs, refs: p.refs, repos: p.repos, authors: p.authors, releasedBy: r.released_by?.toLowerCase() ?? null, releasedAt: r.released_at,
      forLogin: p.forLogin, boundSlot: p.boundSlot, refusedToken: p.refusedToken, pickedBy: r.picked_by?.toLowerCase() ?? null, pickedAt: r.picked_at, pickUntil: r.pick_until,
      askedModel: r.asked_model, queuedMs: Number(r.queued_ms), queuedSince: r.queued_since, error: r.error, level: Number(r.level), jobId: r.job_id, since: Number(r.since),
      cls: Number(r.cls), repo: r.repo,
    };
  });
  keepParsed(db, seen);
  const withFollowUps = [...calls.filter((c) => c.parentId !== null).sort((a, b) => a.since - b.since || a.id - b.id), ...calls.filter((c) => c.parentId === null).sort((a, b) => a.since - b.since || a.id - b.id)];
  const snapshot: QueueSnapshot = { signature: queueSignature(calls.length, calls.reduce<number | null>((m, c) => (m === null || c.id > m ? c.id : m), null)), calls: withFollowUps, running };
  storeQueue(db, snapshot, now);
  return snapshot;
}
