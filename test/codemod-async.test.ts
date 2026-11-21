import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "ts5";
import { runCodemod, type Report } from "../scripts/codemod-async.ts";

// Fixtures run in memory against a small stand-in for node:sqlite; the codemod matches the types by name and declaring file.
const ROOT = "/fx";
const SQLITE = `declare module "node:sqlite" {
  export class StatementSync { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number }; iterate(...a: unknown[]): IterableIterator<unknown>; }
  export class DatabaseSync { constructor(path: string); prepare(sql: string): StatementSync; exec(sql: string): void; close(): void; readonly isTransaction: boolean; }
}`;
const OPTS: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] };
const libCache = new Map<string, ts.SourceFile | undefined>();

export function codemod(files: Record<string, string>): { out: Record<string, string>; report: Report } {
  const all: Record<string, string> = { "types/sqlite.d.ts": SQLITE, ...files };
  const abs = (r: string) => `${ROOT}/${r}`;
  const makeProgram = (over: Map<string, string>) => {
    const host = ts.createCompilerHost(OPTS, true);
    const text = (f: string) => over.get(f) ?? (f.startsWith(ROOT + "/") ? all[f.slice(ROOT.length + 1)] : undefined);
    const base = host.getSourceFile.bind(host);
    host.getSourceFile = (f, lang) => {
      const t = text(f);
      if (t !== undefined) return ts.createSourceFile(f, t, lang, true);
      if (!libCache.has(f)) libCache.set(f, base(f, lang));
      return libCache.get(f);
    };
    const exists = host.fileExists.bind(host);
    host.fileExists = (f) => text(f) !== undefined || exists(f);
    const dirExists = host.directoryExists?.bind(host);
    host.directoryExists = (d) => d === ROOT || d.startsWith(ROOT + "/") || !!dirExists?.(d);
    host.realpath = (f) => f;
    const read = host.readFile.bind(host);
    host.readFile = (f) => text(f) ?? read(f);
    return ts.createProgram(Object.keys(all).map(abs), OPTS, host);
  };
  const { changed, report } = runCodemod(makeProgram, { rootDir: ROOT });
  const out: Record<string, string> = {};
  for (const [f, t] of changed) out[f.slice(ROOT.length + 1)] = t;
  return { out, report };
}

const FIXTURE: Record<string, string> = {
  "src/db.ts": `import { DatabaseSync } from "node:sqlite";
export function connect(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}
function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec("CREATE TABLE t (id, x)");
  db.exec("COMMIT");
}
`,
  "src/sql-cache.ts": `import type { DatabaseSync, StatementSync } from "node:sqlite";
export function prep(db: DatabaseSync, sql: string): StatementSync {
  return db.prepare(sql);
}
`,
  "src/a.ts": `import type { DatabaseSync } from "node:sqlite";
import { connect } from "./db.ts";
import { prep } from "./sql-cache.ts";

export function count(db: DatabaseSync): number {
  return (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
}

export function names(db: DatabaseSync, ids: number[]): string[] {
  return ids.map((id) => prep(db, "SELECT x FROM t WHERE id = ?").get(id) as string);
}

export function total(): number {
  const db = connect("x.db");
  if (db.isTransaction) return 0;
  return count(db);
}

export function save(db: DatabaseSync, id: number, x: string): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM t WHERE id = ?").run(id);
    db.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(id, x);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

export function snapshot<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

export function early(db: DatabaseSync, id: number): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM t WHERE id = ?").get(id)) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("DELETE FROM t WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

export function bump(db: DatabaseSync, id: number): void {
  const row = db.prepare("SELECT x FROM t WHERE id = ?").get(id) as { x: number };
  db.prepare("UPDATE t SET x = ? WHERE id = ?").run(row.x + 1, id);
}
`,
  "src/b.ts": `import type { DatabaseSync } from "node:sqlite";
import { count, snapshot } from "./a.ts";

type Loader = (db: DatabaseSync) => number;
const loaders: Record<string, Loader> = { rows: (db) => count(db), one: () => 1 };

export function load(db: DatabaseSync, k: string): number {
  return snapshot(db, () => loaders[k](db));
}

export function title(db: DatabaseSync, s: string): string {
  return s.replace(/#(\\d+)/g, (_m, n) => String(db.prepare("SELECT x FROM t WHERE id = ?").get(Number(n))));
}

export function lines(db: DatabaseSync): string[] {
  const out: string[] = [];
  for (const r of db.prepare("SELECT x FROM t").iterate() as Iterable<{ x: string }>) out.push(r.x);
  return out;
}

export class Store {
  constructor(readonly db: DatabaseSync) {}
  get size(): number {
    return count(this.db);
  }
}
`,
};

