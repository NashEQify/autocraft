// The caches report on fake data: six nodes (one stale, one whose agent cannot read its assignment), a placement with
// one node still syncing, and warm state for five repos (current, behind main, a failing build, an old toolchain image
// and one never built).
import type { CacheHeld, CacheNode, CachePlaced, CacheReport, CacheRepo } from "../types";
import { NOW } from "./fixtures";

const MIN = 60_000;
const GIB = 1024 ** 3;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const IMAGE = "craft-builds/rust-stable-4c1d9e0a7b3f";
const OLD_IMAGE = "craft-builds/rust-stable-9a07c2e1d5b8";

type Repo = { repo: string; commit: string; bytes: number; image: string };
const R: Record<string, Repo> = {
  photocraft: { repo: "photocraft", commit: "a07b3c9d1e2f4a5b6c7d8e9f0a1b2c3d4e5f6071", bytes: 27.4 * GIB, image: IMAGE },
  deckcraft: { repo: "deckcraft", commit: "3f9c1e07a2b4d8e6f0a1b2c3d4e5f60718293a4b", bytes: 11.2 * GIB, image: IMAGE },
  designcraft: { repo: "designcraft", commit: "5d2e8f1a9b0c3d4e5f60718293a4b5c6d7e8f901", bytes: 8.6 * GIB, image: IMAGE },
  pdfcraft: { repo: "pdfcraft", commit: "c4b5a69788f0e1d2c3b4a5968778695a4b3c2d1e", bytes: 6.1 * GIB, image: IMAGE },
  wordcraft: { repo: "wordcraft", commit: "e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4", bytes: 9.3 * GIB, image: OLD_IMAGE },
};
const key = (repo: string) => `${repo}-${repo.length.toString(16).padStart(2, "0")}7c1e9a40b2d6`;
const OLDER = "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";

const PLACED: [string, string[]][] = [["photocraft", ["node-1", "node-4"]], ["deckcraft", ["node-2", "node-5"]], ["wordcraft", ["node-3", "node-6"]], ["designcraft", ["node-1", "node-3"]], ["pdfcraft", ["node-2", "node-4"]], ["lightcraft", ["node-5", "node-6"]]];
const placedOn = (repo: string, node: string) => PLACED.some(([r, ns]) => r === repo && ns.includes(node));

function held(repo: string, node: string, older = false, syncedAgo = 40 * MIN): CacheHeld {
  const r = R[repo]!;
  return { key: key(repo), repo, commit: older ? OLDER : r.commit, bytes: older ? r.bytes * 0.96 : r.bytes, image: r.image, stored: iso(syncedAgo + 12 * MIN), synced: iso(syncedAgo), newest: !older, placed: placedOn(repo, node) };
}

function node(name: string, updatedAgo: number, usedPct: number, keys: CacheHeld[], over: Partial<CacheNode> = {}): CacheNode {
  const size = 1.8 * 1024 * GIB;
  return {
    node: name, updated: iso(updatedAgo), fresh: updatedAgo <= 15 * MIN,
    fs: { sizeBytes: size, usedBytes: Math.round(size * usedPct / 100), usedPct },
    warmBytes: { current: keys.reduce((s, k) => s + k.bytes, 0), grace: 0 },
    keys, pending: [], badBlobs: [], error: null, ...over,
  };
}

const NODES: CacheNode[] = [
  node("node-1", 2 * MIN, 41, [held("photocraft", "node-1"), held("designcraft", "node-1")]),
  node("node-2", 1 * MIN, 37, [held("deckcraft", "node-2"), held("pdfcraft", "node-2")], { warmBytes: { current: R.deckcraft!.bytes + R.pdfcraft!.bytes, grace: 5.8 * GIB } }),
  node("node-3", 4 * MIN, 52, [held("wordcraft", "node-3"), held("designcraft", "node-3")], { badBlobs: [{ key: key("designcraft"), repo: "designcraft", count: 3 }] }),
  node("node-4", 3 * MIN, 78, [held("photocraft", "node-4", true, 9 * 60 * MIN)], { pending: [{ key: key("photocraft"), repo: "photocraft", why: "downloading: 14.2 of 27.4 GB" }, { key: key("pdfcraft"), repo: "pdfcraft", why: "the filesystem is 78% full; new versions wait under 80%" }] }),
  node("node-5", 2 * MIN, 29, [held("deckcraft", "node-5")], { pending: [{ key: key("lightcraft"), repo: "lightcraft", why: "the store has no version" }] }),
  node("node-6", 47 * MIN, 33, [held("wordcraft", "node-6")], { error: "warm-assign: repos is not readable" }),
];

