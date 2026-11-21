// Owner memory: what the operators said once (a decision's answer note, a comment on GitHub, a message in an AutoCraft
// conversation) is kept as a statement with an embedding. Reviews of related work get the closest statements (retrieve.ts).
import type { Embedder } from "../embed/model.ts";
import { BODY_CHARS, cleanBody } from "../embed/text.ts";
import { toBlob } from "../embed/store.ts";
import { forEachSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export type StatementKind = "decision-note" | "comment" | "conversation";

/** Statements shorter than this ("LGTM", "thanks") say nothing worth remembering. */
export const STATEMENT_MIN_CHARS = 15;
export const STATEMENT_MAX_CHARS = 2000;

/**
 * Text that AutoCraft posted itself starts with the note line of src/github/note.ts (`_AI-generated ...` or `_Automated ...`),
 * also when an operator chose to post it. Bots are never operators; the login check covers an operator account used by automation.
 */
const ownPost = (db: Db, eb: kx.Eb) => eb.or([
  kx.like(db, "c.body", eb.val("\\_AI-generated%"), "\\"),
  kx.like(db, "c.body", eb.val("\\_Automated%"), "\\"),
  kx.like(db, "c.author", eb.val("%[bot]")),
]);

const tag = (eb: kx.Eb, value: string) => eb.cast<string>(eb.val(value), "text");

const textLength = (eb: kx.Eb, col: string) => eb.fn<number>("length", [eb.fn("trim", [col])]);

const newSources = (db: Db) => db.k.selectFrom("decisions as d")
  .innerJoin("access as a", (j) => j.onRef("a.login", "=", "d.answered_by").on("a.role", "=", "operator")
    .on((eb) => eb(eb.fn.coalesce("d.answered_role", eb.val("operator")), "=", "operator")))
  .select((eb) => [tag(eb, "decision-note").as("kind"), "d.id as sid", "d.repo", "d.number", eb.fn<string>("trim", ["d.answer_note"]).as("text"), "d.answered_by as author", "d.answered_at as at"])
  .where("d.repo", "is not", null).where("d.answer_note", "is not", null)
  .where((eb) => eb(textLength(eb, "d.answer_note"), ">=", STATEMENT_MIN_CHARS))
  .where("d.answer", "not in", ["withdrawn", "superseded", "handled"])
  .$narrowType<{ repo: string }>()
  .unionAll(db.k.selectFrom("comments as c")
    .innerJoin("access as a", (j) => j.onRef("a.login", "=", "c.author").on("a.role", "=", "operator"))
    .select((eb) => [tag(eb, "comment").as("kind"), "c.id as sid", "c.repo", "c.number", eb.fn<string>("trim", ["c.body"]).as("text"), "c.author", "c.created_at as at"])
    .where("c.kind", "in", ["comment", "review"])
    .where((eb) => eb.and([eb(textLength(eb, "c.body"), ">=", STATEMENT_MIN_CHARS), eb.not(ownPost(db, eb))])))
  .unionAll(db.k.selectFrom("conversation_turns as t")
    .innerJoin("access as a", (j) => j.onRef("a.login", "=", "t.login").on("a.role", "=", "operator"))
    .select((eb) => [tag(eb, "conversation").as("kind"), eb.cast<string>("t.id", "text").as("sid"), "t.repo", "t.number", eb.fn<string>("trim", ["t.body"]).as("text"), "t.login as author", "t.at"])
    .where("t.kind", "=", "operator")
    .where((eb) => eb.and([eb(eb.fn.coalesce("t.status", eb.val("")), "<>", "failed"), eb(textLength(eb, "t.body"), ">=", STATEMENT_MIN_CHARS)])));

/**
 * The database id of a GitHub comment from its GraphQL node id ("IC_kwDO…": base64url of a MessagePack array [0, repo id, comment id]);
 * null when the id has another shape.
 */
export function commentDatabaseId(node: string): string | null {
  const m = /^IC_(.+)$/.exec(node);
  if (!m) return null;
  const b = Buffer.from(m[1]!, "base64url");
  let at = 0;
  const num = (): bigint | null => {
    const t = b[at++];
    if (t === undefined) return null;
    if (t < 0x80) return BigInt(t);
    const size = t === 0xcc ? 1 : t === 0xcd ? 2 : t === 0xce ? 4 : t === 0xcf ? 8 : 0;
    if (!size || at + size > b.length) return null;
    let v = 0n;
    for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(b[at++]!);
    return v;
  };
  if (b[at++] !== 0x93 || num() !== 0n || num() === null) return null;
  const id = num();
  return id === null ? null : String(id);
}

/**
 * The comments and reviews AutoCraft wrote, from the audit rows of its GitHub writes: comment ids are the number after
 * `#issuecomment-` in a stored URL, review ids are the node id in `details.review`. Posts from before the note line existed
 * carry no prefix, and they come from the owner's account, so only the audit tells them apart.
 */
async function postedIds(db: Db): Promise<{ numbers: Set<string>; nodes: Set<string> }> {
  const numbers = new Set<string>(), nodes = new Set<string>();
  const rows = await db.all(db.k.selectFrom("audit").select("details")
    .where((eb) => eb.or([kx.like(db, "details", eb.val("%issuecomment-%")), kx.like(db, "details", eb.val('%"review"%'))])));
  for (const r of rows) {
    for (const m of (r.details ?? "").matchAll(/#issuecomment-(\d+)/g)) numbers.add(m[1]!);
    try { const v = (JSON.parse(r.details ?? "{}") as { review?: unknown }).review; if (typeof v === "string") nodes.add(v); } catch { /* not JSON: none */ }
  }
  return { numbers, nodes };
}

/** Adds the sources that have no statement yet; returns how many. Needs no model. */
export async function collectStatements(db: Db): Promise<number> {
  const rows = await db.all(db.k.selectFrom(newSources(db).as("s"))
    .select(["s.kind", "s.sid", "s.repo", "s.number", "s.text", "s.author", "s.at"])
    .where("s.at", "is not", null)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("owner_statements as o").select(eb.lit(1).as("one"))
      .whereRef("o.source_kind", "=", "s.kind").whereRef("o.source_id", "=", "s.sid"))))
    .$narrowType<{ author: string; at: string }>());
  const own = await postedIds(db);
  let n = 0;
  for (const r of rows) {
    if (r.kind === "comment") {
      const num = commentDatabaseId(r.sid);
      if (own.nodes.has(r.sid) || (num !== null && own.numbers.has(num))) continue;
    }
    const t = r.number === null ? undefined : (await db.get(db.k.selectFrom("items").select("title").where("repo", "=", r.repo).where("number", "=", r.number)))?.title;
    n += Number((await db.run(db.k.insertInto("owner_statements")
      .values({ source_kind: r.kind, source_id: r.sid, repo: r.repo, number: r.number, item_title: t ?? "", author: r.author, text: r.text.slice(0, STATEMENT_MAX_CHARS), at: r.at })
      .onConflict((oc) => oc.doNothing()))).changes);
  }
  return n;
}

