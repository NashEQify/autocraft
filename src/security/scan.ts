// The security deep scan engine: threat model, one call per area, one verify call per finding, with a spend cap
// checked before every call. It runs in the runner's job process (step `security-scan`) on a pinned commit of the
// default branch; nothing here writes to GitHub.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { FindingVerification } from "../../web/src/api/types.ts";
import { featureOn } from "../build/features.ts";
import { audit } from "../dash/audit.ts";
import type { CratesResult } from "../verify/crates.ts";
import { writeAndQueue } from "./scantest.ts";
import { ACTIVE_STATES, findingKey, finishScan, scanRow } from "./store.ts";
import {
  securityRepo, parseCandidates, parseScanTest, parseThreatModel, parseVerdict, survives, titleKey,
  type Candidate, type SecurityAreaInput, type SecurityModelInput, type SecurityScanTestInput, type SecurityVerifyInput, type ThreatArea, type ThreatModel,
} from "./rules.ts";
import { forEachSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";
import type { NotNull } from "kysely";

/** One model call. `text` is null when the call gave no answer; `cost` is what it cost whatever the outcome, null when unknown. */
/** `runId` is the first agent run the call made (shown on the scan page); absent when it made none. */
export type Reply = { text: string | null; cost: number | null; runId?: number | null };
export type Ask = {
  (id: "security.model", input: SecurityModelInput): Promise<Reply | null>;
  (id: "security.area", input: SecurityAreaInput): Promise<Reply | null>;
  (id: "security.verify", input: SecurityVerifyInput): Promise<Reply | null>;
};
export type ScanDeps = {
  ask: Ask;
  /** The pinned commit of the default branch and a read-only directory of its files, or null when none can be made. */
  /** With `pin`, the checkout of exactly that commit (a continued scan), else the current head of the default branch. */
  checkout: (repo: string, pin?: string) => Promise<{ dir: string; sha: string } | null>;
  cancelled: () => Promise<boolean>;
  log: (line: string) => void;
  progress?: (line: string) => void;
  /** The model call that writes a finding's scan test (feature scan-tests); with `crates`, absent means no scan tests. */
  writeTest?: (input: SecurityScanTestInput) => Promise<Reply | null>;
  /** The crates of the workspace at a commit, for placing a scan test. */
  crates?: (repo: string, sha: string) => Promise<CratesResult>;
  /** Called when verify confirms finding `n`, to start its private fix. */
  confirmed?: (n: number) => Promise<unknown>;
};

/** What a call is expected to cost before any has run, in dollars. The area guess grows with the size of the area's files. */
export const MODEL_GUESS_USD = 2;
export const VERIFY_GUESS_USD = 0.6;
export const SCAN_TEST_GUESS_USD = 0.5;
export const areaGuessUsd = (bytes: number): number => Math.min(6, 1 + bytes / 200_000);
const BYTES_CAP = 2_000_000;
const MAX_FILE = 2 * 1024 * 1024;
/** Calls are repeated once when the reply cannot be read. */
const ATTEMPTS = 2;

const now = (): string => new Date().toISOString();
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Bytes of the regular files under `paths` in the checkout, counted up to BYTES_CAP; null when none of the paths exists. */
export function pathsBytes(dir: string, paths: string[]): number | null {
  const root = resolve(dir);
  let total = 0, any = false;
  const walk = (p: string): void => {
    if (total >= BYTES_CAP) return;
    let st;
    try { st = statSync(p); } catch { return; }
    any = true;
    if (st.isFile()) total += st.size;
    else if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  };
  for (const p of paths) {
    const full = resolve(root, p);
    if (full === root || full.startsWith(root + sep)) walk(full);
  }
  return any ? total : null;
}

/** Keeps the refs that point at a line of a file in the checkout. */
function realRefs(dir: string, refs: Candidate["refs"]): Candidate["refs"] {
  const root = resolve(dir);
  return refs.filter((r) => {
    const full = resolve(root, r.path);
    if (!full.startsWith(root + sep) || !existsSync(full)) return false;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_FILE) return false;
      return readFileSync(full, "utf8").split("\n").length >= r.line;
    } catch { return false; }
  });
}

type Ref = { path: string; line: number };
type Known = { number: number; state: string; fingerprint: string; sink: Ref | null; refs: Ref[]; title: string; category: string | null };
type KnownRow = { number: number; state: string; fingerprint: string; title: string; refs: string; category: string | null };
const knownOf = (r: KnownRow): Known => {
  const refs = JSON.parse(r.refs) as Ref[];
  return { number: r.number, state: r.state, fingerprint: r.fingerprint, title: r.title, category: r.category, sink: refs[0] ?? null, refs };
};

