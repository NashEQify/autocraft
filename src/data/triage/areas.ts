// Areas, area lists and proposals (M09 triage-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { AreaDue, AreaEdit, AreaList, AreaOverview, AreaProposal, AreaVersion, AskedList, ItemArea, ItemAreaPut, RefKey, SampleItem } from "./types.ts";

/** Current version per repo (`row_number()` over `version DESC`). */
export async function loadAreaLists(db: Db, repos: string[] | "all"): Promise<Map<string, AreaList>> {
  throw new Error("not built: triage.loadAreaLists");
}

/** Every version of a repo's list, newest first. */
export async function listAreaVersions(db: Db, repo: string): Promise<AreaVersion[]> {
  throw new Error("not built: triage.listAreaVersions");
}

/** Area of each item. */
export async function loadItemAreas(db: Db, keys: KeySource): Promise<Map<RefKey, ItemArea>> {
  throw new Error("not built: triage.loadItemAreas");
}

/** Current list, counts per area, unassigned count and open proposals; four statements in one wave. */
export async function loadAreaOverview(db: Db, repo: string): Promise<AreaOverview> {
  throw new Error("not built: triage.loadAreaOverview");
}

/** Open tracked items of repos with a list, left-joined to `item_areas`, with the workflow scope and not-own-integration fragments embedded. */
export async function loadAreaDue(db: Db, o: { repo?: string; refs?: KeySource; rescan?: boolean; limit: number; first?: ReadonlySet<RefKey> }): Promise<AreaDue[]> {
  throw new Error("not built: triage.loadAreaDue");
}

/** Due issues and all lists in one wave. */
export async function loadAreaDueLists(db: Db, refs: KeySource): Promise<Map<RefKey, AskedList>> {
  throw new Error("not built: triage.loadAreaDueLists");
}

/** Validates (pure), inserts a version, deletes operator rows of removed areas, moves renames and merges with `updateFrom`, unassigns names no longer listed; one `db.write` bounded by the list size. */
export async function editAreas(db: Db, repo: string, edit: AreaEdit, by: string | null): Promise<number> {
  throw new Error("not built: triage.editAreas");
}

/** Guard read of the current version, then a multi-row upsert; writes nothing and reports `stale` when the list moved on. */
export async function saveItemAreas(db: Db, repo: string, version: number, rows: ItemAreaPut[]): Promise<{ stored: number; stale: boolean }> {
  throw new Error("not built: triage.saveItemAreas");
}

/** A repo's proposals. */
export async function loadProposals(db: Db, repo: string, open?: boolean): Promise<AreaProposal[]> {
  throw new Error("not built: triage.loadProposals");
}

/** One proposal. */
export async function loadProposal(db: Db, id: number): Promise<AreaProposal | undefined> {
  throw new Error("not built: triage.loadProposal");
}

/** Dismisses older open proposals of the kind, inserts and returns the id. */
export async function saveProposal(db: Db, repo: string, kind: string, areas: unknown, by: string): Promise<number> {
  throw new Error("not built: triage.saveProposal");
}

/** Joins `editAreas`; one `db.write`. */
export async function acceptProposal(db: Db, id: number, by: string, edited?: unknown): Promise<void> {
  throw new Error("not built: triage.acceptProposal");
}

/** Dismisses one proposal. */
export async function dismissProposal(db: Db, id: number, by: string): Promise<void> {
  throw new Error("not built: triage.dismissProposal");
}

/** Accepts or dismisses a suggestion; one `db.write`. */
export async function decideSuggestion(db: Db, id: number, by: string, accept: boolean, ignore?: boolean): Promise<void> {
  throw new Error("not built: triage.decideSuggestion");
}

/** Open item titles for `areas/propose.ts`. */
export async function loadOpenTitles(db: Db, repo: string, limit: number): Promise<string[]> {
  throw new Error("not built: triage.loadOpenTitles");
}

/** Open items with no area under the list version. */
export async function loadUnassignedSample(db: Db, repo: string, version: number, limit: number): Promise<SampleItem[]> {
  throw new Error("not built: triage.loadUnassignedSample");
}
