// CI on the default branch of every synced repo: one GraphQL query reads each head commit and its checks,
// main_ci keeps one row per head seen, and the dashboard shows the state of each repo and when it turned red.
// Read-only: nothing is written to GitHub.
import type { Querier } from "../mirror.ts";
import { contextState, type CheckState } from "../review/checks.ts";
import { trackedNames } from "../repos.ts";
import { optionalChecks } from "../optional-checks.ts";
import { mainRedAfterMerge } from "../push-outcomes.ts";
import { autocraftTexts } from "../mainfix/status.ts";
import { classify, derive, type Culprit, type HeadRow, type MainCheck, type MainCiState } from "./classify.ts";
import { ownerOf } from "../owners.ts";
import { isHiddenRepo, type HiddenRepos } from "../hidden-sql.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";
import { openDb } from "../db/open.ts";

/** Branch prefix of the PRs AutoCraft opens to fix a red main; the merge queue does not hold them while main is red. */
export const MAIN_FIX_BRANCH_PREFIX = "autocraft/main-ci-";

/** Repos whose current default-branch head is red. */
export async function redMainRepos(db: Db): Promise<Set<string>> {
  return new Set((await mainCiRepos(db)).filter((r) => r.state === "red").map((r) => r.repo));
}

/** Least time between two polls. */
export const POLL_EVERY_MS = 2 * 60_000;
/** Heads kept per repo. */
const KEEP_HEADS = 50;
/** Repos per query: 100 check contexts each keeps a query well under GitHub's node limit. */
const REPOS_PER_QUERY = 30;
const KEY_POLLED_AT = "main_ci_polled_at";

export { optionalChecks };

/** The owner variables of mainCiQuery. */
export const mainCiVars = (repos: string[]): Record<string, string> => Object.fromEntries(repos.map((r, i) => [`o${i}`, ownerOf(r)]));

export function mainCiQuery(repos: string[]): string {
  const parts = repos.map((r, i) => `
    r${i}: repository(owner: $o${i}, name: ${JSON.stringify(r)}) {
      defaultBranchRef { name target { ... on Commit {
        oid committedDate messageHeadline
        statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name conclusion status detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } }
      } } }
    }`).join("");
  return `query(${repos.map((_, i) => `$o${i}: String!`).join(", ")}) {
  rateLimit { cost remaining resetAt }${parts}
}`;
}

type Ctx = { __typename?: string; name?: string; status?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null };
type RepoNode = {
  defaultBranchRef?: { name: string; target?: { oid?: string; committedDate?: string; messageHeadline?: string; statusCheckRollup?: { contexts?: { nodes?: (Ctx | null)[] } } | null } | null } | null;
} | null;

export type Head = { repo: string; branch: string; sha: string; committedAt: string | null; headline: string | null; checks: MainCheck[] };

/** The heads of a reply to mainCiQuery; a repo that is gone or has no default branch is left out. */
export function parseHeads(repos: string[], data: Record<string, RepoNode | undefined>): Head[] {
  const out: Head[] = [];
  repos.forEach((repo, i) => {
    const ref = data[`r${i}`]?.defaultBranchRef;
    const t = ref?.target;
    if (!ref || !t?.oid) return;
    const checks = (t.statusCheckRollup?.contexts?.nodes ?? []).filter((c): c is Ctx => !!c).map((c) => ({
      name: c.name ?? c.context ?? "?", state: contextState(c) as CheckState, url: c.detailsUrl ?? c.targetUrl ?? null,
    }));
    out.push({ repo, branch: ref.name, sha: t.oid, committedAt: t.committedDate ?? null, headline: t.messageHeadline ?? null, checks });
  });
  return out;
}

/** Stores a head: a new row, or the row of a head seen before with its current checks; state_changed_at moves only when the state does. Returns its state. */
export async function saveHead(db: Db, h: Head, at: string): Promise<MainCiState> {
  const state = classify(h.checks, await optionalChecks(db, h.repo));
  const failing = JSON.stringify(h.checks.filter((c) => c.state === "failure").map((c) => ({ name: c.name, url: c.url })));
  await db.run(db.k.insertInto("main_ci")
    .values({ repo: h.repo, head_sha: h.sha, branch: h.branch, state, failing, checks: JSON.stringify(h.checks), committed_at: h.committedAt, headline: h.headline, first_seen_at: at, state_changed_at: at, updated_at: at })
    .onConflict((oc) => oc.columns(["repo", "head_sha"]).doUpdateSet((eb) => ({
      branch: eb.ref("excluded.branch"), state: eb.ref("excluded.state"), failing: eb.ref("excluded.failing"), checks: eb.ref("excluded.checks"),
      committed_at: eb.ref("excluded.committed_at"), headline: eb.ref("excluded.headline"), updated_at: eb.ref("excluded.updated_at"),
      state_changed_at: eb.case().when("main_ci.state", "=", eb.ref("excluded.state")).then(eb.ref("main_ci.state_changed_at")).else(eb.ref("excluded.updated_at")).end(),
    }))));
  await db.run(db.k.deleteFrom("main_ci").where("repo", "=", h.repo).where((eb) => eb("head_sha", "not in", eb.selectFrom("main_ci").select("head_sha").where("repo", "=", h.repo)
    .orderBy(eb.fn.coalesce("committed_at", "first_seen_at"), "desc").orderBy("first_seen_at", "desc").limit(KEEP_HEADS))));
  return state;
}

