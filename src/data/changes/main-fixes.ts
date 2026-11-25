// Default-branch fix rows (`main_fixes`).
import type { Db } from "../../db/index.ts";
import type { MainFixRow, RefKey } from "./types.ts";

type Head = { repo: string; headSha: string };

/** Rows at the given heads, or a repo's rows in `states` (optionally by verdict or head). 1 statement. */
export async function loadMainFixes(db: Db, q: { heads: Head[] } | { repo: string; states: string[]; verdict?: string; head?: string }): Promise<MainFixRow[]> { throw new Error("not built: changes.loadMainFixes"); }
/** What `mainFixDue` and `lintReady` need for every red head at once; key is `repo@headSha`. 3 statements. */
export async function loadMainFixDue(db: Db, heads: (Head & { running: boolean })[]): Promise<Map<string, { rows: { check: string; state: string }[]; lintingHeads: { headSha: string; lintTask: number | null }[]; staleNeedsFix: boolean }>> { throw new Error("not built: changes.loadMainFixDue"); }
/** The fix PRs of ours that exist, as refs. */
export async function loadMainFixPrs(db: Db, repos?: string[]): Promise<Set<RefKey>> { throw new Error("not built: changes.loadMainFixPrs"); }
/** The number of our own fix PR still open and created since `since`, joined to the mirror's open items. */
export async function loadOpenFixPr(db: Db, repo: string, since: string): Promise<number | null> { throw new Error("not built: changes.loadOpenFixPr"); }
/** Rows in a state. */
export async function countMainFixes(db: Db, f: { state: string }): Promise<number> { throw new Error("not built: changes.countMainFixes"); }
/** Multi-row upsert keyed by (repo, head, check); callers collect the rows of a head and write once. */
export async function saveMainFixes(db: Db, rows: MainFixRow[], at: string): Promise<void> { throw new Error("not built: changes.saveMainFixes"); }
