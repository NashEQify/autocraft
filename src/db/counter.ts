// Totals of a handle's database traffic, per calling site: what a code path costs in round trips, rows, result bytes and
// write-lock time. Used by benchmarks and the latency work.
import type { Db } from "./index.ts";

export interface Counts {
  roundTrips: number;
  rows: number;
  bytes: number;
  ms: number;
  writeLockMs: number;
  maxWriteLockMs: number;
  sites: Map<string, { roundTrips: number; rows: number; bytes: number; ms: number }>;
}

/** Starts counting `db`'s traffic; `stop()` ends it. */
export function countQueries(db: Db): { counts: Counts; stop(): void } {
  const counts: Counts = { roundTrips: 0, rows: 0, bytes: 0, ms: 0, writeLockMs: 0, maxWriteLockMs: 0, sites: new Map() };
  const stop = db.observe((e) => {
    if (e.kind === "write-lock") {
      counts.writeLockMs += e.holdMs;
      counts.maxWriteLockMs = Math.max(counts.maxWriteLockMs, e.holdMs);
      return;
    }
    counts.roundTrips++;
    counts.rows += e.rows;
    counts.bytes += e.bytes;
    counts.ms += e.ms;
    let s = counts.sites.get(e.site);
    if (!s) counts.sites.set(e.site, (s = { roundTrips: 0, rows: 0, bytes: 0, ms: 0 }));
    s.roundTrips++;
    s.rows += e.rows;
    s.bytes += e.bytes;
    s.ms += e.ms;
  });
  return { counts, stop };
}
