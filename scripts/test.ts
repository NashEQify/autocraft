// Runs the test suite: `pnpm test` on SQLite, `pnpm test:pg:suite` (scripts/pg-test.sh suite, which starts the server) on
// Postgres.
//
//   node scripts/test.ts [--concurrency N] [--slowest N] [test files...]
//
// Without files it runs every test/**/*.test.ts, the longest of the last run first, so the last ones to finish are short; on
// Postgres without those of test/no-database.txt. Over `node --test` it saves what every test process would do again: the
// migrated SQLite database that new ones are copies of is built once, and the compiled modules are kept in .test-cache.
// Prints the totals, the failures per file and the slowest files and tests; the spec output goes to a log file.
import { createWriteStream, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { parseArgs } from "node:util";
import { buildTemplate } from "../test/db-template.ts";
import { noDatabaseFiles } from "../test/no-database.ts";
import { report } from "./test-report.ts";

const ROOT = resolve(import.meta.dirname, "..");
process.chdir(ROOT);

const pg = !!process.env.AUTOCRAFT_TEST_PG_URL;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { concurrency: { type: "string" }, slowest: { type: "string" } },
});
const concurrency = Number(values.concurrency ?? process.env.AUTOCRAFT_TEST_CONCURRENCY ?? Math.max(1, availableParallelism() - 2));
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency needs a number of test files to run at once");
const slowest = Number(values.slowest ?? 15);

const CACHE = join(ROOT, ".test-cache");
mkdirSync(CACHE, { recursive: true });
const TIMES = join(CACHE, `times-${pg ? "postgres" : "sqlite"}.json`);

/** Seconds per file of the last runs on this backend. */
function lastTimes(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(TIMES, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

const times = lastTimes();
const listed = new Set(noDatabaseFiles());
const files = positionals.length
  ? positionals.map((f) => relative(ROOT, resolve(f)))
  : globSync("test/**/*.test.ts").filter((f) => !pg || !listed.has(f));
const left = !positionals.length && pg ? listed.size : 0;
// A file that has not been timed goes by its size: it may be long.
const weight = new Map(files.map((f) => [f, times[f] ?? statSync(f).size / 1000]));
files.sort((a, b) => weight.get(b)! - weight.get(a)!);

const scratch = join(homedir(), ".cache/autocraft-scratch");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "suite-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(1));

const template = join(dir, "template.db");
buildTemplate(template);
process.env.AUTOCRAFT_TEST_DB_TEMPLATE = template;
process.env.NODE_COMPILE_CACHE ??= join(CACHE, "compile");
const preload = `--import=${join(ROOT, "test/suite-preload.ts")}`;
// NODE_OPTIONS on Postgres: processes the tests spawn (the CLI, workers' children) redirect too.
if (pg) process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");

const log = join(mkdtempSync(join(tmpdir(), "autocraft-test-")), "spec.log");
console.error(`${files.length} test files on ${pg ? "Postgres" : "SQLite"}, ${concurrency} at once (load ${loadavg()[0]!.toFixed(0)} on ${availableParallelism()} CPUs)${left ? `, ${left} files without a database left to the SQLite suite` : ""}; spec output in ${log}`);

const events = run({ files, concurrency, execArgv: ["--no-warnings", ...(pg ? [] : [preload])] });
const fails = (): void => void (process.exitCode = 1);
events.on("test:fail", (d) => {
  if (d.todo === undefined || d.todo === false) fails();
});
events.compose(spec).pipe(createWriteStream(log));

const seconds: Record<string, number> = {};
let done = 0;
events.on("test:summary", (d) => {
  if (!d.file) return;
  seconds[relative(ROOT, d.file)] = d.duration_ms / 1000;
  if (++done % 25 === 0) console.error(`  ${done} of ${files.length} files done`);
});

for await (const text of events.compose(report(slowest))) process.stdout.write(text as string);
writeFileSync(TIMES, JSON.stringify({ ...times, ...seconds }, null, 1));
