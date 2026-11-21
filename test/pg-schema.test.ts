import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPgSchema, SchemaError, translateSqlite } from "../src/db/pg-schema.ts";

test("the Postgres schema translator refuses constructs outside its allowlist, and src/schema.pg.sql is current", () => {
  const refused = [
    "CREATE TABLE IF NOT EXISTS t (a TEXT, b INTEGER REFERENCES other(id))",
    "CREATE TABLE IF NOT EXISTS t (a TEXT, b NUMERIC)",
    "CREATE TABLE IF NOT EXISTS t (a TEXT); CREATE INDEX IF NOT EXISTS t_a ON t(json_extract(a, '$.x'))",
    // A hand-translated trigger whose SQLite body changed.
    "CREATE TABLE IF NOT EXISTS jobs (repo TEXT); CREATE TRIGGER IF NOT EXISTS jobs_ever AFTER INSERT ON jobs BEGIN SELECT 1; END",
  ];
  for (const sql of refused) {
    assert.throws(() => translateSqlite(sql), (e: unknown) => e instanceof SchemaError && e.message.includes("in statement:"), sql);
  }
  assert.equal(readFileSync(new URL("../src/schema.pg.sql", import.meta.url), "utf8"), renderPgSchema(), "run `pnpm pg-schema`");
});
