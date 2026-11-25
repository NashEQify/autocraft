// Read models for views: timelines, activity events, trace signature, Main CI texts.
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { ModelCheckEventRow, ModelCheckRow, PatchCheckEventRow, PatchEventFilter, PatchEventRow, PatchSignature, PatchTimelineRow, RefKey } from "./types.ts";

/** Rows of all three kinds per PR; `reason` and `files` are blanked for viewers inside the loader. 3 statements. */
export async function loadPatchTimeline(db: Db, keys: KeySource, opts: { internals: boolean }): Promise<Map<RefKey, PatchTimelineRow[]>> { throw new Error("not built: changes.loadPatchTimeline"); }
/** Patch rows for the activity feed. 3 statements in one wave. */
export async function listPatchEvents(db: Db, f: PatchEventFilter): Promise<PatchEventRow[]> { throw new Error("not built: changes.listPatchEvents"); }
/** Model check rows for the activity feed and trace. */
export async function listModelCheckEvents(db: Db, f: PatchEventFilter): Promise<ModelCheckEventRow[]> { throw new Error("not built: changes.listModelCheckEvents"); }
/** Patch check rows for the activity feed and trace. */
export async function listPatchCheckEvents(db: Db, f: PatchEventFilter): Promise<PatchCheckEventRow[]> { throw new Error("not built: changes.listPatchCheckEvents"); }
/** The trace's "did anything change" probe for all keys in one wave. */
export async function loadPatchSignature(db: Db, keys: KeySource): Promise<Map<RefKey, PatchSignature>> { throw new Error("not built: changes.loadPatchSignature"); }
/** Main CI page text: fix states and PR number per default-branch head; key is `repo@headSha`. */
export async function loadMainFixStates(db: Db, heads: { repo: string; headSha: string }[]): Promise<Map<string, { states: string[]; prNumber: number | null }>> { throw new Error("not built: changes.loadMainFixStates"); }
/** The model checks recorded for one run, for linking tool uses to checks. */
export async function loadModelChecksOfRun(db: Db, runId: number): Promise<ModelCheckRow[]> { throw new Error("not built: changes.loadModelChecksOfRun"); }
