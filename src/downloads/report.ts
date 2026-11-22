// The Downloads report: totals, breakdowns and release health over a time range, from the recorded polls (poll.ts) and the item mirror.
import { FORMAT_LABELS, PLATFORM_LABELS, PROCESSOR_LABELS } from "./classify.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export const RANGES = ["all", "today", "yesterday", "7d", "30d", "90d", "12m", "1h", "3h", "6h", "12h"] as const;
export type DownloadsRange = (typeof RANGES)[number];

export interface DownloadsBar { key: string; label: string; count: number }
export interface DownloadsReport {
  range: DownloadsRange; from: string | null; to: string;
  /** First recorded poll; ranges starting earlier only count from here. Null before the first poll. */
  historyFrom: string | null;
  apps: { repo: string; name: string }[];
  totals: { downloads: number; issuesOpened: number; issuesClosed: number; prsMerged: number; stars: number; issuesPer1k: number | null };
  byApp: { repo: string; name: string; downloads: number; stars: number }[];   // stars = gained in range, or total for "all"
  platforms: DownloadsBar[]; processors: DownloadsBar[]; formats: DownloadsBar[];
  versions: DownloadsBar[];   // top 7 releases "<App> v<x>" + "Other versions"
  releases: { repo: string; app: string; tag: string; publishedAt: string; latest: boolean; downloads: number; issues: number; per1k: number | null }[];  // newest 50
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const DAY = 86400_000;
const HOUR = 3600_000;

/** Start and end of a range. Day ranges are UTC days ending now; hour ranges count the current hour and the ones before it. `to` is exclusive except for "now". */
export function rangeBounds(range: DownloadsRange, now: number): { from: string | null; to: string } {
  const today = now - (now % DAY);
  const hours = /^(\d+)h$/.exec(range);
  if (hours) return { from: iso(now - (now % HOUR) - (Number(hours[1]) - 1) * HOUR), to: iso(now) };
  switch (range) {
    case "all": return { from: null, to: iso(now) };
    case "today": return { from: iso(today), to: iso(now) };
    case "yesterday": return { from: iso(today - DAY), to: iso(today) };
    case "7d": return { from: iso(today - 6 * DAY), to: iso(now) };
    case "30d": return { from: iso(today - 29 * DAY), to: iso(now) };
    case "90d": return { from: iso(today - 89 * DAY), to: iso(now) };
    default: return { from: iso(today - 364 * DAY), to: iso(now) };
  }
}

const bars = (rows: { key: string | null; n: number }[], labels: Record<string, string>): DownloadsBar[] =>
  rows.filter((r) => r.key && r.n > 0).sort((a, b) => b.n - a.n).map((r) => ({ key: r.key!, label: labels[r.key!] ?? r.key!, count: r.n }));

/** `repos` are the visible tracked repos; `app` narrows the figures to one of them. */
export async function downloadsReport(db: Db, repos: string[], range: DownloadsRange, app: string | null, now = Date.now()): Promise<DownloadsReport> {
  const { from, to } = rangeBounds(range, now);
  const appRows = (await db.all(db.k.selectFrom("release_apps").select(["repo", "name", "stars"]).orderBy(kx.nocase(db, "name")))).filter((a) => repos.includes(a.repo));
  const scope = app && appRows.some((a) => a.repo === app) ? [app] : appRows.map((a) => a.repo);
  const firstSeen = (await db.get(db.k.selectFrom("release_assets").select((eb) => eb.fn.min<string | null>("first_seen").as("t")).where(kx.inList(db, "repo", scope))))!.t;
  const historyFrom = firstSeen ? iso(Date.parse(firstSeen)) : null;

  // Downloads per counted asset in range: the running count for "all", the recorded increases otherwise.
  const perAsset = from === null
    ? await db.all(db.k.selectFrom("release_assets as a")
      .select(["a.asset_id", "a.repo", "a.tag", "a.release_id", "a.platform", "a.processor", "a.format", "a.downloads as n"])
      .where("a.format", "is not", null).where("a.gone_at", "is", null).where(kx.inList(db, "a.repo", scope)).orderBy("a.repo").orderBy("a.asset_id"))
    : await db.all(db.k.selectFrom("download_deltas as d").innerJoin("release_assets as a", "a.asset_id", "d.asset_id")
      .select((eb) => ["a.asset_id", "a.repo", "a.tag", "a.release_id", "a.platform", "a.processor", "a.format", eb.fn.sum<number>("d.delta").as("n")])
      .where("d.t", ">=", from).where("d.t", "<", rangeEnd(range, to)).where("a.format", "is not", null).where(kx.inList(db, "a.repo", scope))
      .groupBy("a.asset_id").orderBy("a.asset_id"));

  const sum = (key: (r: (typeof perAsset)[number]) => string | null): { key: string | null; n: number }[] => {
    const m = new Map<string | null, number>();
    for (const r of perAsset) m.set(key(r), (m.get(key(r)) ?? 0) + r.n);
    return [...m].map(([key, n]) => ({ key, n }));
  };
  const downloads = perAsset.reduce((s, r) => s + r.n, 0);

  // Stars: the total for "all", else what was gained since the range start (against the first reading when history starts later).
  const starsOf = async (repo: string): Promise<number> => {
    const cur = appRows.find((a) => a.repo === repo)?.stars ?? 0;
    if (from === null) return cur;
    const before = await db.get(db.k.selectFrom("star_samples").select("stars").where("repo", "=", repo).where("t", "<", from).orderBy("t", "desc").limit(1));
    const first = before ?? await db.get(db.k.selectFrom("star_samples").select("stars").where("repo", "=", repo).orderBy("t").limit(1));
    if (!first) return 0;
    if (range === "yesterday") {
      const end = await db.get(db.k.selectFrom("star_samples").select("stars").where("repo", "=", repo).where("t", "<", to).orderBy("t", "desc").limit(1));
      return Math.max(0, (end?.stars ?? first.stars) - first.stars);
    }
    return Math.max(0, cur - first.stars);
  };

  const byApp = (await mapSeq(appRows.filter((a) => scope.includes(a.repo)), async (a) => ({
    repo: a.repo, name: a.name, downloads: perAsset.filter((r) => r.repo === a.repo).reduce((s, r) => s + r.n, 0), stars: await starsOf(a.repo),
  }))).sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));

  // Releases with counted files, newest first.
  const relAll = await db.all(db.k.selectFrom("release_assets")
    .select((eb) => ["repo", eb.fn.max<string>("tag").as("tag"), "release_id", eb.fn.max<string | null>("published_at").as("published"), eb.fn.max<number>("prerelease").as("pre"),
      eb.fn.max<number>(eb.case().when("gone_at", "is", null).then(eb.lit(1)).else(eb.lit(0)).end()).as("live")])
    .where("format", "is not", null).where(kx.inList(db, "repo", scope)).groupBy(["repo", "release_id"]).orderBy("repo").orderBy("release_id"));
  relAll.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  const nameOf = new Map(appRows.map((a) => [a.repo, a.name]));
  const label = (repo: string, tag: string): string => `${nameOf.get(repo) ?? repo} v${/\d/.test(tag) ? tag.replace(/^\D*(?=\d)/, "") : tag}`;
  const perRelease = new Map<number, number>();
  for (const r of perAsset) perRelease.set(r.release_id, (perRelease.get(r.release_id) ?? 0) + r.n);
  // A release GitHub no longer lists stays only where it had downloads in the range.
  const rel = relAll.filter((r) => r.live || (perRelease.get(r.release_id) ?? 0) > 0);

  const versionRows = rel.map((r) => ({ key: `${r.repo}@${r.tag}`, n: perRelease.get(r.release_id) ?? 0, text: label(r.repo, r.tag) })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
  const versions: DownloadsBar[] = versionRows.slice(0, 7).map((r) => ({ key: r.key, label: r.text, count: r.n }));
  const other = versionRows.slice(7).reduce((s, r) => s + r.n, 0);
  if (other > 0) versions.push({ key: "other", label: "Other versions", count: other });

  // Issues opened while a release was the newest one of its repo, within the range.
  const lo = from ?? "";
  const hi = rangeEnd(range, to);
  const issuesIn = async (repo: string, start: string, end: string): Promise<number> => (await db.get(db.k.selectFrom("main.items").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("repo", "=", repo).where("kind", "=", "issue").where("created_at", ">=", start).where("created_at", "<", end)))!.n;
  const newest = new Map<string, string>();
  const releases: DownloadsReport["releases"] = [];
  for (const r of rel) if (!r.pre && !newest.has(r.repo)) newest.set(r.repo, r.tag);
  const byRepo = new Map<string, typeof rel>();
  for (const r of rel) (byRepo.get(r.repo) ?? byRepo.set(r.repo, []).get(r.repo)!).push(r);
  for (const r of rel.slice(0, 50)) {
    const mine = byRepo.get(r.repo)!;
    const nextNewer = mine.filter((o) => (o.published ?? "") > (r.published ?? "")).map((o) => o.published!).sort()[0];
    const end = nextNewer ?? "9999";
    const start = (r.published ?? "") > lo ? (r.published ?? "") : lo;
    const upper = end < hi ? end : hi;
    const inRange = start < upper ? await issuesIn(r.repo, start, upper) : 0;
    const n = perRelease.get(r.release_id) ?? 0;
    releases.push({ repo: r.repo, app: nameOf.get(r.repo) ?? r.repo, tag: r.tag, publishedAt: r.published ?? "", latest: newest.get(r.repo) === r.tag, downloads: n, issues: inRange, per1k: n > 0 ? (inRange / n) * 1000 : null });
  }

  const count = async (kind: string, col: "created_at" | "closed_at" | "merged_at"): Promise<number> => (await db.get(db.k.selectFrom("main.items").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("kind", "=", kind).where(kx.inList(db, "repo", scope)).where(col, "is not", null).where(col, ">=", lo).where(col, "<", hi)))!.n;
  const issuesOpened = await count("issue", "created_at");
  const issuesClosed = await count("issue", "closed_at");
  const prsMerged = await count("pr", "merged_at");

  return {
    range, from, to, historyFrom,
    apps: appRows.map((a) => ({ repo: a.repo, name: a.name })),
    totals: { downloads, issuesOpened, issuesClosed, prsMerged, stars: byApp.reduce((s, a) => s + a.stars, 0), issuesPer1k: downloads > 0 ? (issuesOpened / downloads) * 1000 : null },
    byApp,
    platforms: bars(sum((r) => r.platform), PLATFORM_LABELS),
    processors: bars(sum((r) => r.processor), PROCESSOR_LABELS),
    formats: bars(sum((r) => r.format), FORMAT_LABELS),
    versions, releases,
  };
}

/** Exclusive end of a range's buckets: "to" for yesterday, a moment after now for the others (a bucket may start at "now"). */
function rangeEnd(range: DownloadsRange, to: string): string {
  return range === "yesterday" ? to : iso(Date.parse(to) + 1000);
}