const PLACEMENT: CachePlaced[] = PLACED.map(([repo, nodes]) => ({
  key: key(repo), repo,
  nodes: nodes.map((n) => {
    const nd = NODES.find((x) => x.node === n)!;
    const k = nd.keys.find((x) => x.repo === repo);
    return { node: n, fresh: nd.fresh, holds: !k ? "none" as const : k.newest ? "newest" as const : "older" as const };
  }),
}));

/** `ids`: mock task ids of a done and a failed task, so the last-task links open real rows. */
export function cachesMock(ids: { done: number[]; failed: number[] }): CacheReport {
  const fresh = NODES.filter((n) => n.fresh);
  const nodesWith = (repo: string) => fresh.filter((n) => n.keys.some((k) => k.repo === repo && k.newest)).length;
  const done = (i: number) => ids.done[i % ids.done.length] ?? 1;
  const repo = (r: string, over: Partial<CacheRepo>): CacheRepo => ({
    repo: r, key: key(r), coverage: "pipeline", freshness: "current", head: R[r]?.commit ?? OLDER,
    last: { id: done(0), state: "done", summary: "warm build published 41,382 files", headSha: R[r]?.commit ?? OLDER, endedAt: iso(52 * MIN) },
    published: { id: done(0), headSha: R[r]?.commit ?? OLDER, image: R[r]?.image ?? IMAGE, endedAt: iso(52 * MIN) },
    warmTarget: (R[r]?.bytes ?? 0) * 1.2 + 4 * GIB <= 16 * GIB ? "tmpfs" : "pvc", warmTargetSource: "auto", bytes: R[r]?.bytes ?? null,
    nodes: nodesWith(r), of: fresh.length, ...over,
  });
  return {
    readAt: iso(40_000),
    nodes: NODES,
    placement: PLACEMENT,
    placementNote: null,
    writer: { env: "cluster", image: IMAGE },
    repos: [
      repo("deckcraft", { last: { id: done(1), state: "done", summary: "warm build published 18,204 files", headSha: R.deckcraft!.commit, endedAt: iso(3 * 60 * MIN) }, published: { id: done(1), headSha: R.deckcraft!.commit, image: IMAGE, endedAt: iso(3 * 60 * MIN) } }),
      repo("designcraft", {
        freshness: "behind", head: "77aa0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", coverage: "added",
        last: { id: ids.failed[0] ?? 2, state: "failed", summary: "build failed: error[E0432]: unresolved import `craft_libs::gpu`", headSha: "77aa0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", endedAt: iso(25 * MIN) },
        published: { id: done(2), headSha: R.designcraft!.commit, image: IMAGE, endedAt: iso(26 * 60 * MIN) },
      }),
      repo("pdfcraft", { freshness: "behind", head: "f00dfeed1234567890abcdef1234567890abcdef", last: { id: done(3), state: "running", summary: null, headSha: "f00dfeed1234567890abcdef1234567890abcdef", endedAt: null }, published: { id: done(3), headSha: R.pdfcraft!.commit, image: IMAGE, endedAt: iso(7 * 60 * MIN) } }),
      repo("photocraft", { warmTarget: "pvc", warmTargetSource: "operator" }),
      repo("wordcraft", { freshness: "image", published: { id: done(4), headSha: R.wordcraft!.commit, image: OLD_IMAGE, endedAt: iso(4 * 24 * 60 * MIN) }, last: { id: done(4), state: "done", summary: "warm build published 22,940 files", headSha: R.wordcraft!.commit, endedAt: iso(4 * 24 * 60 * MIN) } }),
      repo("lightcraft", { freshness: "never", last: { id: done(5), state: "queued", summary: null, headSha: "9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b", endedAt: null }, published: null, warmTarget: "none", bytes: null, nodes: 0 }),
      repo("gridcraft", { freshness: "never", coverage: "excluded", last: null, published: null, warmTarget: "none", bytes: null, nodes: 0 }),
    ],
    mirror: { allowlist: ["storytold/craft-libs", "storytold/egui", "storytold/winit"], error: null, readAt: iso(3 * MIN), envs: ["cluster"] },
  };
}
