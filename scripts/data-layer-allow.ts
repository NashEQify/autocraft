// The data-layer boundary scan (test/data-layer.test.ts) and the list of files that still break it.
//
//   node scripts/data-layer-allow.ts           prints the files that query the database outside src/data/ and src/db/
//   node scripts/data-layer-allow.ts --write   writes them, sorted, to test/data-layer-allow.json
//
// Run with --write after files move into src/data/; the list must be empty when the data layer is finished.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
export const ALLOW_FILE = join(ROOT, "test/data-layer-allow.json");

/** src/db.ts holds the SQLite migrations: infrastructure, like src/db/. */
const INFRA = ["src/data/", "src/db/", "src/db.ts"];

const QUERY_CALLS = /\b(?:selectFrom|selectNoFrom|insertInto|updateTable|deleteFrom|replaceInto|mergeInto|queryDb)\(|\.prepare\(|\.script\(|\bdb\.k\b|\.k\./;
const SQL_TEXT = /\bsql(?:<(?:[^<>\n]|<(?:[^<>\n]|<[^<>\n]*>)*>)*>)?`|\bsql\.(?:raw|ref)\b|["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\s+[A-Za-z_*(]/;
const FROM = /(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;
const INFRA_FILES = new Set(["src/db/kx.ts", "src/db/sql.ts", "src/db/portable.ts", "src/db/search.ts", "src/db/types.ts"]);
const MODULE_PUBLIC = new Set(["index.ts", "types.ts"]);

/** Why `text` of the file `file` (a path from the repo root) breaks the boundary, or null. */
export function violation(file: string, text: string): string | null {
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

/** Every .ts file under src/ outside src/data/ and src/db/ that breaks the boundary, with the reason, sorted. */
export function offenders(): { file: string; why: string }[] {
  const out: { file: string; why: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        const file = relative(ROOT, p);
        if (INFRA.some((i) => file === i || file.startsWith(i))) continue;
        const why = violation(file, readFileSync(p, "utf8"));
        if (why) out.push({ file, why });
      }
    }
  };
  walk(join(ROOT, "src"));
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

if (import.meta.main) {
  const files = offenders().map((o) => o.file);
  if (process.argv.includes("--write")) {
    writeFileSync(ALLOW_FILE, `${JSON.stringify(files, null, 2)}\n`);
    console.log(`${files.length} files written to ${relative(ROOT, ALLOW_FILE)}`);
  } else console.log(files.join("\n"));
}
