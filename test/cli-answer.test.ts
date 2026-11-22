import assert from "node:assert/strict";
import { test } from "node:test";
import { answerAsSession, cardAsSession, setTestRepo } from "../src/decisions.ts";
import { connectDb } from "../src/db/open.ts";

test("a session answers only on test repos, as an operator, and the audit row says so", async () => {
  const db = await connectDb(":memory:");
  for (const r of ["sandbox", "real"]) await db.run(db.k.insertInto("tracked_repos").values({ name: r }));
  await db.run(db.k.insertInto("access").values([{ login: "op", role: "operator" }, { login: "viewer", role: "viewer" }]));
  const opts = JSON.stringify([{ key: "yes", label: "Yes" }, { key: "no", label: "No" }]);
  const ask = (id: string, repo: string) => db.run(db.k.insertInto("decisions").values({ id, kind: "scope", repo, number: 1, question: "Q?", options: opts, asked_at: new Date().toISOString() }));
  await ask("d-real", "real");
  await ask("d-box", "sandbox");

  await assert.rejects(answerAsSession(db, "d-real", "yes", "op"), /not marked as a test repo/);
  await setTestRepo(db, "cli", "sandbox", true);
  await assert.rejects(answerAsSession(db, "d-box", "yes", "viewer"), /not an operator/);
  await assert.rejects(answerAsSession(db, "d-box", "maybe", "op"), /option keys/);

  const d = await answerAsSession(db, "d-box", "yes", "op", "go");
  assert.equal(d.answer, "yes");
  assert.equal(d.answered_by, "op");
  const row = await db.prepare("SELECT login, details FROM audit WHERE action = 'answer' AND target = 'd-box'").get() as { login: string; details: string };
  assert.equal(row.login, "op");
  assert.deepEqual([JSON.parse(row.details).source, JSON.parse(row.details).via], ["cli", "session"]);
  await assert.rejects(answerAsSession(db, "d-box", "no", "op"), /already answered/);
});

test("a session runs a card only when every repo it writes to is a test repo", async () => {
  const db = await connectDb(":memory:");
  for (const r of ["sandbox", "real"]) await db.run(db.k.insertInto("tracked_repos").values({ name: r }));
  await db.run(db.k.insertInto("access").values([{ login: "op", role: "operator" }, { login: "viewer", role: "viewer" }]));
  await setTestRepo(db, "cli", "sandbox", true);
  const card = async (repo: string, params: unknown) =>
    (await db.get(db.k.insertInto("conversation_cards").values({ turn_id: 1, repo, number: 1, kind: "resolution", params: JSON.stringify(params), description: "d" }).returning("id")))!.id;
  const onReal = await card("real", { kind: "resolution", steps: [] });
  const toReal = await card("sandbox", { kind: "resolution", steps: [{ kind: "transfer", to: "real" }] });
  const local = await card("sandbox", { kind: "resolution", steps: [] });
  await assert.rejects(cardAsSession(db, onReal, "op"), /real is not marked as a test repo/);
  await assert.rejects(cardAsSession(db, toReal, "op"), /real is not marked as a test repo/);
  await assert.rejects(cardAsSession(db, local, "viewer"), /not an operator/);
});
