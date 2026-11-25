// Times the dashboard API routes behind the main pages on a Postgres database with synthetic data, through the latency
// proxy, and counts their round trips (src/db/counter.ts). Dev only; it never reads a real database.
//
//   node --no-warnings scripts/page-bench.ts <postgres admin url> [--delay MS] [--runs N] [--only SUBSTR] [--sites N] [--dump DIR] [--sql]
//
// Creates a database of its own on the server, seeds it, prints one line per route (median ms, round trips, rows) and,
// with --sites, the N call sites with the most round trips per route, with --sql the statements of its last run (the
// first 160 characters, counted); --dump DIR writes each answer to DIR. Drops the database at the end.
// `scripts/pg-test.sh start` gives a throwaway server.
import { randomBytes } from "node:crypto";
import { apiRoutes } from "../src/dash/api/index.ts";
import type { Req } from "../src/dash/types.ts";
import { countQueries } from "../src/db/counter.ts";
import type { Db } from "../src/db/index.ts";
import * as kx from "../src/db/kx.ts";
import { connectDb } from "../src/db/open.ts";
import { readSettingsSnapshot, withSettingsSnapshot } from "../src/settings-read.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startLatencyProxy } from "./latency-proxy.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const admin = args.find((a) => /^postgres(ql)?:\/\//.test(a));
if (!admin) {
  console.error("usage: page-bench.ts <postgres admin url> [--delay MS] [--runs N] [--only SUBSTR] [--sites N]");
  process.exit(2);
}
const delayMs = Number(flag("--delay", "10"));
const runs = Number(flag("--runs", "5"));
const only = flag("--only", "");
const sites = Number(flag("--sites", "0"));
const dump = flag("--dump", "");
const statements = args.includes("--sql");

const REPOS = 20, ITEMS = 300, COMMENTS = 4;
// Times count back from the start of the current hour, so two runs within an hour seed the same rows and --dump outputs compare.
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const iso = (minAgo: number) => new Date(BASE - minAgo * 60_000).toISOString();

async function insertAll(db: Db, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (const b of kx.batches(rows)) await db.run((db.k as any).insertInto(table).values(b));
}

async function seed(db: Db): Promise<void> {
  const repos = Array.from({ length: REPOS }, (_, i) => `repo${i}`);
  await insertAll(db, "repos", repos.map((name, i) => ({ name, visibility: i % 5 === 4 ? "private" : "public" })));
  await insertAll(db, "tracked_repos", repos.map((name, i) => ({ name, pipeline: i % 2 })));
  await insertAll(db, "access", [{ login: "op", role: "operator" }, { login: "mt", role: "maintainer" }]);
  const items: Record<string, unknown>[] = [], comments: Record<string, unknown>[] = [], stages: Record<string, unknown>[] = [];
  const checks: Record<string, unknown>[] = [], files: Record<string, unknown>[] = [], classes: Record<string, unknown>[] = [];
  for (const repo of repos) {
    for (let n = 1; n <= ITEMS; n++) {
      const pr = n % 5 !== 0, open = n % 3 !== 0, age = n * 37;
      items.push({
        repo, number: n, kind: pr ? "pr" : "issue", state: open ? "OPEN" : pr ? "MERGED" : "CLOSED", title: `Item ${n} of ${repo}`,
        body: "Body text ".repeat(20), author: `dev${n % 17}`, created_at: iso(age + 600), updated_at: iso(age), labels: JSON.stringify(n % 4 ? ["bug"] : []),
        ...(pr ? { head_oid: `h${n}`, base_ref: "main", ci_state: n % 7 ? "SUCCESS" : "FAILURE", mergeable: "MERGEABLE", additions: n, deletions: n % 13, changed_files: 3 } : {}),
      });
      for (let c = 0; c < COMMENTS; c++) comments.push({ repo, number: n, id: `${repo}-${n}-${c}`, author: `dev${(n + c) % 17}`, created_at: iso(age - c), body: "A comment ".repeat(15), kind: c === 3 && pr ? "review" : "comment", review_state: c === 3 && pr ? "COMMENTED" : null });
      for (const [k, stage] of ["synced", "classified", "reviewed"].entries()) stages.push({ repo, number: n, stage, at: iso(age - k), actor: "pipeline", note: "note" });
      classes.push({ repo, number: n, classifier: "type", run_id: `r${n}`, at: iso(age), type_label: pr ? "bug" : "feature", flags: "[]" });
      if (pr) {
        checks.push({ repo, number: n, head_oid: `h${n}`, overall: n % 7 ? "SUCCESS" : "FAILURE", checks: JSON.stringify([{ name: "build", state: "SUCCESS" }, { name: "test", state: n % 7 ? "SUCCESS" : "FAILURE" }]), fetched_at: iso(age) });
        for (let f = 0; f < 3; f++) files.push({ repo, number: n, head: `h${n}`, path: `src/file${f}.rs`, additions: f + 1, deletions: f, change_type: "MODIFIED" });
      }
    }
  }
  await insertAll(db, "items", items);
  await insertAll(db, "comments", comments);
  await insertAll(db, "stages", stages);
  await insertAll(db, "classifications", classes);
  await insertAll(db, "pr_checks", checks);
  await insertAll(db, "pr_files", files);
  const workflows: Record<string, unknown>[] = [];
  for (let i = 0; i < Math.min(300, REPOS * ITEMS); i++) {
    const repo = repos[i % REPOS]!, number = Math.floor(i / REPOS) + 1;
    const pr = number % 5 !== 0, rec = i % 3 !== 0;
    workflows.push({ repo, number, kind: pr ? "pr" : "issue", entry: pr ? "review" : "implement", state: rec ? "recommending" : "running", started_by: "op", started_at: iso(i * 11 + 5), started_via: "dashboard",
      rec: rec ? JSON.stringify({ text: "Looks right.", parts: { fix: [], drop: [] }, merges: pr }) : null, rec_at: rec ? iso(i * 11) : null, updated_at: iso(i * 11) });
  }
  await insertAll(db, "item_workflows", workflows);
  const jobs: Record<string, unknown>[] = [];
  for (let i = 0; i < 2000; i++) {
    const running = i < 8;
    jobs.push({ step: ["opus-review", "classify", "fixup", "sync"][i % 4], params: "{}", requested_by: "pipeline", requested_at: iso(i * 3 + 1), state: running ? "running" : i % 9 ? "done" : "failed",
      started_at: iso(i * 3 + 1), ended_at: running ? null : iso(i * 3), repo: repos[i % REPOS], progress: running ? "working" : null, error: i % 9 ? null : "exit 1" });
  }
  await insertAll(db, "jobs", jobs);
  const ids = (await db.all(db.k.selectFrom("jobs").select(["id", "repo"]).orderBy("id"))) as { id: number; repo: string }[];
  await insertAll(db, "job_items", ids.map((j, i) => ({ job_id: j.id, repo: j.repo, number: (i % ITEMS) + 1, at: iso(i * 3) })));
  const runRows: Record<string, unknown>[] = ids.slice(0, 1500).map((j, i) => ({
    job_id: j.id, step: "opus-review", stage: 5, prompt_id: "p", prompt_version: "1", provider: "claude", model: "opus",
    items: JSON.stringify([{ repo: j.repo, number: (i % ITEMS) + 1 }]), item_count: 1, state: i < 4 ? "running" : "done", started_at: iso(i * 3 + 1), ended_at: i < 4 ? null : iso(i * 3), cost_usd: 0.12,
  }));
  await insertAll(db, "agent_runs", runRows);
  const runIds = (await db.all(db.k.selectFrom("agent_runs").select(["id", "items"]).orderBy("id"))) as { id: number; items: string }[];
  await insertAll(db, "agent_run_items", runIds.map((r) => ({ run_id: r.id, ...(JSON.parse(r.items) as { repo: string; number: number }[])[0] })));
  await insertAll(db, "sync_runs", Array.from({ length: 50 }, (_, i) => ({ started_at: iso(i * 10 + 1), ended_at: iso(i * 10), mode: "full", items: 10, error: null })));
  await insertAll(db, "settings", [{ key: "liveness_at", value: iso(5) }, { key: "liveness_open", value: "4000" }]);
  await insertAll(db, "liveness_items", Array.from({ length: 150 }, (_, i) => ({
    repo: repos[i % REPOS], number: (i % ITEMS) + 1, kind: "pr", verdict: i % 3 ? "long" : "stuck", cause: "no-wait", state: "OPEN", wait: null, phase: "review", since: iso(i * 30 + 600), checked_at: iso(5),
  })));
  await insertAll(db, "build_envs", Array.from({ length: 3 }, (_, i) => ({ id: `env${i}`, label: `Env ${i}`, kind: "pod", slots: 4, key_hash: `k${i}`, created_at: iso(1000) })));
  await insertAll(db, "build_tasks", Array.from({ length: 300 }, (_, i) => ({
    step: "prbuild", repo: repos[i % REPOS], number: (i % ITEMS) + 1, head_sha: `h${(i % ITEMS) + 1}`, requires: "{}", plan: "{}", state: i < 5 ? "running" : "done", queued_at: iso(i * 5 + 2),
  })));
}

const req = (params: Record<string, string> = {}, query = ""): Req => ({
  method: "GET", path: "", params, query: new URLSearchParams(query), form: new URLSearchParams(), scope: null,
  user: { login: "op", role: "operator", canWrite: async () => true, canRead: async () => true, permissionError: async () => null }, csrf: "", nonce: "",
} as unknown as Req);

const ROUTES: [string, Record<string, string>, string?][] = [
  ["/api/me", {}], ["/api/repos", {}], ["/api/progress", {}], ["/api/account/discord", {}], ["/api/health", {}], ["/api/live", {}],
  ["/api/maintain/home", {}], ["/api/maintain/items", {}], ["/api/maintain/items/:repo/:n", { repo: "repo1", n: "1" }], ["/api/maintain/queue", {}], ["/api/maintain/repos", {}],
  ["/api/items/:repo/:n/page", { repo: "repo1", n: "1" }], ["/api/items/:repo/:n", { repo: "repo1", n: "1" }],
  ["/api/items/:repo/:n/trace", { repo: "repo1", n: "1" }],
  ["/api/repos/all", {}], ["/api/repos/pipeline", {}], ["/api/envs", {}], ["/api/tasks", {}], ["/api/stuck", {}],
];

const name = `pagebench_${randomBytes(3).toString("hex")}`;
const server = await connectDb(admin, { role: "cli", migrate: false });
await server.script(`CREATE DATABASE ${name}`);
const direct = new URL(admin);
direct.pathname = `/${name}`;
const proxy = await startLatencyProxy({ host: direct.hostname, port: Number(direct.port || 5432) }, { delayMs });
const slow = new URL(direct);
slow.host = `127.0.0.1:${proxy.port}`;
try {
  const seedDb = await connectDb(direct.toString(), { role: "cli" });
  await seed(seedDb);
  await seedDb.script("ANALYZE");
  await seedDb.close();
  const db = await connectDb(slow.toString(), { role: "dashboard" });
  const routes = apiRoutes();
  console.log(`delay ${delayMs} ms each way, ${runs} runs, median`);
  for (const [pattern, params, query] of ROUTES) {
    if (only && !pattern.includes(only)) continue;
    const route = routes.find((r) => r.method === "GET" && r.pattern === pattern);
    if (!route) { console.log(`${pattern}: no such route`); continue; }
    let body: unknown;
    const call = async () => {
      // As the server serves a GET (src/dash/server/index.ts handleApi): shared reads, settings from one reading of the table.
      const res = await Promise.race([db.shareReads(async () => await withSettingsSnapshot(db, async () => await route.handler(db, req(params, query ?? "")), readSettingsSnapshot(db))), new Promise<never>((_, no) => setTimeout(() => no(new Error("no answer in 60 s")), 60_000))]);
      if (res.status && res.status >= 400) throw new Error(`${res.status} ${JSON.stringify(res.json)}`);
      body = res.json;
    };
    try {
      await call();
    } catch (e) {
      console.log(`${pattern}: ${(e as Error).message}`);
      continue;
    }
    const times: number[] = [];
    let last: ReturnType<typeof countQueries>["counts"] | undefined;
    const texts = new Map<string, number>();
    for (let i = 0; i < runs; i++) {
      texts.clear();
      const off = statements ? db.observe((e) => { if (e.kind === "query") { const t = e.sql.replace(/\s+/g, " ").slice(0, 160); texts.set(t, (texts.get(t) ?? 0) + 1); } }) : () => {};
      const c = countQueries(db);
      const t0 = performance.now();
      await call();
      times.push(performance.now() - t0);
      c.stop();
      off();
      last = c.counts;
    }
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${pattern.replace(/^\/api\//, "").replace(/[/:]+/g, "_")}.json`), JSON.stringify(body, null, 1));
    }
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)]!;
    console.log(`${pattern.padEnd(32)} ${String(Math.round(med)).padStart(6)} ms  ${String(last!.roundTrips).padStart(4)} trips  ${String(last!.rows).padStart(6)} rows  ${Math.round(last!.ms)} ms in db`);
    for (const [t, k] of [...texts].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padStart(4)}  ${t}`);
    if (sites) {
      for (const [s, v] of [...last!.sites].sort((a, b) => b[1].roundTrips - a[1].roundTrips).slice(0, sites))
        console.log(`    ${String(v.roundTrips).padStart(4)}  ${s.replace(process.cwd() + "/", "")}`);
    }
  }
  await db.close();
} finally {
  await proxy.close();
  await server.script(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await server.close();
}
