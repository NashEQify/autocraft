// A node:test reporter for `pnpm test:pg:suite`: the totals, then each test file with failures, its failure count and
// first distinct error, sorted by file. With PG_SUITE_JSON set it also writes { totals, files } there as JSON.
import { writeFileSync } from "node:fs";
import { relative } from "node:path";

interface Ev {
  type: string;
  data: {
    name?: string;
    file?: string;
    skip?: unknown;
    todo?: unknown;
    details?: { type?: string; error?: { failureType?: string; message?: string; cause?: unknown } };
    message?: string;
    counts?: { tests: number; passed: number; failed: number; skipped: number; todo: number; cancelled: number };
  };
}

interface FileFails {
  fails: number;
  first?: string;
  firstTest?: string;
}

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find((l) => l) ?? "";

function message(err: NonNullable<NonNullable<Ev["data"]["details"]>["error"]>): string {
  const cause = err.cause as { message?: string; code?: string } | string | undefined;
  const m = typeof cause === "string" ? cause : cause?.message ?? err.message ?? "";
  const code = typeof cause === "object" && cause?.code && !String(cause.code).startsWith("ERR_ASSERTION") ? ` [${cause.code}]` : "";
  return (firstLine(m) + code).slice(0, 300);
}

export default async function* report(source: AsyncIterable<Ev>): AsyncGenerator<string> {
  const files = new Map<string, FileFails>();
  // A file whose process failed outside any test reports only "test failed"; its error is in the file's stderr.
  const stderrError = new Map<string, string>();
  let totals: Ev["data"]["counts"];
  for await (const ev of source) {
    const d = ev.data;
    if (ev.type === "test:summary" && !d.file && d.counts) totals = d.counts;
    const file = d.file ? relative(process.cwd(), d.file) : "(unknown file)";
    if (ev.type === "test:stderr" && !stderrError.has(file)) {
      const line = (d.message ?? "").split("\n").find((l) => /^(\w*Error\b|error:)/.test(l.trim()));
      if (line) stderrError.set(file, line.trim().slice(0, 300));
    }
    if (ev.type !== "test:fail") continue;
    const err = d.details?.error;
    // A parent whose subtests failed is not a failure of its own.
    if (err?.failureType === "subtestsFailed") continue;
    const f = files.get(file) ?? { fails: 0 };
    files.set(file, f);
    // A suite is not counted as a test, but its failing before/after hook is often the first real error.
    if (d.details?.type !== "suite") f.fails++;
    if (err && err.failureType !== "cancelledByParent" && f.first === undefined) {
      const m = message(err);
      f.first = m === "test failed" ? stderrError.get(file) ?? m : m;
      f.firstTest = d.name;
    }
  }
  for (const [file, f] of files) if (f.first === undefined || f.first === "test failed") f.first = stderrError.get(file) ?? f.first;
  const sorted = [...files].sort(([a], [b]) => a.localeCompare(b));
  const t = totals ?? { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
  yield `tests ${t.tests}  pass ${t.passed}  fail ${t.failed}  skipped ${t.skipped}  cancelled ${t.cancelled}\n`;
  if (sorted.length) yield `\nfailures by file (${sorted.length} files):\n`;
  for (const [file, f] of sorted) yield `${String(f.fails).padStart(5)}  ${file}${f.first ? `  -- ${f.first}` : ""}\n`;
  if (process.env.PG_SUITE_JSON) writeFileSync(process.env.PG_SUITE_JSON, JSON.stringify({ totals: t, files: Object.fromEntries(sorted) }, null, 1));
}
