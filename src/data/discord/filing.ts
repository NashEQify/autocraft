// Filing-only repos, hidden repos and issues filed from Discord (`discord_filing_repos`, `discord_hidden_repos`, `discord_filed`).
import type { Db } from "../../db/index.ts";
import type { BotRepo, FiledRow, FilingCounts, FilingFacts, FilingRepo, FilingReservation } from "./types.ts";

/** Filing-only repos ordered by owner and name. */
export async function listFilingRepos(db: Db): Promise<FilingRepo[]> { throw new Error("not built: discord.listFilingRepos"); }
/** Filing repos by name, case-insensitive; key is the lowercase name. */
export async function loadFilingReposNamed(db: Db, names: string[]): Promise<Map<string, FilingRepo>> { throw new Error("not built: discord.loadFilingReposNamed"); }
/** Hidden repo names. */
export async function listHiddenRepos(db: Db): Promise<Set<string>> { throw new Error("not built: discord.listHiddenRepos"); }
/** Both lists in one wave. */
export async function loadFilingState(db: Db): Promise<{ filing: FilingRepo[]; hidden: Set<string> }> { throw new Error("not built: discord.loadFilingState"); }
/** Inserts a filing repo and its `discord-filing-add` audit row in one transaction. */
export async function saveFilingRepo(db: Db, row: { owner: string; name: string; by: string; at: string; audit: { mode: string; why?: string } }): Promise<void> { throw new Error("not built: discord.saveFilingRepo"); }
/** `DELETE ... RETURNING` plus the `discord-filing-remove` audit row. */
export async function removeFilingRepo(db: Db, by: string, name: string): Promise<FilingRepo | null> { throw new Error("not built: discord.removeFilingRepo"); }
/** Hides (insert do nothing) or shows (delete) repos, with audit rows. */
export async function setHiddenRepos(db: Db, by: string, rows: { name: string; hidden: boolean; at: string }[]): Promise<void> { throw new Error("not built: discord.setHiddenRepos"); }
/** The three daily counts in one statement. */
export async function loadFilingCounts(db: Db, f: { sinceIso: string; login?: string; reporter?: string; repo: string }): Promise<FilingCounts> { throw new Error("not built: discord.loadFilingCounts"); }
/** One transaction: prunes rows older than `since`, then `INSERT ... SELECT ... WHERE counts < limits RETURNING id`; on zero rows one count read says which limit refused. */
export async function reserveFiling(db: Db, req: FilingReservation): Promise<{ slot: number } | { refused: "login" | "repo" }> { throw new Error("not built: discord.reserveFiling"); }
/** Records the issue number of a reserved slot. */
export async function setFiledNumber(db: Db, slot: number, number: number): Promise<void> { throw new Error("not built: discord.setFiledNumber"); }
/** Releases a reserved slot. */
export async function releaseFiling(db: Db, slot: number): Promise<void> { throw new Error("not built: discord.releaseFiling"); }
/** Recent filed issues (`number > 0`), newest first. */
export async function listRecentFiled(db: Db, limit: number): Promise<FiledRow[]> { throw new Error("not built: discord.listRecentFiled"); }
/** Deletes a reporter's filed rows; joins the caller's transaction. */
export async function forgetFiledOf(db: Db, reporter: string): Promise<number> { throw new Error("not built: discord.forgetFiledOf"); }
/** The repos the bot offers: tracked, public and filing-only, sorted; a tracked repo wins over a filing-only name. Pure. */
export function offeredRepos(o: { tracked: string[]; publicNames: string[]; hidden: ReadonlySet<string>; filing: FilingRepo[] }): BotRepo[] { throw new Error("not built: discord.offeredRepos"); }
/** The offered repo of that name, if any. Pure. */
export function botRepoOf(list: BotRepo[], name: string): BotRepo | undefined { throw new Error("not built: discord.botRepoOf"); }
/** The first refusal reason in order (not offered, identity not `app`, per-reporter, per-repo, daily writes), or null. Pure. */
export function filingRefusal(facts: FilingFacts): string | null { throw new Error("not built: discord.filingRefusal"); }
