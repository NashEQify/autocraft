// New SQLite test databases start as copies of one database migrated once per test process, so each opens on the
// up-to-date path. Tests that exercise migrations create their old-schema file first and are not affected.
import { join } from "node:path";
import { connect, setNewDbSeed } from "../src/db.ts";
import { SCRATCH } from "./scratch.ts";

let template: string | undefined;
let building = false;

setNewDbSeed(() => {
  if (building) return undefined;
  if (!template) {
    building = true;
    try {
      const file = join(SCRATCH, "template.db");
      const db = connect(file);
      // Fold the WAL into the file so a plain file copy is the whole database.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      template = file;
    } finally {
      building = false;
    }
  }
  return template;
});
