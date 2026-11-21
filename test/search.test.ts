import { test } from "node:test";
import assert from "node:assert/strict";
import { quickSearch } from "../src/dash/api/items.ts";
import { commentMatchSql, itemMatchSql, parseSearch, searchParam, snippetSql } from "../src/db/search.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";

test("text search finds items by a body word, a comment word and a typed prefix, and leaves out the rest", async () => {
  const db = await connectDb(":memory:");
  try {
    await db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('app', 1)").run();
    const item = db.prepare("INSERT INTO main.items (repo, number, kind, state, title, body, updated_at) VALUES ('app', ?, 'issue', 'OPEN', ?, ?, '2026-01-01')");
    await item.run(1, "Crash on start", "The exporter panics when the zebra layer is hidden.");
    await item.run(2, "Slow startup", "Loading takes a long time.");
    await item.run(3, "Layer order", "Layers swap after saving.");
    await item.run(4, "Zebra stripes in preview", "Rendering artefacts.");
    await db.prepare("INSERT INTO main.comments (repo, number, id, kind, author, body, created_at) VALUES ('app', 3, 'c1', 'comment', 'x', 'Same with the zebra layer here.', '2026-01-02')").run();
    const req = (q: string) => ({ query: new URLSearchParams(q), user: { role: "operator", login: "o", canRead: async () => true } }) as unknown as Req;

    // Item numbers matching `typed` in a title, body or comment, as the Items browser's hits.
    const find = async (typed: string): Promise<number[]> => {
      const q = searchParam(db, parseSearch(typed)!);
      const sql = `${itemMatchSql(db, ":q", { score: true })} UNION ALL ${commentMatchSql(db, ":q", "it.rowid", { join: "JOIN main.items it ON it.repo = c.repo AND it.number = c.number", score: 0.5 })}`;
      const rids = (await db.prepare(`SELECT DISTINCT i.number FROM (${sql}) AS h JOIN main.items i ON i.rowid = h.rid`).all({ q })).map((r) => Number(r.number));
      return rids.sort();
    };
    assert.deepEqual(await find("zebra"), [1, 3, 4]);
    assert.deepEqual(await find("zebra -preview"), [1, 3]);
    assert.deepEqual(await find("\"zebra layer\""), [1, 3]);
    assert.deepEqual(await find("stripes OR panics"), [1, 4]);
    const q = searchParam(db, parseSearch("zebra")!);
    const snip = await db.prepare(itemMatchSql(db, ":q", { cols: `${snippetSql(db, ":q", "body", "[", "]", 24)} AS b`, tail: "AND rowid = (SELECT rowid FROM main.items WHERE number = 1)" })).get({ q });
    assert.match(String(snip?.b), /\[zebra\]/, "the snippet marks the matched body word");
    // "zebr*" rather than "zebr": a bare word is also looked up as a login first.
    const typed = (await quickSearch(db, req("q=zebr*"))).map((h) => h.number);
    assert.ok(typed.includes(4) && typed.includes(1) && !typed.includes(2), `prefix search: ${typed}`);
    assert.equal(typed[0], 4, "a title match comes before body matches");
  } finally {
    await db.close();
  }
});