/** The primary location of a finding is its first ref: the line where the unsafe operation is (the prompt asks for it first). Other refs are entry points and checks that findings may share. */
const fingerprintOf = (c: Candidate): string => `${c.refs[0]!.path}:${c.refs[0]!.line}|${titleKey(c.title)}`;

const words = (t: string): Set<string> => new Set(titleKey(t).split(" ").filter((w) => w.length > 2));
const similar = (a: string, b: string): boolean => {
  const x = words(a), y = words(b);
  const common = [...x].filter((w) => y.has(w)).length;
  return common > 0 && common / (x.size + y.size - common) >= 0.5;
};

const near = (a: Ref, b: Ref): boolean => a.path === b.path && Math.abs(a.line - b.line) <= 3;
/** The refs after the sink that `a` and `b` both cite. */
const sharedRefs = (a: Ref[], b: Ref[]): number => a.slice(1).filter((x) => b.slice(1).some((y) => near(x, y))).length;

/**
 * The earlier finding of the repository that `c` repeats: its exact fingerprint (a disproved finding suppresses only that),
 * or a sink in the same file within a few lines plus one of: the same category, a similar title, or two more shared refs.
 * Category and title are the model's words and vary between areas; the cited lines do not. One shared entry point is not
 * enough, since distinct bugs often start from the same entry.
 */
export const earlierFinding = (known: Known[], c: Pick<Candidate, "title" | "category" | "refs">): Known | undefined => {
  const fp = fingerprintOf(c as Candidate), sink = c.refs[0]!;
  return known.find((k) => k.fingerprint === fp)
    ?? known.find((k) => k.state !== "disproved" && k.state !== "duplicate" && !!k.sink && near(k.sink, sink)
      && ((!!c.category && k.category === c.category) || similar(k.title, c.title) || sharedRefs(k.refs, c.refs) >= 2));
};

/**
 * Links each listed finding that repeats an earlier one of its repository by the rule above, oldest first, and
 * returns how many it linked. A finding someone has acted on keeps its state. Runs at runner start, so findings
 * stored under an older rule are linked too.
 */
export async function linkRepeatedFindings(db: Db): Promise<number> {
  const rows = await db.all(db.k.selectFrom("security_findings").select(["repo", "number", "state", "fingerprint", "title", "refs", "category"]).orderBy("repo").orderBy("number"));
  let linked = 0, repo = "", known: Known[] = [];
  for (const r of rows) {
    if (r.repo !== repo) { repo = r.repo; known = []; }
    const k = knownOf(r);
    const earlier = r.state === "new" && k.sink ? earlierFinding(known, { title: r.title, category: r.category ?? "", refs: k.refs as Candidate["refs"] }) : undefined;
    if (earlier && (await db.run(db.k.updateTable("security_findings").set({ state: "duplicate", duplicate_of: earlier.number, updated_at: now() })
      .where("repo", "=", r.repo).where("number", "=", r.number).where("state", "=", "new"))).changes) {
      await audit(db, "pipeline", "security-finding-duplicate", findingKey(r.repo, r.number), { duplicateOf: earlier.number });
      k.state = "duplicate";
      linked++;
    }
    known.push(k);
  }
  return linked;
}

const parse = <T>(s: string): T => JSON.parse(s) as T;

class Capped extends Error {}
class Stopped extends Error {}

/**
 * Runs scan `scanId` (created by the API in state `modeling`) to the end: done, stopped, capped or failed.
 * Returns the summary line of the job.
 */
