// The relations an item page shows: the classifiers' latest verdicts, and the duplicates and links of one item.
import type { NotNull } from "kysely";
import type { Classification, RelatedItem, Relation } from "../../../web/src/api/types.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { itemState } from "./shown.ts";

const json = <T>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

export async function classificationsOf(db: Db, repo: string, n: number): Promise<Classification[]> {
  // Latest verdict per classifier, picked here: a correlated MAX(at) subquery makes SQLite walk the (classifier, at) index.
  const all = await queryDb(db).all(queryDb(db).k.selectFrom("classifications").select(["classifier", "at", "type_label", "want", "reference", "reason", "dup_of"])
    .where("repo", "=", repo).where("number", "=", n).orderBy("classifier"));
  const latest = new Map<string, string>();
  for (const r of all) if (!latest.has(r.classifier) || r.at > latest.get(r.classifier)!) latest.set(r.classifier, r.at);
  return all.filter((r) => r.at === latest.get(r.classifier)).map((r) => ({
    classifier: r.classifier as Classification["classifier"], at: r.at,
    typeLabel: r.type_label as Classification["typeLabel"], want: (r.want ?? "unclear") as Classification["want"],
    reference: r.reference, reason: r.reason ?? "", dupOf: r.dup_of,
  }));
}

/** Duplicates from the classifiers, issues a PR closes, and PRs that close this issue. */
export async function relatedOf(db: Db, repo: string, n: number): Promise<RelatedItem[]> {
  const out = new Map<number, { number: number; relation: Relation }>();
  const add = (number: number, relation: Relation) => {
    if (number !== n && Number.isInteger(number) && !out.has(number)) out.set(number, { number, relation });
  };
  for (const d of await queryDb(db).all(queryDb(db).k.selectFrom("classifications").select("dup_of").distinct().where("repo", "=", repo).where("number", "=", n).where("dup_of", "is not", null).$narrowType<{ dup_of: NotNull }>().limit(10)))
    add(d.dup_of, "duplicate-of");
  for (const x of await queryDb(db).all(queryDb(db).k.selectFrom("classifications").select("number").distinct().where("repo", "=", repo).where("dup_of", "=", n).limit(10))) add(x.number, "duplicated-by");
  const it = await queryDb(db).get(queryDb(db).k.selectFrom("items").select(["kind", "closing_issues"]).where("repo", "=", repo).where("number", "=", n));
  for (const x of json<unknown[]>(it?.closing_issues, [])) if (typeof x === "number") add(x, "fixes");
  if (it?.kind === "issue") {
    const prs = await queryDb(db).all(queryDb(db).k.selectFrom("items").select(["number", "closing_issues"]).where("repo", "=", repo).where("kind", "=", "pr")
      .where((eb) => kx.like(db, "closing_issues", eb.val(`%${n}%`))).$narrowType<{ closing_issues: NotNull }>().limit(50));
    for (const p of prs) if (json<unknown[]>(p.closing_issues, []).includes(n)) add(p.number, "links");
  }
  const res: RelatedItem[] = [];
  for (const { number, relation } of [...out.values()].slice(0, 10)) {
    const row = await queryDb(db).get(queryDb(db).k.selectFrom("items").select(["title", "state", "kind"]).where("repo", "=", repo).where("number", "=", number));
    if (row) res.push({ repo, number, relation, title: row.title ?? "", state: itemState(row.state), kind: row.kind === "pr" ? "pr" : "issue" });
  }
  return res;
}
