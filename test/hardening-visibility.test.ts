import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ask, getDecision } from "../src/decisions.ts";
import { toDecision } from "../src/dash/api/decisions.ts";
import { safeUrl } from "../web/src/ui/markdownHtml.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

test("a viewer's decision on a quiet pull request has no title, question or body", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "hardening-vis-")), "dash.db"));
  const now = new Date().toISOString();
  await db.run(db.k.insertInto("tracked_repos").values({ name: "open-app", pipeline: 1 }));
  await db.run(db.k.insertInto("repos").values({ name: "open-app", visibility: "public" }));
  await db.run(db.k.insertInto("main.items").values({ repo: "open-app", number: 2, kind: "pr", state: "OPEN", title: "Secret fix title", body: "secret body", head_oid: "h2", author: "autocraft", created_at: now, updated_at: now }));
  await db.run(db.k.insertInto("security_scans").values({ id: 901, repo: "open-app", state: "done", started_by: "boss", started_at: now }));
  await db.run(db.k.insertInto("security_findings").values({
    repo: "open-app", number: 901, scan_id: 901, area: "a", title: "t", severity: "high", urgent: 0, state: "landing", refs: "[]", reach: "r", impact: "i", fingerprint: "fp901", fix_pr: 2, created_at: now, updated_at: now,
  }));
  await ask(db, [{ id: "open-app#2:scope", kind: "scope", repo: "open-app", number: 2, question: "Secret question?", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], recommended: "a", summary: "s" }]);
  const row = (await getDecision(db, "open-app#2:scope"))!;
  const viewer = { login: "v", role: "viewer", operator: false, staff: false };
  const seen = await toDecision(db, row, viewer);
  assert.equal(seen.title, "");
  assert.equal(seen.question, "");
  assert.equal(seen.body, null);
  assert.equal(seen.shown?.title ?? null, null);
  assert.equal((await toDecision(db, row, { ...viewer, role: "operator", operator: true, staff: true })).title, "Secret fix title");
});

test("safeUrl keeps http(s), mailto, fragments and site paths, and drops script and protocol-relative urls", () => {
  for (const ok of ["https://example.com/a", "http://example.com", "mailto:a@b.c", "#top", "/path/x"]) assert.equal(safeUrl(ok), ok);
  for (const bad of ["javascript:alert(1)", "JaVaScript:alert(1)", "//evil.example", "/\\evil.example", "data:text/html,x", "vbscript:x", "relative/path", ""]) assert.equal(safeUrl(bad), "", bad);
});