const { out, report } = codemod(FIXTURE);
const a = out["src/a.ts"], b = out["src/b.ts"];
const has = (text: string, ...lines: string[]) => { for (const l of lines) assert.ok(text.includes(l), `missing:\n${l}\nin:\n${text}`); };

test("database calls are awaited up the call graph across files, over the Db API", () => {
  has(a,
    `import type { Db } from "./db/index.ts";`,
    `export async function count(db: Db): Promise<number> {\n  return (await db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;`,
    `const db = await connectDb("x.db");\n  if (db.inTransaction()) return 0;\n  return await count(db);`,
    // An array callback that became async runs sequentially; prep(db, sql) is db.prepare(sql).
    `return await mapSeq(ids, async (id) => await db.prepare("SELECT x FROM t WHERE id = ?").get(id) as string);`);
  assert.ok(!a.includes("node:sqlite") && !a.includes("sql-cache") && !a.includes(`from "./db.ts"`));
  // A project function type takes the async-ness of one implementation, and so do the others assigned to it.
  has(b, `type Loader = (db: Db) => Promise<number>;`, `{ rows: async (db) => await count(db), one: async () => 1 }`,
    `return await snapshot(db, async () => await loaders[k](db));`);
  // connect() and what only it calls stay synchronous.
  assert.equal(out["src/db.ts"], undefined);
});

test("transaction blocks become db.write and db.read; other shapes are reported", () => {
  has(a,
    `await db.write(async () => {\n    await db.prepare("DELETE FROM t WHERE id = ?").run(id);\n    await db.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(id, x);\n  });\n  return true;`,
    `export async function snapshot<T>(db: Db, fn: () => Promise<T>): Promise<T> {\n  if (db.inTransaction()) return await fn();\n  return await db.read(async () => {\n    const out = await fn();\n    return out;\n  });`,
    `db.exec("BEGIN IMMEDIATE");\n  try {\n    if (!await db.prepare("SELECT 1 FROM t WHERE id = ?").get(id)) {\n      db.exec("ROLLBACK");`);
  assert.deepEqual(report.residue.filter((r) => r.kind === "transaction").map((r) => r.fn), ["early"]);
});

test("callbacks that cannot be async, accessors and iterate loops", () => {
  has(b, `for await (const r of db.prepare("SELECT x FROM t").iterate() as AsyncIterable<{ x: string }>) out.push(r.x);`);
  const kinds = report.residue.map((r) => `${r.kind} ${r.fn}`);
  assert.ok(kinds.includes("sync-callback title.replace-callback") && kinds.some((k) => k.startsWith("accessor Store.size")), kinds.join("\n"));
});

test("read-then-write outside a transaction is a candidate; inside db.write it is not", () => {
  const fns = Object.values(report.rmw).flat().map((r) => r.fn);
  assert.ok(fns.includes("bump") && !fns.includes("save"), fns.join(", "));
});

test("the output parses and a second run changes nothing", () => {
  for (const [f, t] of Object.entries(out)) {
    const sf = ts.createSourceFile(f, t, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.deepEqual((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length, 0, f);
  }
  assert.deepEqual(Object.keys(codemod({ ...FIXTURE, ...out }).out), []);
});
