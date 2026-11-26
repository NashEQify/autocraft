// A command a person sends is a message in the item's chat (src/data/chat): stored before the command runs, linked to the workflow
// event the command wrote once it has. Every surface that sends commands goes through `saying`; GitHub stores the comment at intake
// and links it when its command ran (`linkComment`). Nothing here may stop a command: a failed write is logged and the command runs.
import { linkMessage, recordMessages } from "../data/chat/index.ts";
import type { ChatVia } from "../data/chat/index.ts";
import type { Db } from "../db/index.ts";
import { queryDb } from "../db/query-db.ts";
import type { ItemRef } from "./types.ts";

const shortName = (repo: string): string => repo.split("/").pop()!;

/** A stored message and the item it is on. */
export type Said = { id: number; repo: string; number: number };

export type SaidInput = { login: string; via: ChatVia; text: string; items: readonly ItemRef[]; payload?: unknown; githubCommentId?: number };

/** The id of the newest workflow event; events written after it are the command's. */
async function lastEventId(db: Db): Promise<number> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.workflow_events").select((eb) => eb.fn.max("id").as("m")));
  return Number(r?.m ?? 0);
}

/** Stores the text as one message on each item. Failures are logged, not thrown. */
export async function recordSaid(db: Db, o: SaidInput): Promise<Said[]> {
  const body = o.text.trim();
  if (!body || !o.items.length) return [];
  try {
    const refs = [...new Map(o.items.map((i) => [`${shortName(i.repo)}#${i.number}`, { repo: shortName(i.repo), number: i.number }])).values()];
    const rows = await recordMessages(db, refs.map((r) => ({
      repo: r.repo, number: r.number, author: o.login, via: o.via, kind: "said" as const, body,
      ...(o.payload !== undefined ? { payload: o.payload } : {}), ...(o.githubCommentId !== undefined ? { githubCommentId: o.githubCommentId } : {}),
    })));
    // Rows come back in input order, so row i is on item i.
    return refs.flatMap((r, i) => (rows[i] ? [{ id: rows[i]!.id, repo: r.repo, number: r.number }] : []));
  } catch (e) {
    console.error(`chat: message not stored: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return [];
  }
}

/** Links each message to the newest event the person wrote on its item through `via` after `after`. */
export async function linkSaid(db: Db, said: readonly Said[], o: { login: string; via: ChatVia; after: number }): Promise<void> {
  if (!said.length) return;
  try {
    const q = queryDb(db);
    for (const s of said) {
      const e = await q.get(q.k.selectFrom("main.workflow_events").select("id").where("repo", "=", s.repo).where("number", "=", s.number)
        .where("login", "=", o.login).where("via", "=", o.via as never).where("id", ">", o.after).orderBy("id", "desc").limit(1));
      if (e) await linkMessage(db, s.id, { workflowEventId: Number(e.id) });
    }
  } catch (err) {
    console.error(`chat: message not linked: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
}

/** Stores the text as a message on its items, runs the command and links the messages to the events it wrote. */
export async function saying<T>(db: Db, o: SaidInput, run: () => Promise<T>): Promise<T> {
  const after = await lastEventId(db).catch(() => 0);
  const said = await recordSaid(db, o);
  try {
    return await run();
  } finally {
    await linkSaid(db, said, { login: o.login, via: o.via, after });
  }
}

/** The stored message of a GitHub comment, or none. */
export async function saidByComment(db: Db, commentId: number): Promise<Said | null> {
  try {
    const q = queryDb(db);
    const m = await q.get(q.k.selectFrom("main.chat_messages as m").innerJoin("main.chat_conversations as c", "c.id", "m.conversation_id")
      .select(["m.id as id", "c.repo as repo", "c.number as number"]).where("m.github_comment_id", "=", commentId));
    return m && m.repo ? { id: Number(m.id), repo: m.repo, number: Number(m.number) } : null;
  } catch {
    return null;
  }
}

/** Runs a GitHub comment's command and links the comment's stored message to the event it wrote. */
export async function linkingComment<T>(db: Db, commentId: number, login: string, run: () => Promise<T>): Promise<T> {
  const after = await lastEventId(db).catch(() => 0);
  try {
    return await run();
  } finally {
    const m = await saidByComment(db, commentId);
    if (m) await linkSaid(db, [m], { login, via: "github", after });
  }
}
