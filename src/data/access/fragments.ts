// Predicates other modules embed in their statements (src/data/** only).
import type { AliasableExpression, Expression, SqlBool } from "kysely";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";

const one = (eb: kx.AnyEb) => eb.lit(1).as("one");
const WRITE = ["write", "maintain", "admin"];

/** The `access.role` of the login in `loginCol`, or null. */
export const roleOfLogin = (db: Db, eb: kx.AnyEb, loginCol: kx.Ex): Expression<string | null> =>
  kx.schemaEb(eb).selectFrom("main.access as ar").select("ar.role").where(kx.ciEq(db, "ar.login", kx.exprOf(eb, loginCol))) as unknown as Expression<string | null>;

/** The login is an operator. */
export const isOperator = (db: Db, eb: kx.AnyEb, loginCol: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.access as ao").select(one(eb)).where(kx.ciEq(db, "ao.login", kx.exprOf(eb, loginCol))).where("ao.role", "=", "operator"));

/** The login is an operator or a maintainer. */
export const isStaff = (db: Db, eb: kx.AnyEb, loginCol: kx.Ex): AliasableExpression<SqlBool> =>
  eb.exists(kx.schemaEb(eb).selectFrom("main.access as as_").select(one(eb)).where(kx.ciEq(db, "as_.login", kx.exprOf(eb, loginCol))).where("as_.role", "in", ["operator", "maintainer"]));

/** `mcp_tokens` rows of kind `runner` that have not expired, as a table expression named `alias`. */
export function liveRunnerCredential(eb: kx.AnyEb, alias: string, nowIso: string) {
  return kx.schemaEb(eb).selectFrom("main.mcp_tokens").selectAll().where("kind", "=", "runner").where("expires_at", ">", nowIso).$castTo<unknown>().as(alias);
}

/** The login of a token id. */
export const credentialLogin = (eb: kx.AnyEb, tokenIdCol: kx.Ex): Expression<string | null> =>
  kx.schemaEb(eb).selectFrom("main.mcp_tokens as ct").select("ct.login").where("ct.id", "=", kx.exprOf(eb, tokenIdCol)) as unknown as Expression<string | null>;

/** A cached write or better permission of the login on the repo exists, optionally checked after a time. */
export function writePermission(db: Db, eb: kx.AnyEb, loginCol: kx.Ex, repoCol: kx.Ex, afterIso?: string): AliasableExpression<SqlBool> {
  return eb.exists(kx.schemaEb(eb).selectFrom("main.repo_permissions as wp").select(one(eb))
    .where(kx.ciEq(db, "wp.login", kx.exprOf(eb, loginCol))).where("wp.repo", "=", kx.exprOf(eb, repoCol)).where("wp.permission", "in", WRITE)
    .$if(!!afterIso, (b) => b.where("wp.checked_at", ">", afterIso!)));
}

/** `discord_links.login` of a user hash. */
export const linkedLogin = (eb: kx.AnyEb, userHashCol: kx.Ex): Expression<string | null> =>
  kx.schemaEb(eb).selectFrom("main.discord_links as dl").select("dl.login").where("dl.user_hash", "=", kx.exprOf(eb, userHashCol)) as unknown as Expression<string | null>;

/** The setup link's creator is still an operator. */
export const creatorIsOperator = (db: Db, eb: kx.AnyEb, createdByCol: kx.Ex): AliasableExpression<SqlBool> => isOperator(db, eb, createdByCol);

/** The cached half of the act rule: the login is staff and holds a cached write permission on the repo. */
export const canActExpr = (db: Db, eb: kx.AnyEb, loginCol: kx.Ex, repoCol: kx.Ex, afterIso?: string): AliasableExpression<SqlBool> =>
  eb.and([isStaff(db, eb, loginCol), writePermission(db, eb, loginCol, repoCol, afterIso)]) as AliasableExpression<SqlBool>;
