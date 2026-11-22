// Area lists (one saved version per change), item areas and model proposals. Queries over the
// tables area_lists, item_areas and area_proposals; the assignment itself is in assign.ts.
import type { NotNull } from "kysely";
import { AREAS_MAX, AREA_DESCRIPTION_MAX, AREA_NAME_MAX, NONE_OF_THESE, type Area } from "./types.ts";
import type { Db } from "../db/index.ts";
import { cols, excluded, inList } from "../db/kx.ts";

export class AreaError extends Error {}

const now = () => new Date().toISOString();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// "none" names the items without an area in item filters (`area=none`), so no area may take it.
const reserved = (name: string) => same(name, NONE_OF_THESE) || same(name, "none");

export function cleanName(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, AREA_NAME_MAX) : "";
}
export function cleanDescription(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, AREA_DESCRIPTION_MAX) : "";
}

/** A list with unusable and repeated entries dropped. Used on model output; operator edits go through `editAreas`, which refuses them. */
export function lenientAreas(v: unknown, max = AREAS_MAX): Area[] {
  const out: Area[] = [];
  if (!Array.isArray(v)) return out;
  for (const o of v as Record<string, unknown>[]) {
    const name = cleanName(o?.name), description = cleanDescription(o?.description);
    if (!name || !description || reserved(name) || out.some((a) => same(a.name, name))) continue;
    out.push({ name, description });
    if (out.length >= max) break;
  }
  return out;
}

export type AreaList = { repo: string; version: number; areas: Area[]; at: string; by: string | null; note: string | null };

export async function currentList(db: Db, repo: string): Promise<AreaList | null> {
  const r = await db.get(db.k.selectFrom("area_lists").select(["version", "areas", "at", "by", "note"]).where("repo", "=", repo).orderBy("version", "desc").limit(1));
  return r ? { repo, version: r.version, areas: JSON.parse(r.areas) as Area[], at: r.at, by: r.by, note: r.note } : null;
}

export async function listVersions(db: Db, repo: string): Promise<Omit<AreaList, "repo">[]> {
  return (await db.all(db.k.selectFrom("area_lists").select(["version", "areas", "at", "by", "note"]).where("repo", "=", repo).orderBy("version", "desc")))
    .map((r) => ({ version: r.version, areas: JSON.parse(r.areas) as Area[], at: r.at, by: r.by, note: r.note }));
}

/**
 * Saves `areas` as the repo's next version. `moved` says where items of a changed area go: a new name
 * (rename, merge) or null (removed: the item becomes unassigned and is asked again). Items whose area is
 * still in the list move to the new version; unassigned ones stay on the version they were asked against.
 */
async function save(db: Db, repo: string, areas: Area[], by: string | null, note: string, moved: Map<string, string | null>): Promise<number> {
  if (areas.length > AREAS_MAX) throw new AreaError(`a list holds at most ${AREAS_MAX} areas`);
  return await db.write(async () => {
    const version = ((await currentList(db, repo))?.version ?? 0) + 1;
    await db.run(db.k.insertInto("area_lists").values({ repo, version, areas: JSON.stringify(areas), at: now(), by, note }));
    for (const [from, to] of moved) {
      // An operator's choice of a removed area is dropped, so the item is asked again.
      if (to === null) await db.run(db.k.deleteFrom("item_areas").where("repo", "=", repo).where("area", "=", from).where("source", "=", "operator"));
      await db.run(db.k.updateTable("item_areas").set({ area: to }).where("repo", "=", repo).where("area", "=", from));
    }
    // A pass that was running during the edit may have written a name that is gone: unassign it. Rows with a name in the list move to the new version.
    const names = areas.map((a) => a.name);
    if (names.length) await db.run(db.k.updateTable("item_areas").set({ area: null }).where("repo", "=", repo).where("area", "is not", null).where(inList(db, "area", names, "text", true)));
    await db.run(db.k.updateTable("item_areas").set({ list_version: version }).where("repo", "=", repo).where(inList(db, "area", names)));
    return version;
  });
}

export type AreaEdit =
  | { op: "add"; name: string; description: string }
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; from: string; into: string }
  | { op: "remove"; name: string }
  | { op: "describe"; name: string; description: string }
  /** The whole list, as when an operator accepts a proposal (possibly edited). */
  | { op: "replace"; areas: Area[] };

const find = (areas: Area[], name: string): number => {
  const i = areas.findIndex((a) => same(a.name, name));
  if (i < 0) throw new AreaError(`there is no area "${name}"`);
  return i;
};

function validName(areas: Area[], v: unknown, except?: string): string {
  const name = cleanName(v);
  if (!name) throw new AreaError("an area needs a name");
  if (reserved(name)) throw new AreaError(`"${name}" is not an area name`);
  if (areas.some((a) => same(a.name, name) && !(except && same(a.name, except)))) throw new AreaError(`there is already an area "${name}"`);
  return name;
}

