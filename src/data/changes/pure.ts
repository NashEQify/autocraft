// Pure functions over loaded patch facts; no handle.
import type { CifixFacts, CifixRow, ConflictRow, FixupAtHead, FixupRow, LintFactOf, MadeBy, OutcomeRow, PatchFacts, PatchKind, PushEdge, TaskStates } from "./types.ts";

/** Review fix-up tries (source null, try states, minus hunk-header refusals). */
export function attemptsIn(rows: FixupRow[]): number { throw new Error("not built: changes.attemptsIn"); }
/** `source = 'operator'` rows in try states. */
export function operatorTriesIn(rows: FixupRow[]): number { throw new Error("not built: changes.operatorTriesIn"); }
/** Pre-merge fix-up rounds used. */
export function premergeFixUsedIn(rows: FixupRow[]): number { throw new Error("not built: changes.premergeFixUsedIn"); }
/** The conflict-merge bucket of a PR from its rows. */
export function conflictBucketOf(rows: ConflictRow[], now: number): string { throw new Error("not built: changes.conflictBucketOf"); }
/** Conflict-merge tries. */
export function triesIn(rows: ConflictRow[]): number { throw new Error("not built: changes.triesIn"); }
/** Conflict merges pushed since the start of the UTC day of `now`. */
export function mergesToday(rows: ConflictRow[], now: number): number { throw new Error("not built: changes.mergesToday"); }
/** When an unsent conflict ask may be retried, if one is waiting. */
export function conflictAskRetryAtOf(rows: ConflictRow[], head: string, now: number): string | null { throw new Error("not built: changes.conflictAskRetryAtOf"); }
/** The CI fix state at one head from the rows and the already-loaded task states. No query inside. */
export function cifixAt(rows: CifixRow[], head: string, now: number, tasks: TaskStates): CifixFacts { throw new Error("not built: changes.cifixAt"); }
/** The recorded final states of fix-ups at a head and the unsent-comment backoff. */
export function fixupAtHead(rows: FixupRow[], head: string, now: number): FixupAtHead { throw new Error("not built: changes.fixupAtHead"); }
/** The `base.lint` list: one entry per `linting` row, with `ended` from the loaded task state. */
export function lintOf(facts: PatchFacts, head: string, opts: { cifixHead: string; tasks: TaskStates }): LintFactOf[] { throw new Error("not built: changes.lintOf"); }
/** The head and the earlier heads our pushes moved it from, newest first. Takes one PR's edges. */
export function pushChainOf(edges: PushEdge[], head: string): string[] { throw new Error("not built: changes.pushChainOf"); }
/** Whether our push from `from` to `to` was a fix-up for the review's fixes or a base merge. */
export function ownPushKind(edges: PushEdge[], from: string, to: string): "fix-up for the review's fixes" | "base merge" | null { throw new Error("not built: changes.ownPushKind"); }
/** The commit of ours that made `head`: fix-up, else CI fix, else base merge. */
export function madeBy(edges: PushEdge[], head: string): MadeBy | null { throw new Error("not built: changes.madeBy"); }
/** Our conflict merge to `to` kept the diff the same. */
export function sameDiffMerge(edges: PushEdge[], to: string): boolean { throw new Error("not built: changes.sameDiffMerge"); }
/** `to` is the head of one of our plain fix-ups. */
export function ourPlainFixup(edges: PushEdge[], to: string): boolean { throw new Error("not built: changes.ourPlainFixup"); }
/** Rows in failed-try states created after `since`, counted per step. */
export function failuresSince(facts: PatchFacts, since: string): { step: "fix-up" | "CI fix"; count: number }[] { throw new Error("not built: changes.failuresSince"); }
/** Added and removed lines of a patch. */
export function patchLines(patch: string | null): number { throw new Error("not built: changes.patchLines"); }
/** The item bar's newest row of `kind` with unsent counts, computed in memory from loaded rows. */
export function outcomeRows(facts: PatchFacts, kind: PatchKind): OutcomeRow[] { throw new Error("not built: changes.outcomeRows"); }
