// Quiet pull requests (`security_quiet_prs`) (package security).
import type { Db } from "../../db/index.ts";
import type { Ref } from "./types.ts";

/** The refs among the input that are quiet PRs. */
export async function loadQuiet(db: Db, refs: Ref[]): Promise<Set<Ref>> { throw new Error("not built: security.loadQuiet"); }
/** All quiet PRs, optionally of one repo. */
export async function listQuietPrs(db: Db, f?: { repo?: string }): Promise<Set<Ref>> { throw new Error("not built: security.listQuietPrs"); }
/** Remembers PRs as the quiet PR of a finding; called in the transaction that clears `fix_pr`. */
export async function addQuietPrs(db: Db, rows: { repo: string; pr: number; finding: number }[]): Promise<void> { throw new Error("not built: security.addQuietPrs"); }