function validDescription(v: unknown): string {
  const d = cleanDescription(v);
  if (!d) throw new AreaError("an area needs a one-line description");
  return d;
}

/** Applies one edit to the current list and saves the result as a new version. Returns the version. */
export async function editAreas(db: Db, repo: string, edit: AreaEdit, by: string | null): Promise<number> {
  if (!await db.get(db.k.selectFrom("tracked_repos").select("name").where("name", "=", repo))) throw new AreaError(`${repo} is not tracked`);
  const areas = ((await currentList(db, repo))?.areas ?? []).map((a) => ({ ...a }));
  const moved = new Map<string, string | null>();
  let note: string;
  switch (edit.op) {
    case "add": {
      const name = validName(areas, edit.name);
      areas.push({ name, description: validDescription(edit.description) });
      note = `added ${name}`;
      break;
    }
    case "rename": {
      const i = find(areas, edit.from), old = areas[i]!.name;
      const name = validName(areas, edit.to, old);
      areas[i]!.name = name;
      if (name !== old) moved.set(old, name);
      note = `renamed ${old} to ${name}`;
      break;
    }
    case "merge": {
      const i = find(areas, edit.from), j = find(areas, edit.into);
      if (i === j) throw new AreaError("merge two different areas");
      moved.set(areas[i]!.name, areas[j]!.name);
      note = `merged ${areas[i]!.name} into ${areas[j]!.name}`;
      areas.splice(i, 1);
      break;
    }
    case "remove": {
      const i = find(areas, edit.name);
      moved.set(areas[i]!.name, null);
      note = `removed ${areas[i]!.name}`;
      areas.splice(i, 1);
      break;
    }
    case "describe": {
      const i = find(areas, edit.name);
      areas[i]!.description = validDescription(edit.description);
      note = `edited the description of ${areas[i]!.name}`;
      break;
    }
    case "replace": {
      const next: Area[] = [];
      for (const a of edit.areas) next.push({ name: validName(next, a.name), description: validDescription(a.description) });
      if (!next.length) throw new AreaError("a list needs at least one area");
      for (const a of areas) if (!next.some((n) => same(n.name, a.name))) moved.set(a.name, null);
      // A name kept with other capitalisation is the same area.
      for (const a of areas) { const n = next.find((x) => same(x.name, a.name)); if (n && n.name !== a.name) moved.set(a.name, n.name); }
      areas.splice(0, areas.length, ...next);
      note = "saved a new list";
      break;
    }
  }
  if (areas.length > AREAS_MAX) throw new AreaError(`a list holds at most ${AREAS_MAX} areas`);
  return await save(db, repo, areas, by, note, moved);
}

export type ItemArea = { area: string | null; source: string; confidence: number | null; listVersion: number; at: string };

export async function itemAreaOf(db: Db, repo: string, number: number): Promise<ItemArea | null> {
  const r = await db.get(db.k.selectFrom("item_areas").select(["area", "source", "confidence", "list_version", "at"]).where("repo", "=", repo).where("number", "=", number));
  return r ? { area: r.area, source: r.source, confidence: r.confidence, listVersion: r.list_version, at: r.at } : null;
}

/** The item's area name, or null when it has none. */
export const areaNameOf = async (db: Db, repo: string, number: number): Promise<string | null> => (await itemAreaOf(db, repo, number))?.area ?? null;

export async function setItemArea(db: Db, repo: string, number: number, area: string | null, source: "jev" | "haiku" | "operator", confidence: number | null, version: number): Promise<void> {
  await db.run(db.k.insertInto("item_areas").values({ repo, number, area, source, confidence, list_version: version, at: now() })
    .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(excluded(["area", "source", "confidence", "list_version", "at"]))));
}

/** Open items of the repo without an area: never asked, asked and answered "none of these", or unassigned by a removed area. */
export async function unassignedCount(db: Db, repo: string): Promise<number> {
  return (await db.get(db.k.selectFrom("items as i").leftJoin("item_areas as a", (j) => j.onRef("a.repo", "=", "i.repo").onRef("a.number", "=", "i.number"))
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("i.repo", "=", repo).where("i.state", "=", "OPEN").where("a.area", "is", null)))!.n;
}

export type AreaCount = { area: string; open: number };
export async function areaCounts(db: Db, repo: string): Promise<AreaCount[]> {
  return await db.all(db.k.selectFrom("items as i").innerJoin("item_areas as a", (j) => j.onRef("a.repo", "=", "i.repo").onRef("a.number", "=", "i.number"))
    .select((eb) => ["a.area as area", eb.fn.countAll<number>().as("open")]).$narrowType<{ area: NotNull }>()
    .where("i.repo", "=", repo).where("i.state", "=", "OPEN").where("a.area", "is not", null)
    .groupBy("a.area").orderBy("open", "desc").orderBy("a.area"));
}

