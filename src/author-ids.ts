// Binds each author login with PR history to the GitHub account id it belongs to, so a login that later passes to another account
// does not inherit the history (tiersOf reads author_ids). The sync binds ids as it writes rows; this step covers history written earlier.
import { ownerOf } from "./owners.ts";
import type { Querier } from "./mirror.ts";
import type { Db } from "./db/index.ts";

const BATCH = 40;

/** Logins whose merged or closed PRs count toward a tier and that have no bound account id. */
export async function unboundLogins(db: Db): Promise<string[]> {
  return (await db.all(db.k.selectFrom("items").select("author").distinct().$narrowType<{ author: string }>()
    .where("kind", "=", "pr").where("author", "is not", null).where("state", "in", ["MERGED", "CLOSED"])
    .where((eb) => eb.not(eb.exists(eb.selectFrom("author_ids as a").select(eb.lit(1).as("one")).whereRef("a.login", "=", "items.author"))))
    .orderBy("author"))).map((r) => r.author);
}

/**
 * The author account of `n` pull requests of one owner (`$owner`), passed as $r{i} (repository name) and $k{i} (number).
 * A deleted account reads as a null author.
 */
export function authorIdsQuery(n: number): string {
  const decl = Array.from({ length: n }, (_, i) => `, $r${i}: String!, $k${i}: Int!`).join("");
  const body = Array.from({ length: n }, (_, i) => `p${i}: repository(owner: $owner, name: $r${i}) { pullRequest(number: $k${i}) { author { __typename ... on User { databaseId } ... on Bot { databaseId } } } }`).join(" ");
  return `query($owner: String!${decl}) { rateLimit { cost remaining resetAt } ${body} }`;
}

/** Bound for an account GitHub no longer has: no later holder of the login is the same person. */
export const DELETED_ACCOUNT_ID = -1;

type Pr = { login: string; repo: string; number: number };

async function lookup(client: Querier, owner: string, prs: Pr[], out: Map<string, number>): Promise<void> {
  if (!prs.length) return;
  const vars: Record<string, string | number> = { owner };
  prs.forEach((p, i) => { vars[`r${i}`] = p.repo; vars[`k${i}`] = p.number; });
  try {
    const data = await client.query(authorIdsQuery(prs.length), vars);
    prs.forEach((p, i) => {
      const pr = data?.[`p${i}`]?.pullRequest;
      if (!pr) return;
      const id = pr.author?.databaseId;
      if (typeof id === "number") out.set(p.login, id);
      else if (pr.author === null) out.set(p.login, DELETED_ACCOUNT_ID);
    });
  } catch (e) {
    // A repository or pull request GitHub cannot find, or one the token may not read, fails the whole query: split until those
    // stand alone, and leave them unbound.
    const type = (e as { type?: string })?.type;
    if (type !== "NOT_FOUND" && type !== "FORBIDDEN") throw e;
    if (prs.length === 1) return;
    const mid = prs.length >> 1;
    await lookup(client, owner, prs.slice(0, mid), out);
    await lookup(client, owner, prs.slice(mid), out);
  }
}

/**
 * Binds the logins that have merged or closed PRs and no account id. A login can have passed to another account, so the id comes
 * from the login's own oldest merged or closed PR (what GitHub reports as its author), never from the login's current holder.
 * Ids stored on item rows are used only when every row of the login has one. One batched pass per owner; nothing when all are bound.
 */
export async function backfillAuthorIds(db: Db, client: Querier | null): Promise<number> {
  const bind = async (login: string, id: number) => await db.run(db.k.insertInto("main.author_ids").values({ login, id }).onConflict((oc) => oc.doNothing()));
  let n = 0;
  // The id of the login's oldest item: every row has one here, and a login can have passed to another account.
  const known = await db.all(db.k.selectFrom("items as i")
    .select((eb) => ["i.author", eb.selectFrom("items as o").select("o.author_id").whereRef("o.author", "=", "i.author")
      .orderBy("o.created_at", (o) => o.asc().nullsFirst()).orderBy("o.repo").orderBy("o.number").limit(1).as("author_id")])
    .$narrowType<{ author: string; author_id: number }>()
    .where("i.author", "is not", null).where("i.author_id", "is not", null)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("author_ids as a").select(eb.lit(1).as("one")).whereRef("a.login", "=", "i.author"))))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("items as j").select(eb.lit(1).as("one")).whereRef("j.author", "=", "i.author").where("j.author_id", "is", null))))
    .groupBy("i.author").orderBy((eb) => eb.fn.min("i.created_at"), (o) => o.asc().nullsFirst()).orderBy("i.author"));
  for (const r of known) n += (await bind(r.author, r.author_id)).changes;
  const missing = new Set(await unboundLogins(db));
  if (!client || !missing.size) return n;
  const oldest = (await db.all(db.k.selectFrom((eb) => eb.selectFrom("items")
      .select((e) => ["author as login", "repo", "number", "created_at as first",
        e.fn.agg<number>("row_number", []).over((o) => o.partitionBy("author").orderBy("created_at", (d) => d.asc().nullsFirst()).orderBy("repo").orderBy("number")).as("n")])
      .where("kind", "=", "pr").where("author", "is not", null).where("state", "in", ["MERGED", "CLOSED"]).as("f"))
    .select(["f.login", "f.repo", "f.number", "f.first"]).$narrowType<{ login: string }>().where("f.n", "=", 1).orderBy("f.login"))).filter((p) => missing.has(p.login));
  const byOwner = new Map<string, Pr[]>();
  for (const p of oldest) (byOwner.get(ownerOf(p.repo)) ?? byOwner.set(ownerOf(p.repo), []).get(ownerOf(p.repo))!).push(p);
  const found = new Map<string, number>();
  const skipped: string[] = [];
  for (const [owner, prs] of byOwner) {
    try {
      for (let i = 0; i < prs.length; i += BATCH) await lookup(client, owner, prs.slice(i, i + BATCH), found);
    } catch (e) {
      // An owner no token can read (e.g. the app is not installed there) leaves its logins unbound; the other owners go on.
      if (!/not installed|FORBIDDEN|Resource not accessible/i.test(String((e as Error)?.message))) throw e;
      skipped.push(owner);
    }
  }
  if (skipped.length) console.log(`author ids: skipped ${skipped.join(", ")} (no readable token)`);
  for (const [login, id] of found) n += (await bind(login, id)).changes;
  return n;
}
