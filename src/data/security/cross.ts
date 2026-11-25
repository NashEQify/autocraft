// reads: jobs.jobs
// The state of a scan's job, for reconcile: a cancelled job ends its scan as stopped, any other ended job as failed.
// Waiting on a jobs fragment that returns the state; until then this is the one cross-domain read of the module.
import type { AliasableExpression } from "kysely";
import * as kx from "../../db/kx.ts";

/** The state of the job in `jobIdRef` (null when there is none). */
export const jobStateOf = (eb: kx.AnyEb, jobIdRef: kx.Ex): AliasableExpression<string | null> =>
  kx.schemaEb(eb).selectFrom("main.jobs as jsx").select("jsx.state").where("jsx.id", "=", kx.exprOf(eb, jobIdRef)) as unknown as AliasableExpression<string | null>;