export type ProposalArea = Area & { state: "open" | "accepted" | "ignored" };
export type Proposal = { id: number; repo: string; kind: "propose" | "suggest"; areas: ProposalArea[]; createdAt: string; createdBy: string | null; state: "open" | "accepted" | "dismissed"; decidedBy: string | null; decidedAt: string | null };
type ProposalRow = { id: number; repo: string; kind: string; areas: string; created_at: string; created_by: string | null; state: string; decided_by: string | null; decided_at: string | null };
const toProposal = (r: ProposalRow): Proposal => ({ id: r.id, repo: r.repo, kind: r.kind as Proposal["kind"], areas: JSON.parse(r.areas) as ProposalArea[], createdAt: r.created_at, createdBy: r.created_by, state: r.state as Proposal["state"], decidedBy: r.decided_by, decidedAt: r.decided_at });

/** Stores a model's proposal. An older open proposal of the same kind is dismissed: the new one replaces it. */
export async function saveProposal(db: Db, repo: string, kind: Proposal["kind"], areas: Area[], by: string | null): Promise<number> {
  await db.run(db.k.updateTable("area_proposals").set({ state: "dismissed", decided_at: now() }).where("repo", "=", repo).where("kind", "=", kind).where("state", "=", "open"));
  return (await db.get(db.k.insertInto("area_proposals")
    .values({ repo, kind, areas: JSON.stringify(areas.map((a) => ({ ...a, state: "open" }))), created_at: now(), created_by: by }).returning("id")))!.id;
}

export async function proposalsOf(db: Db, repo: string, open = true): Promise<Proposal[]> {
  return (await db.all(db.k.selectFrom("area_proposals").select(cols("area_proposals")).where("repo", "=", repo)
    .$if(open, (q) => q.where("state", "=", "open")).orderBy("id", "desc").limit(20))).map(toProposal);
}

export async function proposalById(db: Db, id: number): Promise<Proposal> {
  const r = await db.get(db.k.selectFrom("area_proposals").select(cols("area_proposals")).where("id", "=", id));
  if (!r) throw new AreaError(`there is no proposal ${id}`);
  return toProposal(r);
}

const settle = async (db: Db, p: Proposal, areas: ProposalArea[], by: string | null): Promise<void> => {
  const open = areas.some((a) => a.state === "open");
  const state = open ? "open" : areas.some((a) => a.state === "accepted") ? "accepted" : "dismissed";
  await db.run(db.k.updateTable("area_proposals").set({ areas: JSON.stringify(areas), state, decided_by: open ? null : by, decided_at: open ? null : now() }).where("id", "=", p.id));
};

/** Accepts a whole-list proposal, as stored or with the operator's edits. Returns the new list version. */
export async function acceptProposal(db: Db, id: number, by: string | null, edited?: Area[]): Promise<number> {
  const p = await proposalById(db, id);
  if (p.kind !== "propose" || p.state !== "open") throw new AreaError("this proposal is not open");
  const version = await editAreas(db, p.repo, { op: "replace", areas: edited ?? p.areas }, by);
  await db.run(db.k.updateTable("area_proposals").set({ state: "accepted", decided_by: by, decided_at: now() }).where("id", "=", id));
  return version;
}

export async function dismissProposal(db: Db, id: number, by: string | null): Promise<void> {
  const p = await proposalById(db, id);
  if (p.state !== "open") throw new AreaError("this proposal is not open");
  await db.run(db.k.updateTable("area_proposals").set({ state: "dismissed", decided_by: by, decided_at: now() }).where("id", "=", id));
}

/** Accepts the named areas of a suggestion (one new list version) and ignores `ignore`. Returns the version, or null when nothing was accepted. */
export async function decideSuggestion(db: Db, id: number, by: string | null, accept: string[], ignore: string[] = []): Promise<number | null> {
  const p = await proposalById(db, id);
  if (p.kind !== "suggest" || p.state !== "open") throw new AreaError("this suggestion is not open");
  const pick = (names: string[]) => names.map((n) => { const a = p.areas.find((x) => x.state === "open" && same(x.name, n)); if (!a) throw new AreaError(`"${n}" is not an open suggestion`); return a; });
  const take = pick(accept), skip = pick(ignore);
  let version: number | null = null;
  if (take.length) {
    const current = (await currentList(db, p.repo))?.areas ?? [];
    version = await editAreas(db, p.repo, { op: "replace", areas: [...current, ...take.map(({ name, description }) => ({ name, description }))] }, by);
  }
  await settle(db, p, p.areas.map((a) => (take.includes(a) ? { ...a, state: "accepted" as const } : skip.includes(a) ? { ...a, state: "ignored" as const } : a)), by);
  return version;
}
