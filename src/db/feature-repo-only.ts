// Once: the build features that had a global and a per-repo switch (`build_feature:<f>` and `build_feature:<f>:<repo>`)
// keep only the repo switch. A repo's switch stays on only where the global one was on too, then the global rows go.
// Runs on SQLite with backfill() (src/db.ts) and on Postgres inside migratePg's transaction (src/db/pg-triggers.ts); the
// FEATURES_REPO_ONLY_DONE marker makes a second run change nothing.
import type { DatabaseSync } from "node:sqlite";
import type { PgClient } from "./pg-triggers.ts";

/** Part of the Postgres stamp, so a database migrated before this code reaches the migration; the marker decides whether it runs. */
export const FEATURES_REPO_ONLY_VERSION = 1;
export const FEATURES_REPO_ONLY_DONE = "build_features_repo_only";

/** The features that had both switches when this migration was written (scan-tests was global only and keeps its row). */
const SCOPED = ["screenshots", "push-tests", "batch-build", "nightly", "pr-builds", "implement"];

const STATEMENTS = (main: string): string[] => {
  const undone = `NOT EXISTS (SELECT 1 FROM ${main}settings m WHERE m.key = '${FEATURES_REPO_ONLY_DONE}')`;
  return [
    ...SCOPED.flatMap((f) => {
      const prefix = `build_feature:${f}:`;
      return [
        `DELETE FROM ${main}settings WHERE substr(key, 1, ${prefix.length}) = '${prefix}' AND ${undone}
          AND NOT EXISTS (SELECT 1 FROM ${main}settings g WHERE g.key = 'build_feature:${f}' AND g.value = 'on')`,
        `DELETE FROM ${main}settings WHERE key = 'build_feature:${f}' AND ${undone}`,
      ];
    }),
    `INSERT INTO ${main}settings (key, value) VALUES ('${FEATURES_REPO_ONLY_DONE}', '1') ON CONFLICT (key) DO NOTHING`,
  ];
};

export function featuresRepoOnlySqlite(db: DatabaseSync): void {
  for (const q of STATEMENTS("main.")) db.exec(q);
}

export async function featuresRepoOnlyPg(client: PgClient): Promise<void> {
  for (const q of STATEMENTS("")) await client.query(q);
}
