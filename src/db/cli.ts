// `autocraft-server db copy|verify`: whole-database copies between SQLite and Postgres, and digest comparisons.
import { parseArgs } from "node:util";

const USAGE = `usage:
  autocraft-server db copy --from <sqlite path|postgres url> --to <sqlite path|postgres url> [--verify] [--batch N] [--replace] [--skip-extra]
  autocraft-server db verify --from <...> --to <...> [--batch N] [--skip-extra]`;

export const commands = {
  db: {
    summary: "db copy|verify --from <db> --to <db>: copy a whole database between SQLite and Postgres; compare two by row digests",
    run: async (args: string[]) => {
      const [sub, ...rest] = args;
      let values: { from?: string; to?: string; verify?: boolean; replace?: boolean; batch?: string; "skip-extra"?: boolean };
      try {
        ({ values } = parseArgs({
          args: rest,
          options: { from: { type: "string" }, to: { type: "string" }, verify: { type: "boolean" }, replace: { type: "boolean" }, batch: { type: "string" }, "skip-extra": { type: "boolean" } },
          strict: true,
        }));
      } catch (e) {
        console.error(`${(e as Error).message}\n${USAGE}`);
        process.exit(2);
      }
      if ((sub !== "copy" && sub !== "verify") || !values.from || !values.to || (sub === "verify" && (values.verify || values.replace))) {
        console.error(USAGE);
        process.exit(2);
      }
      const batch = values.batch === undefined ? undefined : Number(values.batch);
      const { copyDatabase, verifyDatabases } = await import("./copy.ts");
      if (sub === "verify") {
        const r = await verifyDatabases(values.from, values.to, { batch, skipExtra: values["skip-extra"] });
        process.exit(r.ok ? 0 : 1);
      }
      const r = await copyDatabase({ from: values.from, to: values.to, verify: values.verify, replace: values.replace, batch, skipExtra: values["skip-extra"] });
      process.exit(r.verify && !r.verify.ok ? 1 : 0);
    },
  },
};
