// Read-only item-timeline projection and reader-local OPEN transitions.
// No cache, collection, subscription or permission policy lives at module scope.
import type { Decision, ItemPageData, TimelineEntry } from "../../api/types.ts";

export const TIMELINE_OPEN_LIMIT = 512;
export const TIMELINE_EVENT_LIMIT = 4;
export const TIMELINE_READ_ERROR = "Could not read the item timeline. The decision and your draft are unaffected.";

export interface TimelineReference {
  repo: string;
  number: number;
}

export interface TimelineReadSnapshot {
  data: ItemPageData | undefined;
  loading: boolean;
  error: string | undefined;
}

export interface TimelineRow {
  key: string;
  text: string;
  actor: string;
  at: string;
  costUsd: number | null;
}

export interface TimelineModel {
  rows: TimelineRow[];
  empty: boolean;
}

/** Immutable OPEN-only memory: redundant opens do not refresh insertion age. */
export function changeTimelineOpen(ids: ReadonlySet<string>, id: string, open: boolean): ReadonlySet<string> {
  if (!id || ids.has(id) === open) return ids;
  const next = new Set(ids);
  if (open) {
    if (next.size >= TIMELINE_OPEN_LIMIT) {
      const oldest = next.values().next();
      if (!oldest.done) next.delete(oldest.value);
    }
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

/** Only the supplied own item reference; never infer a member from a batch or group. */
export function timelineReference(d: Pick<Decision, "repo" | "number">): TimelineReference | null {
  const { repo, number } = d;
  if (typeof repo !== "string" || repo.trim() === "" || typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  return { repo, number };
}

/** Gate the native hook's PUBLIC snapshot, without inventing inaccessible fetch/completion flags. */
export function timelineReadState(ref: TimelineReference, snapshot: TimelineReadSnapshot): "waiting" | "error" | "ready" {
  if (snapshot.error !== undefined) return "error";
  if (snapshot.loading) return "waiting";
  const data = snapshot.data;
  return data && data.repo === ref.repo && data.number === ref.number && Array.isArray(data.timeline) ? "ready" : "error";
}

/** Latest supplied positions, oldest first, including authorized conversations without mutating. */
export function timelineModel(entries: readonly TimelineEntry[]): TimelineModel {
  const rows: TimelineRow[] = [];
  const stop = Math.max(0, entries.length - TIMELINE_EVENT_LIMIT);
  for (let index = stop; index < entries.length; index++) {
    const entry = entries[index]!;
    rows.push({ key: JSON.stringify([index, entry.id]), text: entry.text, actor: entry.actor, at: entry.at, costUsd: entry.costUsd });
  }
  return { rows, empty: rows.length === 0 };
}
