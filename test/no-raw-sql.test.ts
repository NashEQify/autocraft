// App code builds queries with Kysely (db.k) and src/db/kx.ts, so SQLite tests prove the Postgres code path too. Raw SQL
// (`.prepare(`, `.script(`, the `sql` tag) is allowed only in scripts/raw-sql.ts PERMANENT and in the files listed in
// test/raw-sql-not-converted.txt, a list that only shrinks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notYetConverted, rawSqlFiles } from "../scripts/raw-sql.ts";

test("raw SQL appears only in the permanent files and the files not yet converted, and the list only shrinks", () => {
  const found = rawSqlFiles();
  const listed = new Set(notYetConverted());
  const unlisted = [...found].filter(([f]) => !listed.has(f)).map(([f, lines]) => `${f}:${lines.join(",")}`);
  assert.deepEqual(unlisted, [], "raw SQL outside src/db/: build these queries with db.k and src/db/kx.ts (docs in src/db/kx.ts)");
  const done = [...listed].filter((f) => !found.has(f));
  assert.deepEqual(done, [], "no raw SQL left in these files: delete their lines from test/raw-sql-not-converted.txt");
});
