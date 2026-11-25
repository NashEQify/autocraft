// Query-count tests: a unit of work must issue the same number of statements whatever its size, apart from a fixed
// number per external effect (conventions 2.7: a guard read and a write around each GitHub write, model call or launch).
import assert from "node:assert/strict";
import type { Db, DbStats } from "../../src/db/index.ts";

/** One size of a unit: the handle it runs on, the work to meter, and what to close afterwards. */
export interface FlatUnit {
  db: Db;
  run(): Promise<unknown>;
  close?(): Promise<void>;
}

export interface FlatOptions {
  /** Statements each effect may add (default 2: the guard read before it and the write after it). */
  perEffect?: number;
}

/**
 * Runs `unit(small)` and `unit(large)` inside `db.meter` and asserts that the large run's statements, less `perEffect`
 * for each effect it counted, are no more than the small run's on the same terms. `unit(size)` prepares its data outside
 * the meter and should give both sizes the same starting state (a fresh database, or the same warm caches). Returns the
 * two counts for further relations.
 */
export async function expectFlat(unit: (size: number) => Promise<FlatUnit>, small: number, large: number, opts: FlatOptions = {}): Promise<{ small: DbStats; large: DbStats }> {
  assert.ok(large > small, `expectFlat: the large size (${large}) must exceed the small one (${small})`);
  const perEffect = opts.perEffect ?? 2;
  const measure = async (size: number): Promise<DbStats> => {
    const u = await unit(size);
    try {
      return (await u.db.meter(() => u.run())).stats;
    } finally {
      await u.close?.();
    }
  };
  const a = await measure(small);
  const b = await measure(large);
  const net = (s: DbStats): number => s.statements - perEffect * s.effects;
  assert.ok(
    net(b) <= net(a),
    `statements grow with size: ${b.statements} at size ${large} (${b.effects} effects) against ${a.statements} at size ${small} (${a.effects} effects), allowing ${perEffect} per effect`,
  );
  return { small: a, large: b };
}
