// Reference passages a call has read (`remote_passages`) (package runners-b).
import type { Db } from "../../db/index.ts";
import type { NewPassage } from "./types.ts";

/** The number of passages a call and run have read. */
export async function loadPassageCount(db: Db, callId: number, runId: number | null): Promise<number> { throw new Error("not built: runners.loadPassageCount"); }
/** Multi-row insert of passages. */
export async function addPassages(db: Db, rows: NewPassage[]): Promise<void> { throw new Error("not built: runners.addPassages"); }
