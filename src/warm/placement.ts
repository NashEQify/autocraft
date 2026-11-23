// Which nodes keep each warm key. The runner places every covered repo's key (src/build/warm-queue.ts warmCoverage) on
// PLACEMENT_COPIES nodes, so a build has a choice of warm node and one node going away leaves a copy, without every node
// holding every repo. It writes the result to the ConfigMap `warm-placement` (data key `placement.json`) beside the
// nodes' status ConfigMaps; each node's warm-sync agent mounts it and keeps only the keys placed on its node
// (placedAssign). Without a placement (the ConfigMap is missing, empty or malformed) an agent keeps every key that
// `warm-assign` lists, as before.
//
// Placement is sticky: a key stays on the nodes it was placed on while they have room and reported within the agents'
// grace period (a node that missed a few status writes keeps its keys), since moving it means downloading the whole
// version again. Only nodes with a fresh status take new keys.
// Otherwise it goes to the nodes with the most room left: free disk plus the warm
// bytes the node holds now, at most the `warm-assign` cap, less what keys placed before it take. Keys are placed largest
// first; a key whose version is not published yet counts 0 bytes until it is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyStatus } from "./sync-agent.ts";
import { WARM_KEY } from "../worker/warm.ts";

export const PLACEMENT_CONFIGMAP = "warm-placement";
export const PLACEMENT_DATA_KEY = "placement.json";
export const PLACEMENT_COPIES = 2;
/** A node keeps this share of its disk free of warm versions: builds and images use it too. */
export const PLACEMENT_DISK_SHARE = 0.85;

/** Keys in priority order (the agents' cap drops the lowest first), each with the nodes that keep it. */
export type Placement = { version: 1; keys: { key: string; nodes: string[] }[] };

export type PlaceNode = { node: string; fresh: boolean; fs: { sizeBytes: number; usedBytes: number }; warmBytes: { current: number }; keys: Record<string, KeyStatus> };

/** The placement in `placement.json`, or null when there is none or it is malformed. */
export function parsePlacement(text: string | null | undefined): Placement | null {
  try {
    const p = JSON.parse(text ?? "") as Placement;
    if (p?.version !== 1 || !Array.isArray(p.keys)) return null;
    for (const k of p.keys) if (typeof k?.key !== "string" || !WARM_KEY.test(k.key) || k.key === "blobs" || !Array.isArray(k.nodes) || k.nodes.some((n) => typeof n !== "string")) return null;
    return p;
  } catch {
    return null;
  }
}

/** The placement in a mounted `warm-placement` ConfigMap dir; null without one (an optional volume that is absent). */
export function readPlacementDir(dir: string): Placement | null {
  let text: string;
  try {
    text = readFileSync(join(dir, PLACEMENT_DATA_KEY), "utf8");
  } catch {
    return null;
  }
  return parsePlacement(text);
}

/** The keys an agent on `node` keeps: those placed on it, in priority order; `assigned` (warm-assign) without a placement. */
export function placedKeys(assigned: string[], p: Placement | null, node: string): string[] {
  return p ? p.keys.filter((k) => k.nodes.includes(node)).map((k) => k.key) : assigned;
}

/**
 * Places `keys` (priority order, with their published bytes or null) on the reporting `nodes`. `prev` is the placement
 * in force; `capBytes` the agents' per-node cap (warm-assign maxGbPerNode), null when unknown.
 */
export function placeKeys(keys: { key: string; bytes: number | null }[], nodes: PlaceNode[], prev: Placement | null, capBytes: number | null, copies = PLACEMENT_COPIES): Placement {
  const left = new Map(nodes.map((n) => {
    const room = Math.max(0, n.fs.sizeBytes * PLACEMENT_DISK_SHARE - n.fs.usedBytes) + n.warmBytes.current;
    return [n.node, Math.min(room, capBytes ?? Infinity)];
  }));
  const before = new Map((prev?.keys ?? []).map((k) => [k.key, k.nodes]));
  const placed = new Map<string, string[]>();
  for (const { key, bytes } of [...keys].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.key.localeCompare(b.key))) {
    const need = bytes ?? 0;
    const fits = (n: string) => (left.get(n) ?? -1) >= need;
    const holding = nodes.filter((n) => n.fresh && n.keys[key]).map((n) => n.node);
    const byRoom = nodes.filter((n) => n.fresh).map((n) => n.node).sort((a, b) => left.get(b)! - left.get(a)! || a.localeCompare(b));
    const order = [...new Set([...(before.get(key) ?? []), ...holding, ...byRoom])].filter((n) => left.has(n));
    // Nodes with room first, in the order above; when fewer have room, the roomiest others (their agents report the cap).
    const chosen = [...new Set([...order.filter(fits), ...byRoom.filter((n) => !fits(n))])].slice(0, copies);
    for (const n of chosen) left.set(n, left.get(n)! - need);
    placed.set(key, chosen.sort());
  }
  return { version: 1, keys: keys.map(({ key }) => ({ key, nodes: placed.get(key) ?? [] })) };
}
