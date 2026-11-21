// Compares the SQLite schema (src/schema.sql plus the added columns and indexes in src/db.ts) with a Postgres database
// that src/schema.pg.sql was applied to: tables, views, columns and their types, indexes and triggers by name. Prints
// every difference, marks the documented ones, and exits 1 when any other difference remains.
//   node scripts/pg-schema-compare.ts postgres://user@host:port/db
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { ADDED_COLUMNS, ADDED_INDEXES, DROPPED_COLUMNS } from "../src/db.ts";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/pg-schema-compare.ts <postgres url>");
  process.exit(2);
}

type Side = { tables: Map<string, Map<string, string>>; views: Set<string>; indexes: Set<string>; triggers: Set<string> };

function sqliteSide(): Side {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8"));
  const cols = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; pk: number }[];
  for (const [t, c, type] of ADDED_COLUMNS) if (!cols(t).some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
  for (const [t, c] of DROPPED_COLUMNS) if (cols(t).some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
  for (const ix of ADDED_INDEXES) db.exec(ix);
  const master = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; sql: string | null }[];
  const side: Side = { tables: new Map(), views: new Set(), indexes: new Set(), triggers: new Set() };
  for (const m of master) {
    if (m.type === "table") side.tables.set(m.name, new Map(cols(m.name).map((c) => [c.name, c.type.split(" ")[0]!.toUpperCase()])));
    else if (m.type === "view") side.views.add(m.name);
    else if (m.type === "index" && m.sql) side.indexes.add(m.name);
    else if (m.type === "trigger") side.triggers.add(m.name);
  }
  return side;
}

async function pgSide(): Promise<Side & { identity: Set<string> }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const q = async <T>(text: string) => (await client.query(text)).rows as T[];
  const side = { tables: new Map<string, Map<string, string>>(), views: new Set<string>(), indexes: new Set<string>(), triggers: new Set<string>(), identity: new Set<string>() };
  for (const t of await q<{ table_name: string; table_type: string }>("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public'")) {
    if (t.table_type === "VIEW") side.views.add(t.table_name);
    else side.tables.set(t.table_name, new Map());
  }
  for (const c of await q<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_identity: string }>(
    "SELECT table_name, column_name, data_type, udt_name, is_identity FROM information_schema.columns WHERE table_schema = 'public'")) {
    side.tables.get(c.table_name)?.set(c.column_name, c.data_type === "USER-DEFINED" ? c.udt_name : c.data_type);
    if (c.is_identity === "YES") side.identity.add(`${c.table_name}.${c.column_name}`);
  }
  // Indexes that back a PRIMARY KEY or UNIQUE constraint have no counterpart by name in sqlite_master.
  for (const i of await q<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype IN ('p', 'u'))`)) side.indexes.add(i.indexname);
  for (const t of await q<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")) side.triggers.add(t.tgname);
  await client.end();
  return side;
}

const TYPES: Record<string, string[]> = { INTEGER: ["bigint"], TEXT: ["text", "citext"], REAL: ["double precision"], BLOB: ["bytea"] };
const BYTEA_TEXT = new Set(["agent_run_texts.prompt", "agent_run_texts.output"]);
const FTS = ["items_fts", "comments_fts"];
const FTS_SHADOW = /^(items|comments)_fts_(data|idx|docsize|config)$/;

const lite = sqliteSide();
const pgs = await pgSide();
const lines: { text: string; why: string | null }[] = [];
const diff = (text: string, why: string | null) => lines.push({ text, why });

for (const [t, cols] of lite.tables) {
  const other = pgs.tables.get(t);
  if (!other) {
    diff(`- table ${t}`, FTS.includes(t) ? "FTS5 table: a generated tsvector column fts on the base table" : FTS_SHADOW.test(t) ? "FTS5 shadow table" : null);
    continue;
  }
  for (const [c, type] of cols) {
    const pt = other.get(c);
    if (!pt) diff(`- column ${t}.${c}`, null);
    else if (BYTEA_TEXT.has(`${t}.${c}`) && pt === "bytea") diff(`~ column ${t}.${c} ${type} -> ${pt}`, "holds gzip bytes (src/agents/runs.ts packText)");
    else if (!(TYPES[type] ?? []).includes(pt)) diff(`~ column ${t}.${c} ${type} -> ${pt}`, null);
  }
  for (const c of other.keys()) {
    if (cols.has(c)) continue;
    const why = c === "rowid" && pgs.identity.has(`${t}.rowid`) ? "rowid table without an INTEGER PRIMARY KEY: identity column rowid"
      : c === "fts" && FTS.includes(`${t}_fts`) ? "generated tsvector column for full-text search" : null;
    diff(`+ column ${t}.${c}`, why);
  }
}
for (const t of pgs.tables.keys()) if (!lite.tables.has(t)) diff(`+ table ${t}`, null);
for (const v of lite.views) if (!pgs.views.has(v)) diff(`- view ${v}`, null);
for (const v of pgs.views) if (!lite.views.has(v)) diff(`+ view ${v}`, null);
for (const i of lite.indexes) if (!pgs.indexes.has(i)) diff(`- index ${i}`, null);
for (const i of pgs.indexes) if (!lite.indexes.has(i)) diff(`+ index ${i}`, FTS.includes(i) ? "GIN index on the fts column, named after the FTS5 table" : null);
for (const t of lite.triggers) if (!pgs.triggers.has(t)) diff(`- trigger ${t}`, /^(items|comments)_fts_a[idu]$/.test(t) ? "FTS5 sync trigger: the generated column needs none" : null);
for (const t of pgs.triggers) if (!lite.triggers.has(t)) diff(`+ trigger ${t}`, null);

for (const l of lines) console.log(`${l.text}${l.why ? `  [documented: ${l.why}]` : "  [UNEXPECTED]"}`);
const unexpected = lines.filter((l) => !l.why).length;
console.log(`tables ${lite.tables.size} sqlite / ${pgs.tables.size} postgres; ${lines.length} differences, ${unexpected} unexpected`);
process.exit(unexpected ? 1 : 0);
