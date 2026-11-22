import assert from "node:assert/strict";
import { test } from "node:test";
import { listDecisions } from "../src/dash/api/decisions.ts";
import { needs } from "../src/dash/api/needs.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";

const as = (login: string, role: "viewer" | "maintainer" | "operator", query: Record<string, string> = {}): Req => ({
  method: "GET", path: "", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(),
  user: { login, role, canWrite: async () => true, canRead: async () => true }, csrf: "", nonce: "",
});

test("the open list runs by priority level, unclaimed before claimed, then age, in stable pages; a person sees what they can settle", async () => {
  const db = await connectDb(":memory:");
  const now = Date.now();
  const at = (h: number) => new Date(now - h * 3600_000).toISOString();
  for (const repo of ["alpha", "beta"]) {
    await db.run(db.k.insertInto("tracked_repos").values({ name: repo }));
    await db.run(db.k.insertInto("repos").values({ name: repo, visibility: "public" }));
  }
  // alpha#1 is the oldest and claimed by someone else; alpha#2 and alpha#3 share its level; alpha#4 is a P0 and the newest; beta#5 is the maintainer's no-go.
  const rows: [string, string, number, number][] = [["d1", "alpha", 1, 50], ["d2", "alpha", 2, 40], ["d3", "alpha", 3, 30], ["d4", "alpha", 4, 1], ["d5", "beta", 5, 45]];
  for (const [id, repo, n, h] of rows) {
    await db.run(db.k.insertInto("items").values({ repo, number: n, kind: "issue", state: "OPEN", title: `Title ${n}` }));
    await db.run(db.k.insertInto("decisions").values({ id, kind: "other", repo, number: n, question: "Q?", options: "[]", asked_at: at(h) }));
  }
  await db.run(db.k.insertInto("item_rank").values({ repo: "alpha", number: 4, score: 40123, breakdown: "{}", computed_at: at(0) }));
  await db.run(db.k.insertInto("decision_claims").values({ decision_id: "d1", login: "other", since: at(0), at: at(0) }));

  const page = async (req: Req) => {
    const ids: string[] = [];
    for (let after: string | null = null, i = 0; i < 10; i++) {
      const q = new URLSearchParams(req.query);
      q.set("limit", "2");
      if (after) q.set("after", after);
      const l = await listDecisions(db, { ...req, query: q });
      ids.push(...l.decisions.map((d) => d.id));
      if (!(after = l.next)) break;
    }
    return ids;
  };
  assert.deepEqual(await page(as("op", "operator")), ["d4", "d5", "d2", "d3", "d1"], "P0 first, then the oldest unclaimed of the default level, the claimed one after them");
  assert.equal((await listDecisions(db, as("op", "operator"))).decisions.find((d) => d.id === "d1")!.claim?.login, "other");

  // A maintainer settles on alpha only: write permission there, and the app acts for them.
  await db.run(db.k.insertInto("access").values({ login: "maint", role: "maintainer" }));
  await db.run(db.k.insertInto("settings").values([{ key: "maintainer_writes", value: "1" }, { key: "github_identity", value: "app" }]));
  await db.run(db.k.insertInto("repo_permissions").values({ login: "maint", repo: "alpha", permission: "write", checked_at: new Date().toISOString() }));
  assert.deepEqual(await page(as("maint", "maintainer")), ["d4", "d2", "d3", "d1"]);
  assert.deepEqual(await page(as("maint", "maintainer", { all: "1" })), ["d4", "d5", "d2", "d3", "d1"], "the toggle shows everything");
  assert.equal((await needs(db, as("maint", "maintainer"))).counts.decisions, 4, "the badge counts the same list");
  assert.equal((await needs(db, as("op", "operator"))).counts.decisions, 5);

  assert.deepEqual(await page(as("viewer", "viewer")), ["d4", "d5", "d2", "d3", "d1"], "a viewer reads everything they may see");
  assert.equal((await needs(db, as("viewer", "viewer"))).counts.decisions, 5);
});