/** What a statement is embedded from: the item's title, then what was said. */
export const statementText = (title: string, text: string): string => `${title.trim()}\n${cleanBody(text).slice(0, BODY_CHARS)}`.trim();

const waiting = (eb: kx.Eb, modelId: string) => eb.or([eb("embedding", "is", null), eb("model", "is distinct from", modelId)]);

/** Whether there are sources to collect or statements to embed with `modelId`. */
export async function statementsDue(db: Db, modelId: string): Promise<boolean> {
  await collectStatements(db);
  return !!await db.get(db.k.selectFrom("owner_statements").select("id").where((eb) => waiting(eb, modelId)).limit(1));
}

/** Collects new statements and embeds the ones without a vector of this model; returns how many were embedded. */
export async function embedStatements(db: Db, embedder: Embedder, batch = 32): Promise<number> {
  await collectStatements(db);
  const todo = await db.all(db.k.selectFrom("owner_statements").select(["id", "item_title", "text"]).where((eb) => waiting(eb, embedder.id)).orderBy("id"));
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const vecs = await embedder.embed(part.map((t) => statementText(t.item_title, t.text)), "item");
    await forEachSeq(part, async (t, k) => await db.run(db.k.updateTable("owner_statements").set({ embedding: toBlob(vecs[k]!), model: embedder.id }).where("id", "=", t.id)));
  }
  return todo.length;
}
