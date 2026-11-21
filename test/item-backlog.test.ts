import assert from "node:assert/strict";
import { test } from "node:test";
import { backlogItemRoute, listDecisions, openCounts, reopen } from "../src/dash/api/decisions.ts";
import { backlogHeld } from "../src/dupes/held.ts";
import { prepareIds } from "../src/decide/prepare.ts";
import { getDecision } from "../src/decisions.ts";
import type { Req } from "../src/dash/types.ts";
import { connectDb } from "../src/db/open.ts";

const as = (login: string, role: "viewer" | "maintainer" | "operator", params: Record<string, string> = {}, query: Record<string, string> = {}): Req => ({
  method: "POST", path: "", params, query: new URLSearchParams(query), form: new URLSearchParams(),
  user: { login, role, canWrite: async () => true, canRead: async () => true }, csrf: "", nonce: "",
});

test("Backlog on an item: answers its open question, or holds it with an answered backlog decision that Reopen deletes", async () => {
  const db = await connectDb(":memory:");
  await db.prepare("INSERT INTO tracked_repos (name) VALUES ('alpha')").run();
  await db.prepare("INSERT INTO repos (name, visibility) VALUES ('alpha', 'public')").run();
  await db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator'), ('maint', 'maintainer')").run();
  for (const n of [1, 2]) await db.prepare("INSERT INTO items (repo, number, kind, state, title) VALUES ('alpha', ?, 'issue', 'OPEN', ?)").run(n, `Title ${n}`);
  await db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES ('alpha#2:scope', 'scope', 'alpha', 2, 'In scope?', '[{"key":"take","label":"Take"}]', ?)`).run(new Date().toISOString());
  const list = async (status: string) => (await listDecisions(db, { ...as("op", "operator"), method: "GET", query: new URLSearchParams({ status, all: "1" }) })).decisions.map((d) => d.id);

  await assert.rejects(backlogItemRoute(db, as("maint", "maintainer", { repo: "alpha", n: "1" })), { status: 403 }, "a maintainer settles only while maintainer_writes is on");

  // No open question: a backlog decision, answered at once.
  const d = await backlogItemRoute(db, as("op", "operator", { repo: "alpha", n: "1" }));
  assert.equal(d.kind, "backlog");
  assert.equal(d.answer, "backlog");
  assert.ok(await backlogHeld(db, "alpha", 1));
  assert.ok((await list("backlog")).includes(d.id));
  assert.ok(!(await list("open")).includes(d.id) && !(await list("answered")).includes(d.id));
  assert.ok(!(await prepareIds(db)).includes(d.id));
  await assert.rejects(backlogItemRoute(db, as("op", "operator", { repo: "alpha", n: "1" })), { status: 409 });

  // An open question: it is answered Backlog, no second decision.
  assert.equal((await openCounts(db, as("op", "operator"))).total, 1);
  const s = await backlogItemRoute(db, as("op", "operator", { repo: "alpha", n: "2" }));
  assert.equal(s.id, "alpha#2:scope");
  assert.equal(s.answer, "backlog");
  assert.equal((await openCounts(db, as("op", "operator"))).total, 0);

  // Reopen deletes the backlog decision, so the item is back in the pipeline as if never held.
  assert.equal(await reopen(db, as("op", "operator", { id: d.id })), null);
  assert.equal(await getDecision(db, d.id), undefined);
  assert.ok(!await backlogHeld(db, "alpha", 1));
  assert.ok(!(await list("backlog")).includes(d.id));
});
