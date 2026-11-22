// Writes src/schema.pg.sql from src/schema.sql (src/db/pg-schema.ts); `--check` exits 1 when the committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { renderPgSchema } from "../src/db/pg-schema.ts";

const file = new URL("../src/schema.pg.sql", import.meta.url);
const want = renderPgSchema();
if (process.argv.includes("--check")) {
  let have = "";
  try {
    have = readFileSync(file, "utf8");
  } catch {
    // missing counts as stale
  }
  if (have !== want) {
    console.error("src/schema.pg.sql is stale: run `pnpm pg-schema`");
    process.exit(1);
  }
} else writeFileSync(file, want);
