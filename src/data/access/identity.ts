// The process cache of the GitHub identity used by GitHub reads (M03 access-a). Postgres: invalidated by the `settings` live
// topic plus a 10 s safety re-read. SQLite: the settings counter read stays inside this file.
import type { Db, Subscription } from "../../db/index.ts";

/** Whether GitHub reads go through the App identity; 0 statements when cached. */
export async function readsUseApp(db?: Db): Promise<boolean> {
  throw new Error("not built: access.readsUseApp");
}

/** The writer's own process learns of an identity switch after the commit. */
export function noteIdentity(app: boolean): void {
  throw new Error("not built: access.noteIdentity");
}

/** Started once per process by `openDb`: subscribes to the `settings` topic and drops the cache on change. */
export function watchIdentity(db: Db): Subscription {
  throw new Error("not built: access.watchIdentity");
}
