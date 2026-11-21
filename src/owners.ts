// Owner (GitHub org or user) of each repo. Repo names are unique across owners, so items keep
// the bare name as key; the owner is a property of the `repos` row. Repos without a row are storytold's.

// A structural type: the web build imports this module through the templates and has no node types.
type DatabaseSync = { prepare(sql: string): { all(...params: never[]): unknown[] } };

export const DEFAULT_OWNER = "storytold";
export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const REFRESH_MS = 30_000;
let cache = new Map<string, string>();
let source: DatabaseSync | null = null;
let loadedAt = 0;
// Counts loads. An async reload stores its rows only when no load started after it, so a reload whose read finished
// late never puts back an older owner list.
let loads = 0;

/** Reads the owners from the `repos` table; the most recently loaded database also refreshes the cache later. */
export function loadOwners(db: DatabaseSync): void {
  source = db;
  loads++;
  setOwners(db.prepare(OWNERS_SQL).all() as OwnerRow[]);
}

/** loadOwners() through the async handle, after a write to `repos`. The cache refreshes later from the connection loaded last. */
export async function reloadOwners(db: { prepare(sql: string): { all(...params: never[]): Promise<unknown[]> } }): Promise<void> {
  const mine = ++loads;
  const rows = await db.prepare(OWNERS_SQL).all() as OwnerRow[];
  if (mine === loads) setOwners(rows);
}

const OWNERS_SQL = "SELECT name, owner FROM main.repos";
type OwnerRow = { name: string; owner: string | null };

function setOwners(rows: OwnerRow[]): void {
  const next = new Map<string, string>();
  for (const r of rows) if (r.owner) next.set(r.name, r.owner);
  cache = next;
  loadedAt = Date.now();
}

export function ownerOf(repo: string): string {
  if (source && Date.now() - loadedAt > REFRESH_MS) {
    try { loadOwners(source); } catch { source = null; }
  }
  return cache.get(repo) ?? DEFAULT_OWNER;
}

/** The owners ownerOf answers with, as one string: changes when the cache does. */
export function ownersStamp(): string {
  ownerOf("");
  return JSON.stringify([...cache].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** `owner/name` of a tracked repo name. */
export const slugOf = (repo: string): string => `${ownerOf(repo)}/${repo}`;

/** Splits `owner/name` or a bare name (storytold's). */
export function splitSlug(s: string): { owner: string; name: string } {
  const i = s.indexOf("/");
  return i < 0 ? { owner: DEFAULT_OWNER, name: s } : { owner: s.slice(0, i), name: s.slice(i + 1) };
}

/** Every owner with a tracked repo, plus the default one. */
export function trackedOwners(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT COALESCE(r.owner, ?) AS owner FROM main.tracked_repos t LEFT JOIN main.repos r ON r.name = t.name",
  ).all(DEFAULT_OWNER as never) as { owner: string }[];
  return [...new Set([DEFAULT_OWNER, ...rows.map((r) => r.owner)])].sort();
}

/** Test hook: forgets the cached owners and the database. */
export function resetOwners(): void {
  cache = new Map();
  source = null;
  loadedAt = 0;
}
