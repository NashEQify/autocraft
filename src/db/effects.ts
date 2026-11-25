// External effects (GitHub calls, model calls, build launches, child processes, HTTP) as the database sees them: each is
// counted in the current `db.meter`, and one made inside a database transaction is reported, since a transaction holds
// its locks (and on Postgres a snapshot) while the effect waits on the network.
import { callSite, Handle, siteError } from "./handle.ts";
import type { Db } from "./index.ts";

export type EffectKind = "github-write" | "github-read" | "model-call" | "build-launch" | "process" | "http";

/** How often one site's effect inside a transaction is logged again. */
const LOG_EVERY_MS = 60 * 60 * 1000;
/** Most sites kept: they are code locations, so a few dozen at most. */
const MAX_SITES = 200;

export interface EffectInTx {
  readonly site: string;
  readonly kind: EffectKind;
  readonly count: number;
  readonly lastAt: number;
}

let inTxCount = 0;
const inTxSites = new Map<string, { kind: EffectKind; count: number; lastAt: number; loggedAt: number }>();

/**
 * Tells the database layer that the caller is about to make an external effect on behalf of work on `db`. Call it before
 * the effect's first await, in the wrapper that makes it. It counts the effect in the current `db.meter`. Inside a
 * transaction it counts the call site (`effectsInTx`) and logs it, once per site per hour.
 */
export function effect(db: Db, kind: EffectKind, site?: string): void {
  if (db instanceof Handle) db.noteEffect();
  if (!db.inTransaction()) return;
  const where = site ?? callSite(siteError());
  const now = Date.now();
  inTxCount++;
  let s = inTxSites.get(where);
  if (!s && inTxSites.size < MAX_SITES) inTxSites.set(where, (s = { kind, count: 0, lastAt: now, loggedAt: 0 }));
  if (!s) return;
  s.count++;
  s.lastAt = now;
  if (now - s.loggedAt < LOG_EVERY_MS) return;
  s.loggedAt = now;
  console.warn(`db: effect "${kind}" inside a database transaction (${where})`);
}

/** Effects this process made inside a database transaction: the total and each site, for the health checks. */
export function effectsInTx(): { count: number; sites: EffectInTx[] } {
  return { count: inTxCount, sites: [...inTxSites].map(([site, s]) => ({ site, kind: s.kind, count: s.count, lastAt: s.lastAt })) };
}
