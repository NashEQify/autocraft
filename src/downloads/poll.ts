// Polls GitHub release assets and star counts of the tracked repos and records the increases between polls.
// GitHub keeps only a running count per asset, so a range other than "All" fills in from the first poll onward.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readEnv } from "../github/read.ts";
import { trackedNames } from "../repos.ts";
import { ownerOf } from "../owners.ts";
import { appNameOf, classifyAsset } from "./classify.ts";
import { setting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";
import { excluded } from "../db/kx.ts";

const run = promisify(execFile);

export const POLL_EVERY_MS = 15 * 60_000;
export const KEY_POLLED_AT = "releases_polled_at";
/** Hour buckets older than this fold into day buckets. */
export const HOUR_KEEP_MS = 48 * 3600_000;
/** The whole poll stops starting repos after this long, so the sync run is not held; repos left over are read next time. */
export const BUDGET_MS = 90_000;
const CALL_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;
/** A repo last read longer ago than this (it was untracked, or reads failed) starts a new baseline instead of recording the gap as one spike. */
export const STALE_MS = 6 * 3600_000;
const KEY_OFFSET = "releases_offset";

export interface GhAsset { id: number; name: string; download_count: number }
export interface GhRelease { id: number; tag_name: string; name: string | null; draft: boolean; prerelease: boolean; published_at: string | null; created_at?: string; assets: GhAsset[] }
export interface RepoReleases { stars: number; releases: GhRelease[] }
export type Fetcher = (owner: string, repo: string) => Promise<RepoReleases>;

/** The real fetcher: `gh api` as the identity that reads the owner's repos. */
export const ghFetcher = (db?: Db): Fetcher => async (owner, repo) => {
  const env = await readEnv(owner, { db });
  const opts = { encoding: "utf8" as const, timeout: CALL_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, ...(env ? { env } : {}) };
  const [rel, info] = await Promise.all([
    run("gh", ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/releases?per_page=100`], opts),
    run("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".stargazers_count"], opts),
  ]);
  const releases = (JSON.parse(rel.stdout) as GhRelease[][]).flat();
  return { stars: Number(info.stdout.trim()) || 0, releases };
};

type Delta = { asset_id: number; t: string; span: "h" | "d"; delta: number };
/** Adds the deltas to their buckets; at most one row per (asset_id, t, span), as one statement cannot update a row twice. */
const addDeltas = (db: Db, rows: Delta[]) => db.run(db.k.insertInto("download_deltas").values(rows)
  .onConflict((oc) => oc.columns(["asset_id", "t", "span"]).doUpdateSet((eb) => ({ delta: eb("download_deltas.delta", "+", eb.ref("excluded.delta")) }))));

/** Rows per multi-row statement: under both engines' bound-parameter limits at sixteen columns a row. */
const BATCH_ROWS = 500;
const batches = <T>(rows: readonly T[]): T[][] => Array.from({ length: Math.ceil(rows.length / BATCH_ROWS) }, (_, i) => rows.slice(i * BATCH_ROWS, (i + 1) * BATCH_ROWS));

const hourOf = (ms: number): string => new Date(ms - (ms % 3600_000)).toISOString().replace(/\.\d+Z$/, "Z");
const dayOf = (ms: number): string => new Date(ms - (ms % 86400_000)).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Stores one repo's reading. A repo never read before, or last read more than STALE_MS ago, gets a baseline: counts are kept,
 * no increase is recorded. An asset GitHub stops listing is marked gone (history stays) and picks up where it was if it returns.
 */
export async function recordRepo(db: Db, repo: string, data: RepoReleases, now: number): Promise<void> {
  const at = new Date(now).toISOString();
  const bucket = hourOf(now);
  const known = new Map((await db.all(db.k.selectFrom("release_assets").select(["asset_id", "downloads", "repo"]))).map((r) => [r.asset_id, r]));
  const mine = [...known.values()].filter((r) => r.repo === repo);
  const lastRead = (await db.get(db.k.selectFrom("release_assets").select((eb) => eb.fn.max<string | null>("updated_at").as("t")).where("repo", "=", repo)))!.t;
  const baseline = mine.length === 0 || (lastRead !== null && now - Date.parse(lastRead) > STALE_MS);
  const live = data.releases.filter((r) => !r.draft);
  // One row per asset id (a listing that shifted between pages can repeat one; the last reading wins), written in multi-row
  // statements: a repo has hundreds of assets, and one statement each held the write lock for many seconds on Postgres.
  const latest = new Map<number, { rel: GhRelease; a: GhAsset }>();
  for (const rel of live) for (const a of rel.assets) latest.set(a.id, { rel, a });
  const assets = [...latest.values()].map(({ rel, a }) => {
    const c = classifyAsset(a.name), count = a.download_count ?? 0, prev = known.get(a.id)?.downloads;
    return {
      row: {
        asset_id: a.id, repo, release_id: rel.id, tag: rel.tag_name, release_name: rel.name, published_at: rel.published_at ?? rel.created_at ?? null, prerelease: rel.prerelease ? 1 : 0,
        name: a.name, platform: c?.platform ?? null, processor: c?.processor ?? null, format: c?.format ?? null, downloads: count, first_seen: at, updated_at: at, gone_at: null,
      },
      delta: c ? (baseline ? 0 : prev === undefined ? count : count - prev) : 0,
    };
  });
  const deltas = assets.filter((x) => x.delta > 0).map((x) => ({ asset_id: x.row.asset_id, t: bucket, span: "h" as const, delta: x.delta }));
  const gone = mine.filter((r) => !latest.has(r.asset_id)).map((r) => r.asset_id);
  await db.write(async () => {
    for (const rows of batches(assets.map((x) => x.row))) {
      await db.run(db.k.insertInto("release_assets").values(rows)
        .onConflict((oc) => oc.column("asset_id").doUpdateSet((eb) => ({ ...excluded(["repo", "release_id", "tag", "release_name", "published_at", "prerelease", "name", "platform", "processor", "format", "downloads", "updated_at"])(eb), gone_at: null }))));
    }
    for (const rows of batches(deltas)) await addDeltas(db, rows);
    for (const ids of batches(gone)) await db.run(db.k.updateTable("release_assets").set({ gone_at: at }).where("asset_id", "in", ids).where("gone_at", "is", null));
    const counted = live.filter((r) => r.assets.some((a) => classifyAsset(a.name)));
    if (counted.length) {
      const latest = [...counted].sort((a, b) => Date.parse(b.published_at ?? b.created_at ?? "") - Date.parse(a.published_at ?? a.created_at ?? ""))[0]!;
      await db.run(db.k.insertInto("release_apps").values({ repo, name: appNameOf(latest.name, repo), stars: data.stars, updated_at: at })
        .onConflict((oc) => oc.column("repo").doUpdateSet(excluded(["name", "stars", "updated_at"]))));
      const last = await db.get(db.k.selectFrom("star_samples").select("stars").where("repo", "=", repo).orderBy("t", "desc").limit(1));
      if (!last || last.stars !== data.stars) await db.run(db.k.insertInto("star_samples").values({ repo, t: bucket, stars: data.stars })
        .onConflict((oc) => oc.columns(["repo", "t"]).doUpdateSet(excluded(["stars"]))));
    } else {
      // Releases that vanished keep their history, so the app stays while any counted file is stored.
      await db.run(db.k.deleteFrom("release_apps").where("repo", "=", repo).where((eb) => eb.not(eb.exists(
        eb.selectFrom("release_assets").select(eb.lit(1).as("one")).where("release_assets.repo", "=", repo).where("release_assets.format", "is not", null)))));
    }
  });
}

/** Folds hour buckets older than 48 hours into day buckets. */
export async function foldDeltas(db: Db, now: number): Promise<void> {
  const cutoff = hourOf(now - HOUR_KEEP_MS);
  const old = await db.all(db.k.selectFrom("download_deltas").select(["asset_id", "t", "delta"]).where("span", "=", "h").where("t", "<", cutoff));
  if (!old.length) return;
  await db.write(async () => {
    const days = new Map<string, Delta>();
    for (const r of old) {
      const t = dayOf(Date.parse(r.t)), k = `${r.asset_id} ${t}`, d = days.get(k);
      if (d) d.delta += r.delta; else days.set(k, { asset_id: r.asset_id, t, span: "d", delta: r.delta });
    }
    for (const rows of batches([...days.values()])) await addDeltas(db, rows);
    await db.run(db.k.deleteFrom("download_deltas").where("span", "=", "h").where("t", "<", cutoff));
  });
}

/**
 * Reads the tracked repos, up to CONCURRENCY at a time, for at most BUDGET_MS, starting at a position that moves on each poll so every repo
 * is read across polls. A repo that fails is logged and skipped. Returns the number of repos read.
 */
export async function pollReleases(db: Db, fetcher: Fetcher = ghFetcher(db), now = Date.now(), log: (line: string) => void = () => {}, budgetMs = BUDGET_MS): Promise<number> {
  const repos = await trackedNames(db);
  const offset = repos.length ? Number(await setting(db, KEY_OFFSET) ?? 0) % repos.length : 0;
  const order = [...repos.slice(offset), ...repos.slice(0, offset)];
  const deadline = Date.now() + budgetMs;
  let next = 0;
  let read = 0;
  const worker = async (): Promise<void> => {
    while (next < order.length && Date.now() < deadline) {
      const repo = order[next++]!;
      try {
        await recordRepo(db, repo, await fetcher(ownerOf(repo), repo), now);
        read++;
      } catch (e) {
        log(`releases: ${repo}: ${String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, order.length) }, worker));
  const put = (key: string, value: string) => db.run(db.k.insertInto("settings").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet(excluded(["value"]))));
  await put(KEY_OFFSET, String(repos.length ? (offset + next) % repos.length : 0));
  await put(KEY_POLLED_AT, new Date(now).toISOString());
  try {
    await foldDeltas(db, now);
  } catch (e) {
    log(`releases: fold: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  log(`releases: ${read} of ${repos.length} repos read`);
  return read;
}

/** Polls when the last poll is older than POLL_EVERY_MS; the sync run calls it. */
export async function pollReleasesIfDue(db: Db, fetcher: Fetcher = ghFetcher(db), now = Date.now(), log: (line: string) => void = () => {}): Promise<boolean> {
  const at = await setting(db, KEY_POLLED_AT);
  if (at && now - Date.parse(at) < POLL_EVERY_MS - 5_000) return false;
  await pollReleases(db, fetcher, now, log);
  return true;
}
