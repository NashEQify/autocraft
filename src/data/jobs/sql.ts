// Statement pieces shared by the module's own files (not re-exported by index.ts).
import { sql, type RawBuilder } from "kysely";
import type { Db } from "../../db/index.ts";
import type { AnyEb } from "../../db/kx.ts";
import * as kx from "../../db/kx.ts";
import { hiddenRepos } from "../control/fragments.ts";
import type { HiddenRepos } from "./types.ts";

/** The size in bytes of the UTF-8 text in `col`, as `Buffer.byteLength` counts it. */
export const octets = (db: Db, col: string): RawBuilder<number> =>
  db.dialect === "postgres" ? sql<number>`octet_length(${sql.ref(col)})` : sql<number>`length(CAST(${sql.ref(col)} AS BLOB))`;

/** Whether a viewer filter applies (operators get an empty list without `visible`). */
export const hasFilter = (h: HiddenRepos | undefined): h is HiddenRepos => !!h && (!!h.visible || h.length > 0);

/** The job's repo (null for a job without one) is visible to the viewer. */
export const repoVisible = (db: Db, eb: AnyEb, col: string, h: HiddenRepos) => eb.or([eb(col, "is", null), hiddenRepos(db, col, h)]);

/** `NOW` as the text columns hold it. */
export const nowIso = (): string => new Date().toISOString();

/** The item a job names in its params. */
export const numberOf = (db: Db, col = "params") => kx.jsonNum(db, col, "$.number");
