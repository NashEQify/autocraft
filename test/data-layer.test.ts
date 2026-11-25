import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Queries live in the data modules (src/data/**) and in infrastructure (src/db/**, src/db.ts): feature code holds a `Db`,
// which has no query methods, and this scan keeps the ways around the type out of it.

const ROOT = new URL("..", import.meta.url).pathname;

/** src/db.ts holds the SQLite migrations: infrastructure, like src/db/. */
const INFRA = ["src/data/", "src/db/", "src/db.ts"];

/** Files the scan passes over, each with the reason. */
const EXCEPTIONS: Record<string, string> = {
  "src/itemtools/server/tools.ts": "reads the item snapshot file in the sandbox with node built-ins only: no Db and no Kysely there",
  "src/dash/api/related.ts": "the item page's relations, moving into the data modules",
  "src/build/tasks.ts": "build task rows, moving into the data modules",
};

const QUERY_CALLS = /\b(?:selectFrom|selectNoFrom|insertInto|updateTable|deleteFrom|replaceInto|mergeInto|queryDb)\(|\.prepare\(|\.script\(|\bdb\.k\b|\.k\./;
const SQL_TEXT = /\bsql(?:<(?:[^<>\n]|<(?:[^<>\n]|<[^<>\n]*>)*>)*>)?`|\bsql\.(?:raw|ref)\b|["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\s+[A-Za-z_*(]/;
const FROM = /(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;
const INFRA_FILES = new Set(["src/db/kx.ts", "src/db/sql.ts", "src/db/portable.ts", "src/db/query-db.ts", "src/db/search.ts", "src/db/types.ts"]);
const MODULE_PUBLIC = new Set(["index.ts", "types.ts"]);

/** Why `text` of the file `file` (a path from the repo root) breaks the boundary, or null. */
function violation(file: string, text: string): string | null {
  const call = QUERY_CALLS.exec(text);
  if (call) return `query call ${call[0]}`;
  const lit = SQL_TEXT.exec(text);
  if (lit) return `SQL text ${lit[0]}`;
  for (const m of text.matchAll(FROM)) {
    const spec = m[1];
    if (spec === "kysely") return "imports kysely";
    if (!spec.startsWith(".")) continue;
    const target = relative(ROOT, resolve(ROOT, dirname(file), spec));
    if (INFRA_FILES.has(target)) return `imports ${target}`;
    const mod = /^src\/data\/([^/]+)\/(.+)$/.exec(target);
    if (mod && mod[1] !== "views" && !MODULE_PUBLIC.has(mod[2])) return `imports ${target}`;
  }
  return null;
}

test("nothing outside src/data and src/db queries the database, and no exception is out of date", () => {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        const file = relative(ROOT, p);
        if (INFRA.some((i) => file === i || file.startsWith(i))) continue;
        const why = violation(file, readFileSync(p, "utf8"));
        if (why) found.set(file, why);
      }
    }
  };
  walk(join(ROOT, "src"));
  assert.deepEqual([...found].filter(([f]) => !(f in EXCEPTIONS)).map(([f, why]) => `${f}: ${why}`), []);
  assert.deepEqual(Object.keys(EXCEPTIONS).filter((f) => !found.has(f)), [], "exceptions that are not needed");
});

test("the scan flags query calls, SQL text and imports of query internals, and passes plain code", () => {
  assert.match(violation("src/x.ts", "db.k.selectFrom('t')") ?? "", /query call/);
  assert.match(violation("src/x.ts", "const q = sql`select 1`") ?? "", /SQL text/);
  assert.match(violation("src/x.ts", 'const q = "SELECT a FROM t"') ?? "", /SQL text/);
  assert.match(violation("src/x.ts", 'import { sql } from "kysely";') ?? "", /kysely/);
  assert.match(violation("src/x.ts", 'import * as kx from "./db/kx.ts";') ?? "", /kx\.ts/);
  assert.match(violation("src/x.ts", 'import type { QueryDb } from "./db/query-db.ts";') ?? "", /query-db\.ts/);
  assert.match(violation("src/x.ts", 'import { f } from "./data/mirror/fragments.ts";') ?? "", /fragments/);
  assert.equal(violation("src/x.ts", 'import { f } from "./data/mirror/index.ts";\nconst s = "select an item";'), null);
  assert.equal(violation("src/x.ts", 'import { v } from "./data/views/snapshot.ts";'), null);
});