export async function runScan(db: Db, scanId: number, deps: ScanDeps): Promise<string> {
  const scan = await scanRow(db, scanId);
  if (!scan) throw new Error(`no scan ${scanId}`);
  if (!ACTIVE_STATES.includes(scan.state)) return `scan ${scanId} already ${scan.state}`;
  const { repo, cap_usd: cap } = scan;
  const stopped = async (): Promise<boolean> => await deps.cancelled() || (await scanRow(db, scanId))?.state === "stopped";
  const setState = async (state: "modeling" | "scanning" | "verifying"): Promise<void> => void await db.run(db.k.updateTable("security_scans").set({ state }).where("id", "=", scanId).where("state", "in", ACTIVE_STATES));
  const progress = (line: string): void => { deps.progress?.(line); deps.log(line); };
  const cost = async (): Promise<number> => (await scanRow(db, scanId))!.cost_usd;
  // The calls of an earlier run of this scan (a continued scan) feed the estimates like the calls of this run.
  const earlier = async (kind: string): Promise<number[]> => (await db.all(db.k.selectFrom("security_calls").select("cost_usd").$narrowType<{ cost_usd: NotNull }>()
    .where("scan_id", "=", scanId).where("kind", "=", kind).where("ok", "=", 1).where("cost_usd", "is not", null).orderBy("id"))).map((r) => r.cost_usd);
  const areaCalls: number[] = await earlier("area"), verifyCalls: number[] = await earlier("verify");
  let areaGuess = areaGuessUsd(0);

  /** One call with the cap and stop checks before it; the call's cost goes to the scan and, for area work, to the area. */
  async function call<T>(kind: "model" | "area" | "verify" | "test", expected: number, meta: { area?: number; finding?: number; bill?: number }, run: () => Promise<Reply | null>, readReply: (text: string) => T | null): Promise<{ value: T; cost: number } | null> {
    let spent = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (await stopped()) throw new Stopped();
      if (cap !== null && await cost() + expected > cap) throw new Capped();
      const id = (await db.get(db.k.insertInto("security_calls").values({ scan_id: scanId, kind, area_idx: meta.area ?? null, finding_number: meta.finding ?? null, started_at: now() }).returning("id")))!.id;
      let reply: Reply | null = null;
      try { reply = await run(); } catch (e) { deps.log(`${kind} call failed: ${(e as Error).message}`.slice(0, 300)); }
      // A call that answered without a reported cost counts as the expected cost; one that failed counts what it reported.
      const c = reply ? reply.cost ?? (reply.text !== null ? expected : 0) : 0;
      const value = reply?.text != null ? readReply(reply.text) : null;
      await db.run(db.k.updateTable("security_calls").set({ ended_at: now(), ok: value === null ? 0 : 1, cost_usd: reply ? c : null, agent_run_id: reply?.runId ?? null }).where("id", "=", id));
      await db.run(db.k.updateTable("security_scans").set((eb) => ({ cost_usd: eb("cost_usd", "+", c) })).where("id", "=", scanId));
      if (meta.bill !== undefined) await db.run(db.k.updateTable("security_areas").set((eb) => ({ cost_usd: eb("cost_usd", "+", c) })).where("scan_id", "=", scanId).where("idx", "=", meta.bill));
      spent += c;
      if (value !== null) return { value, cost: spent };
    }
    return null;
  }

  /** Ends the scan as failed and throws, so the job fails too. */
  const fail = async (msg: string): Promise<never> => {
    await finishScan(db, scanId, "failed", msg.slice(0, 500));
    throw new Error(`${repo}: scan ${scanId} failed: ${msg}`);
  };

  try {
    const co = await deps.checkout(repo, scan.commit_sha ?? undefined);
    if (!co) return await fail("The repository could not be checked out for a read-only scan.");
    if (scan.commit_sha && co.sha !== scan.commit_sha) return await fail(`The checkout is at ${co.sha.slice(0, 7)}, not the scan's pinned commit ${scan.commit_sha.slice(0, 7)}.`);
    await db.run(db.k.updateTable("security_scans").set({ commit_sha: co.sha }).where("id", "=", scanId));
    const base = { repo: securityRepo(repo), number: scanId, project: repo, commit: co.sha } as const;

    // A continued scan keeps its threat model and areas; only the areas still pending are scanned.
    const kept = scan.threat_model ? parse<{ summary: string; entryPoints: ThreatModel["entryPoints"] }>(scan.threat_model) : null;
    const keptAreas = kept ? await db.all(db.k.selectFrom("security_areas").select(["idx", "name", "paths", "entry_points", "risk", "why", "state"]).where("scan_id", "=", scanId).orderBy("idx")) : [];
    const resumed = !!kept && keptAreas.length > 0;
    let summaryText: string, entryPoints: ThreatModel["entryPoints"];
    const areas: ThreatArea[] = [];
    const sizes: number[] = [];
    const doneIdx = new Set<number>();
    if (resumed) {
      summaryText = kept!.summary;
      entryPoints = kept!.entryPoints;
      for (const a of keptAreas) {
        areas.push({ name: a.name, paths: parse<string[]>(a.paths), entryPoints: parse<string[]>(a.entry_points), risk: a.risk, why: a.why ?? "" });
        sizes.push(pathsBytes(co.dir, parse<string[]>(a.paths)) ?? 0);
        if (a.state !== "pending") doneIdx.add(a.idx);
      }
      progress(`${repo}: continuing at area ${doneIdx.size + 1} of ${areas.length}`);
    } else {
      // ---- threat model ----
      await setState("modeling");
      progress(`${repo}: threat model`);
      const modeled = await call<ThreatModel>("model", MODEL_GUESS_USD, {}, () => deps.ask("security.model", { ...base }), parseThreatModel);
      if (!modeled) return await fail("The threat model could not be read.");
      summaryText = modeled.value.summary;
      entryPoints = modeled.value.entryPoints;
      for (const a of modeled.value.areas) {
        const bytes = pathsBytes(co.dir, a.paths);
        if (bytes === null) continue;
        areas.push(a);
        sizes.push(bytes);
      }
      if (!areas.length) return await fail("The threat model named no area that exists in the checkout.");
      await forEachSeq(areas, async (a, i) => void await db.run(db.k.insertInto("security_areas")
        .values({ scan_id: scanId, idx: i, name: a.name, paths: JSON.stringify(a.paths), entry_points: JSON.stringify(a.entryPoints), risk: a.risk, why: a.why })));
      const total = sizes.map(areaGuessUsd).reduce((x, y) => x + y, 0);
      await db.run(db.k.updateTable("security_scans")
        .set({ areas_total: areas.length, estimate_usd: await cost() + total, threat_model: JSON.stringify({ summary: summaryText, entryPoints }) }).where("id", "=", scanId));
    }
    const guesses = sizes.map(areaGuessUsd);

    const known: Known[] = (await db.all(db.k.selectFrom("security_findings").select(["number", "state", "fingerprint", "title", "refs", "category"]).where("repo", "=", repo).orderBy("number"))).map(knownOf);

    const unverifiedOf = async (area: string): Promise<{ number: number; c: Candidate }[]> =>
      (await db.all(db.k.selectFrom("security_findings").select(kx.cols("security_findings")).$narrowType<{ severity: Candidate["severity"] }>()
        .where("scan_id", "=", scanId).where("area", "=", area).where("state", "=", "unverified").orderBy("number")))
        .map((r) => ({ number: r.number, c: { title: r.title, severity: r.severity, urgent: r.urgent === 1, category: r.category ?? "", refs: parse<Candidate["refs"]>(r.refs), reach: r.reach, impact: r.impact } }));

    // ---- areas ----
    for (const [idx, area] of areas.entries()) {
      if (doneIdx.has(idx)) continue;
      areaGuess = mean(areaCalls) ?? guesses[idx]!;
      await setState("scanning");
      progress(`${repo}: area ${idx + 1} of ${areas.length}: ${area.name}`);
      const input: SecurityAreaInput = {
        ...base, summary: summaryText, area: { name: area.name, paths: area.paths, why: area.why },
        entry_points: entryPoints.filter((e) => area.entryPoints.includes(e.name)),
      };
      // An area the cap stopped during verification has its findings already; only the unchecked ones are verified.
      const leftover = resumed ? await unverifiedOf(area.name) : [];
      const hasFindings = resumed && !!await db.get(db.k.selectFrom("security_findings").select((eb) => eb.lit(1).as("one")).where("scan_id", "=", scanId).where("area", "=", area.name).limit(1));
      const found = hasFindings ? { value: [] as Candidate[], cost: 0 } : await call<Candidate[]>("area", areaGuess, { area: idx, bill: idx }, () => deps.ask("security.area", input), parseCandidates);
      if (!found) {
        await db.run(db.k.updateTable("security_areas").set({ state: "failed" }).where("scan_id", "=", scanId).where("idx", "=", idx));
        deps.log(`area ${area.name}: no readable answer`);
      } else {
        if (!hasFindings) areaCalls.push(found.cost);
        const fresh: { number: number; c: Candidate }[] = [...leftover];
        for (const c of found.value) {
          const refs = realRefs(co.dir, c.refs);
          // The first ref is the sink: a finding whose sink is not a real line is dropped.
          if (!refs.length || refs[0]!.path !== c.refs[0]!.path || refs[0]!.line !== c.refs[0]!.line) continue;
          const cand: Candidate = { ...c, refs };
          const earlier = earlierFinding(known, cand);
          const at = now();
          // A repeat is kept as a hidden row that points at the earlier finding, which shows it in its timeline.
          const row = (await db.get(db.k.insertInto("security_findings").values((eb) => ({
            repo, number: eb.selectFrom("security_findings").select((s) => s(s.fn.coalesce(s.fn.max("number"), s.lit(0)), "+", s.lit(1)).as("n")).where("repo", "=", repo),
            scan_id: scanId, area: area.name, title: cand.title, severity: cand.severity, urgent: cand.urgent ? 1 : 0, state: earlier ? "duplicate" : "unverified",
            refs: JSON.stringify(cand.refs), category: cand.category, reach: cand.reach, impact: cand.impact, fingerprint: fingerprintOf(cand), created_at: at, updated_at: at, duplicate_of: earlier?.number ?? null,
          })).returning("number")))!;
          known.push({ number: row.number, state: earlier ? "duplicate" : "unverified", fingerprint: fingerprintOf(cand), sink: cand.refs[0]!, refs: cand.refs, title: cand.title, category: cand.category ?? null });
          if (!earlier) fresh.push({ number: row.number, c: cand });
        }
        // ---- verify ----
        for (const f of fresh) {
          await setState("verifying");
          progress(`${repo}: verifying "${f.c.title}"`);
          const vin: SecurityVerifyInput = { ...base, number: scanId, finding: { ...f.c, area: area.name } };
          const checked = await call("verify", mean(verifyCalls) ?? VERIFY_GUESS_USD, { finding: f.number, bill: idx }, () => deps.ask("security.verify", vin), parseVerdict);
          if (!checked) {
            const v: FindingVerification = { kind: "reasoning", result: "Not verified: the verify call gave no readable answer.", notes: "", score: null, proposedTest: null };
            await db.run(db.k.updateTable("security_findings").set({ state: "new", verification: JSON.stringify(v), updated_at: now() }).where("repo", "=", repo).where("number", "=", f.number));
            continue;
          }
          verifyCalls.push(checked.cost);
          const verdict = checked.value;
          const v: FindingVerification = { kind: "reasoning", result: verdict.result, notes: verdict.notes, score: verdict.score, proposedTest: verdict.proposedTest };
          await db.run(db.k.updateTable("security_findings").set({ state: survives(verdict) ? "new" : "disproved", verification: JSON.stringify(v), updated_at: now() }).where("repo", "=", repo).where("number", "=", f.number));
          if (survives(verdict)) {
            // The test row is written before `confirmed`, so the automatic fix sees it and waits for the result.
            if (verdict.proposedTest?.trim() && deps.writeTest && deps.crates && await featureOn(db, "scan-tests")) {
              const crates = await deps.crates(repo, co.sha).catch((e: Error): CratesResult => ({ ok: false, error: e.message }));
              await writeAndQueue(db, {
                repo, number: f.number, sha: co.sha, crates, proposedTest: verdict.proposedTest, log: deps.log,
                finding: { title: f.c.title, severity: f.c.severity, refs: f.c.refs, reach: f.c.reach, impact: f.c.impact, area: area.name },
                write: (input) => call("test", SCAN_TEST_GUESS_USD, { finding: f.number, bill: idx }, () => deps.writeTest!({ ...base, ...input }), parseScanTest),
              });
            }
            await deps.confirmed?.(f.number);
          }
        }
      }
      await db.run(db.k.updateTable("security_areas").set((eb) => ({ state: eb.case().when("state", "=", "failed").then("failed").else("done").end() })).where("scan_id", "=", scanId).where("idx", "=", idx));
      const left = guesses.slice(idx + 1);
      const avg = (await db.get(db.k.selectFrom("security_areas").select((eb) => eb.fn.avg<number>("cost_usd").as("a")).where("scan_id", "=", scanId).where("state", "!=", "pending")))!.a;
      await db.run(db.k.updateTable("security_scans").set({ areas_done: idx + 1, estimate_usd: await cost() + left.length * avg }).where("id", "=", scanId));
    }
    await finishScan(db, scanId, "done");
    return `${repo}: scan ${scanId} done: ${areas.length} areas, ${(await db.get(db.k.selectFrom("security_findings").select((eb) => eb.fn.countAll<number>().as("n")).where("scan_id", "=", scanId).where("state", "=", "new")))!.n} findings, $${(await cost()).toFixed(2)}`;
  } catch (e) {
    if (e instanceof Capped) {
      await finishScan(db, scanId, "capped");
      return `${repo}: scan ${scanId} stopped at the spend cap ($${(await cost()).toFixed(2)} of $${cap})`;
    }
    if (e instanceof Stopped) {
      await finishScan(db, scanId, "stopped");
      return `${repo}: scan ${scanId} stopped`;
    }
    await finishScan(db, scanId, "failed", (e as Error).message.slice(0, 500));
    throw e;
  }
}
