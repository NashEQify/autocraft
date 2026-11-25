// Fix rounds and the fix log (package security).
import type { Db } from "../../db/index.ts";
import type { FindingKey, LogRound, RoundRow, SessionRow } from "./types.ts";

/** Live rounds per finding, ordered by round. */
export async function loadRounds(db: Db, keys: FindingKey[]): Promise<Map<FindingKey, RoundRow[]>> { throw new Error("not built: security.loadRounds"); }
/** The fix log per finding, ordered by attempt and round. */
export async function loadRoundLog(db: Db, keys: FindingKey[]): Promise<Map<FindingKey, LogRound[]>> { throw new Error("not built: security.loadRoundLog"); }
/** Inserts or replaces a round. */
export async function saveRound(db: Db, r: RoundRow): Promise<void> { throw new Error("not built: security.saveRound"); }
/** Patches rounds, one statement per distinct patch shape. */
export async function markRounds(db: Db, rows: { repo: string; number: number; round: number; set: Partial<RoundRow> }[]): Promise<number> { throw new Error("not built: security.markRounds"); }
/** Logs the rounds (attempt = the finding's `fix_attempts`) and deletes them returning the stored sessions; the caller removes the session directories after commit. */
export async function clearRounds(db: Db, keys: FindingKey[]): Promise<{ sessions: string[] }> { throw new Error("not built: security.clearRounds"); }
/** Rounds with a stored session, for the session sweep; the waiting state is applied in pure code. Declared in the `changes` design. */
export async function loadFixSessionRows(db: Db): Promise<SessionRow[]> { throw new Error("not built: security.loadFixSessionRows"); }
/** Sets `session = NULL` on rounds. Declared in the `changes` design. */
export async function clearSessions(db: Db, rows: { repo: string; number: number; round: number }[]): Promise<number> { throw new Error("not built: security.clearSessions"); }
