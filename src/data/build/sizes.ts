// Repository sizes (`build_sizes`) and warm gates (package build-b).
import type { Db } from "../../db/index.ts";
import type { RepoSizing, SizePatch, WarmFacts } from "./types.ts";

/** Sizes, the memory history of repos not in the TTL cache (one windowed select) and `warm_bytes`. Wave 1: 3 statements. */
export async function loadSizings(db: Db, repos: string[] | "all"): Promise<Map<string, RepoSizing>> { throw new Error("not built: build.loadSizings"); }
/** Upserts, resets or clears `build_sizes` rows with audit rows; `tidy` is part of the statement. */
export async function setSizes(db: Db, rows: SizePatch[], by: string): Promise<void> { throw new Error("not built: build.setSizes"); }
/** The warm gates' facts per covered repo: head, tasks of step `warm` at it, open warm tasks, newest `claimed_at`, forced rebuild keys. Wave 1: 4 statements. */
export async function loadWarmFacts(db: Db, repos: string[], o: { version: string; rev: number; image: string }): Promise<Map<string, WarmFacts>> { throw new Error("not built: build.loadWarmFacts"); }
/** Whether to queue or skip a warm build, from loaded facts. */
export function warmGate(f: WarmFacts, nowMs: number, taskId?: number): "queue" | "skip" { throw new Error("not built: build.warmGate"); }
/** The claim-time warm gate over loaded facts. */
export function warmClaimGate(f: WarmFacts, nowMs: number, taskId: number): "claim" | "wait" { throw new Error("not built: build.warmClaimGate"); }
/** `createTasks` for the warm builds plus the forced keys in `build_state`, in one write. Returns the task id per repo. */
export async function queueWarmTasks(db: Db, rows: { repo: string; head: string; image: string; force: boolean }[]): Promise<Map<string, number>> { throw new Error("not built: build.queueWarmTasks"); }
