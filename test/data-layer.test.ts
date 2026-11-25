import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOW_FILE, offenders, violation } from "../scripts/data-layer-allow.ts";

// Warn mode: files that still query the database outside src/data/ and src/db/ are listed in test/data-layer-allow.json
// (node scripts/data-layer-allow.ts --write). The list shrinks as modules move; it is empty when the data layer is done.
test("only files in the allow-list query the database outside src/data and src/db", () => {
  const allowed = new Set(JSON.parse(readFileSync(ALLOW_FILE, "utf8")) as string[]);
  const bad = offenders().filter((o) => !allowed.has(o.file)).map((o) => `${o.file}: ${o.why}`);
  assert.deepEqual(bad, []);
});

test("the scan flags query calls, SQL text and imports of query internals, and passes plain code", () => {
  assert.match(violation("src/x.ts", "db.k.selectFrom('t')") ?? "", /query call/);
  assert.match(violation("src/x.ts", "const q = sql`select 1`") ?? "", /SQL text/);
  assert.match(violation("src/x.ts", 'const q = "SELECT a FROM t"') ?? "", /SQL text/);
  assert.match(violation("src/x.ts", 'import { sql } from "kysely";') ?? "", /kysely/);
  assert.match(violation("src/x.ts", 'import * as kx from "./db/kx.ts";') ?? "", /kx\.ts/);
  assert.match(violation("src/x.ts", 'import { f } from "./data/mirror/fragments.ts";') ?? "", /fragments/);
  assert.equal(violation("src/x.ts", 'import { f } from "./data/mirror/index.ts";\nconst s = "select an item";'), null);
  assert.equal(violation("src/x.ts", 'import { v } from "./data/views/snapshot.ts";'), null);
});