/** Reads the default-branch heads of the synced repos (or of `only`) and stores them. */
export async function pollMainCi(db: Db, client: Querier, only?: string, log: (line: string) => void = () => {}): Promise<{ repos: number; heads: number }> {
  const synced = new Set((await db.all(db.k.selectFrom("repos").select("name").where("synced_at", "is not", null))).map((r) => r.name));
  const repos = (await trackedNames(db)).filter((r) => synced.has(r) && (!only || r === only));
  let heads = 0;
  for (let i = 0; i < repos.length; i += REPOS_PER_QUERY) {
    const chunk = repos.slice(i, i + REPOS_PER_QUERY);
    const data = await client.query(mainCiQuery(chunk), mainCiVars(chunk));
    const at = new Date().toISOString();
    for (const h of parseHeads(chunk, data as Record<string, RepoNode>)) {
      await saveHead(db, h, at);
      heads++;
    }
  }
  // A red head whose culprit is a PR we merged stops the merge path.
  for (const r of await mainCiRepos(db)) if (r.state === "red" && r.culprit?.pr) await mainRedAfterMerge(db, r.repo, r.culprit.pr, r.culprit.sha);
  if (!only) await db.run(db.k.insertInto("settings").values({ key: KEY_POLLED_AT, value: new Date().toISOString() }).onConflict((oc) => oc.column("key").doUpdateSet(kx.excluded(["value"]))));
  log(`main-ci: ${heads} heads of ${repos.length} repos`);
  return { repos: repos.length, heads };
}

/** Polls when the last full poll is older than POLL_EVERY_MS; the sync run calls it, so it runs with the pipeline on or off. */
export async function pollMainCiIfDue(db: Db, client: Querier, now = Date.now()): Promise<boolean> {
  const at = await setting(db, KEY_POLLED_AT);
  if (at && now - Date.parse(at) < POLL_EVERY_MS - 5_000) return false;
  await pollMainCi(db, client);
  return true;
}

export type MainCiRepoRow = {
  repo: string; state: MainCiState; branch: string; headSha: string; headline: string | null; committedAt: string | null;
  failing: { name: string; url: string | null }[]; redSince: string | null; lastGreenSha: string | null; culprit: Culprit | null; updatedAt: string;
  /** What AutoCraft is doing about the red head (src/mainfix); null when nothing. */
  autocraft: string | null;
};

type Stored = { repo: string; head_sha: string; branch: string; state: MainCiState; failing: string; committed_at: string | null; headline: string | null; first_seen_at: string; state_changed_at: string; updated_at: string };

/** One entry per repo with stored heads, red first, then by name. `hidden` repos are left out. */
export async function mainCiRepos(db: Db, hidden: HiddenRepos = []): Promise<MainCiRepoRow[]> {
  const by = new Map<string, Stored[]>();
  for (const r of await db.all(db.k.selectFrom("main_ci").select(["repo", "head_sha", "branch", "state", "failing", "committed_at", "headline", "first_seen_at", "state_changed_at", "updated_at"])
    .$narrowType<{ state: MainCiState }>())) {
    if (isHiddenRepo(hidden, r.repo)) continue;
    (by.get(r.repo) ?? by.set(r.repo, []).get(r.repo)!).push(r);
  }
  const tracked = new Set(await trackedNames(db));
  const out: MainCiRepoRow[] = [];
  for (const [repo, rows] of by) {
    if (!tracked.has(repo)) continue;
    const rank = (h: Stored): HeadRow => ({ sha: h.head_sha, state: h.state, committedAt: h.committed_at, headline: h.headline, firstSeenAt: h.first_seen_at, stateChangedAt: h.state_changed_at });
    const d = derive(rows.map(rank));
    if (!d) continue;
    const cur = rows.find((r) => r.head_sha === d.current.sha)!;
    let failing: { name: string; url: string | null }[] = [];
    try { failing = JSON.parse(cur.failing) as typeof failing; } catch { /* malformed: none shown */ }
    out.push({ repo, state: cur.state, branch: cur.branch, headSha: cur.head_sha, headline: cur.headline, committedAt: cur.committed_at, failing, redSince: d.redSince, lastGreenSha: d.lastGreenSha, culprit: d.culprit, updatedAt: cur.updated_at, autocraft: null });
  }
  const texts = await autocraftTexts(db, out.map((r) => ({ repo: r.repo, headSha: r.headSha, state: r.state })));
  for (const r of out) r.autocraft = texts.get(`${r.repo}\0${r.headSha}`) ?? null;
  const weight: Record<MainCiState, number> = { red: 0, optional: 1, running: 2, none: 3, green: 4 };
  return out.sort((a, b) => weight[a.state] - weight[b.state] || a.repo.localeCompare(b.repo));
}

export function summarize(rows: { state: MainCiState }[]): Record<MainCiState, number> {
  const s: Record<MainCiState, number> = { green: 0, red: 0, optional: 0, running: 0, none: 0 };
  for (const r of rows) s[r.state]++;
  return s;
}

async function show(args: string[]): Promise<void> {
  let only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") only = args[++i];
    else throw new Error(`unknown argument ${args[i]}\nusage: main-ci [--repo R]`);
  }
  const rows = (await mainCiRepos(await openDb())).filter((r) => !only || r.repo === only);
  console.log(`${"repo".padEnd(28)} ${"state".padEnd(9)} ${"head".padEnd(9)} ${"red since".padEnd(21)} failing`);
  for (const r of rows) {
    console.log(`${r.repo.padEnd(28)} ${r.state.padEnd(9)} ${r.headSha.slice(0, 8).padEnd(9)} ${(r.redSince ?? "-").padEnd(21)} ${r.failing.map((f) => f.name).join(", ") || "-"}${r.culprit ? `  culprit ${r.culprit.sha.slice(0, 8)}${r.culprit.pr ? ` #${r.culprit.pr}` : ""}` : ""}`);
  }
}

export const commands = {
  "main-ci": { summary: "CI state of each synced repo's default branch: [--repo R]", run: show },
};
