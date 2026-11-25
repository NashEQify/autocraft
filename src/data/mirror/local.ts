// Write-through after a GitHub write and the sync item writer (M01 mirror-a).
import type { Expression, SqlBool } from "kysely";
import type { Db, Param } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { addAudit } from "../control/audit.ts";
import { addStageEvents } from "../planner/stages.ts";
import { advanceOrgHighWater } from "./sync.ts";
import { keepKnownMergeableExpr } from "./fragments.ts";
import { refKey, splitKey } from "./shared.ts";
import type { HashFields, ItemEntry, ItemHashes, LocalPatch, RefKey, SaveItemsOptions } from "./types.ts";

type Kind<K extends LocalPatch["kind"]> = Extract<LocalPatch, { kind: K }>;

/** The last patch of each item: a statement cannot touch one row twice. */
const lastOf = <T extends { repo: string; number: number }>(xs: readonly T[]): T[] => [...new Map(xs.map((x) => [refKey(x.repo, x.number), x])).values()];

/**
 * `UPDATE main.items ... FROM (rows) v WHERE items.(repo, number) = v.(repo, number) AND <more>`, in chunks of 10,000 rows; returns the items matched.
 * Call inside `db.write`.
 */
async function updateItemsFrom(db: Db, rows: Record<string, Param>[], cols: Parameters<typeof kx.valuesTable>[2], set: (eb: kx.AnyEb) => Record<string, Expression<unknown>>, more: (eb: kx.AnyEb) => Expression<SqlBool>[] = () => []): Promise<RefKey[]> {
  const q = queryDb(db);
  const out: RefKey[] = [];
  for (const chunk of kx.chunks(rows)) {
    const v = kx.valuesTable(db, chunk, cols, "v");
    const hit = await q.all((q.k.updateTable("main.items") as any).from(v).set(set)
      .where((eb: kx.AnyEb) => eb.and([eb("main.items.repo", "=", eb.ref("v.repo")), eb("main.items.number", "=", eb.ref("v.number")), ...more(eb)]))
      .returning(["main.items.repo as repo", "main.items.number as number"]), { label: "mirror.applyLocal" }) as { repo: string; number: number }[];
    for (const r of hit) out.push(refKey(r.repo, r.number));
  }
  return out;
}

const ONE = { repo: "text", number: "bigint" } as const;

/**
 * The one writer for local state after a GitHub write: one `db.write`, one statement per patch kind present, the audit rows of base changes
 * through `control.addAudit`, the stage rows of label patches through `planner.addStageEvents`, and a `diff_facts` delete for a `base` patch
 * without `keepDiff`. Each patch writes only while its guard holds (`merged`, `state`: the item is OPEN; `live`: the PR's head); `changed`
 * lists the items a statement matched. A patch of an item given twice in one kind: the last wins.
 */
export async function applyLocal(db: Db, patches: LocalPatch[]): Promise<{ changed: RefKey[] }> {
  if (!patches.length) return { changed: [] };
  const q = queryDb(db);
  const of = <K extends LocalPatch["kind"]>(k: K): Kind<K>[] => lastOf(patches.filter((p): p is Kind<K> => p.kind === k));
  const merged = of("merged"), state = of("state"), labels = of("labels"), base = of("base"), live = of("live");
  return await db.write(async () => {
    const changed = new Set<RefKey>();
    const add = (refs: RefKey[]) => refs.forEach((r) => changed.add(r));
    const open = (eb: kx.AnyEb) => [eb("main.items.state", "=", "OPEN")];

    if (merged.length) add(await updateItemsFrom(db, merged.map((p) => ({ repo: p.repo, number: p.number, at: p.at })), { ...ONE, at: "text" },
      (eb) => ({ state: eb.val("MERGED"), merged_at: eb.fn.coalesce("main.items.merged_at", eb.ref("v.at")), closed_at: eb.fn.coalesce("main.items.closed_at", eb.ref("v.at")) }), open));
    if (state.length) add(await updateItemsFrom(db, state.map((p) => ({ repo: p.repo, number: p.number, state: p.state, at: p.at ?? null })), { ...ONE, state: "text", at: "text" },
      (eb) => ({ state: eb.ref("v.state"), closed_at: eb.fn.coalesce("main.items.closed_at", eb.ref("v.at")) }), open));
    if (labels.length) {
      add(await updateItemsFrom(db, labels.map((p) => ({ repo: p.repo, number: p.number, labels: JSON.stringify(p.labels) })), { ...ONE, labels: "text" }, (eb) => ({ labels: eb.ref("v.labels") })));
      const stages = labels.flatMap((p) => (p.stage ? [{ repo: p.repo, number: p.number, stage: "labeled", ...p.stage }] : []));
      if (stages.length) await addStageEvents(db, stages);
    }

    if (base.length) {
      const was = new Map<RefKey, string | null>();
      for (const c of kx.chunks(base)) {
        for (const r of await q.all(q.k.selectFrom("main.items as i").select(["i.repo", "i.number", "i.base_ref"]).where(kx.refIn(db, "i", c.map((p) => [p.repo, p.number] as const))), { label: "mirror.applyLocal" }))
          was.set(refKey(r.repo, r.number), r.base_ref);
      }
      const moved = base.filter((p) => was.has(refKey(p.repo, p.number)) && was.get(refKey(p.repo, p.number)) !== p.baseRef);
      const dropped = base.filter((p) => !p.keepDiff);
      if (dropped.length) {
        for (const c of kx.chunks(dropped)) await db.run(q.k.deleteFrom("main.diff_facts").where(kx.tupleIn(db, ["repo", "number", "head_oid"], c.map((p) => [p.repo, p.number, p.head] as const), ["text", "bigint", "text"])));
      }
      if (moved.length) {
        add(await updateItemsFrom(db, moved.map((p) => ({ repo: p.repo, number: p.number, base: p.baseRef })), { ...ONE, base: "text" }, (eb) => ({ base_ref: eb.ref("v.base") })));
        await addAudit(db, moved.map((p) => ({ login: p.by ?? "merge", action: "base-changed", target: refKey(p.repo, p.number), details: { head: p.head, from: was.get(refKey(p.repo, p.number)) ?? null, base: p.baseRef } })));
      }
    }

    if (live.length) {
      const rows = live.map((p) => ({ repo: p.repo, number: p.number, head: p.pr.head, state: p.pr.state ?? null, draft: p.pr.draft ? 1 : 0, mergeable: p.pr.mergeable, mcm: p.pr.maintainerCanModify === undefined ? null : p.pr.maintainerCanModify ? 1 : 0, at: p.at }));
      // The planner reads the mirrored value when the checks row is missing or at another head: a conflict seen live must reach it.
      const known = rows.filter((r) => r.mergeable === "CONFLICTING" || r.mergeable === "MERGEABLE");
      if (known.length) add(await updateItemsFrom(db, known, { ...ONE, head: "text", mergeable: "text" }, (eb) => ({ mergeable: eb.ref("v.mergeable") }),
        (eb) => [eb("main.items.kind", "=", "pr"), eb("main.items.head_oid", "=", eb.ref("v.head"))]));
      for (const chunk of kx.chunks(rows)) {
        const v = kx.valuesTable(db, chunk, { ...ONE, head: "text", state: "text", draft: "bigint", mergeable: "text", mcm: "bigint", at: "text" }, "v");
        const hit = await q.all((q.k.updateTable("main.pr_checks") as any).from(v).set((eb: kx.AnyEb) => {
          const same = eb("main.pr_checks.head_oid", "=", eb.ref("v.head"));
          return {
            head_oid: eb.ref("v.head"),
            state: eb.fn.coalesce("v.state", "main.pr_checks.state"),
            is_draft: eb.ref("v.draft"),
            // A known live value wins; UNKNOWN keeps a known stored value at the same head.
            mergeable: eb.case().when(same).then(eb.case().when(eb("v.mergeable", "in", ["CONFLICTING", "MERGEABLE"])).then(eb.ref("v.mergeable"))
              .else(eb.fn.coalesce(eb.fn("nullif", ["main.pr_checks.mergeable", eb.val("UNKNOWN")]), eb.ref("v.mergeable"))).end()).else(eb.ref("v.mergeable")).end(),
            maintainer_can_modify: eb.fn.coalesce("v.mcm", "main.pr_checks.maintainer_can_modify"),
            // The old head's checks say nothing about the new one: pending until the checks sync reads them.
            overall: eb.case().when(same).then(eb.ref("main.pr_checks.overall")).else(eb.val("pending")).end(),
            checks: eb.case().when(same).then(eb.ref("main.pr_checks.checks")).else(eb.val("[]")).end(),
            fetched_at: eb.ref("v.at"),
          };
        }).where((eb: kx.AnyEb) => eb.and([eb("main.pr_checks.repo", "=", eb.ref("v.repo")), eb("main.pr_checks.number", "=", eb.ref("v.number"))]))
          .returning(["main.pr_checks.repo as repo", "main.pr_checks.number as number"]), { label: "mirror.applyLocal" }) as { repo: string; number: number }[];
        add(hit.map((r) => refKey(r.repo, r.number)));
      }
    }
    return { changed: [...changed] };
  });
}

/** Items GitHub no longer returns: CLOSED (closed_at kept when set) with an `item-gone` audit row for each item that was still OPEN. Returns the items closed. */
export async function closeGoneItems(db: Db, refs: RefKey[], now: string): Promise<number> {
  if (!refs.length) return 0;
  return await db.write(async () => {
    const closed = await updateItemsFrom(db, lastOf(refs.map(splitKey)).map((r) => ({ repo: r.repo, number: r.number, now })), { ...ONE, now: "text" },
      (eb) => ({ state: eb.val("CLOSED"), closed_at: eb.fn.coalesce("main.items.closed_at", eb.ref("v.now")) }), (eb) => [eb("main.items.state", "=", "OPEN")]);
    await addAudit(db, closed.map((target) => ({ login: "sync", action: "item-gone", target, details: { reason: "not found or transferred on GitHub; marked CLOSED" }, at: now })));
    return closed.length;
  });
}

const ITEM_COLUMNS: readonly string[] = kx.cols("main.items").filter((c) => c !== "jev_failed_hash");
const COMMENT_UPSERT = ["repo", "number", "kind", "author", "created_at", "body", "review_state", "commit_oid", "counted", "author_association", "mentions_pipeline", "url"] as const;
const ITEM_UPSERT = ITEM_COLUMNS.filter((c) => c !== "repo" && c !== "number" && c !== "mergeable" && c !== "text_refs");

/**
 * The sync writer: one `db.write`; per chunk of 500 entries a read of the stored rows and read times, an upsert of the changed items, the text
 * refs of changed pull requests, author ids, comments and `item_reads`. The org high water is advanced last, in the same transaction, so what the
 * sync records commits with the items or not at all. An item given twice keeps its last entry. A read never replaces what a later-started read
 * stored; a row equal to the stored one writes nothing unless `force`.
 */
export async function saveItems(db: Db, entries: ItemEntry[], o: SaveItemsOptions): Promise<{ stored: number }> {
  const page = [...new Map(entries.map((e) => [refKey(e.repo, e.row.number), e])).values()];
  if (!page.length && o.advanceOrgHighWater === undefined) return { stored: 0 };
  const q = queryDb(db);
  const isRef = (xs: readonly ItemEntry[]) => kx.tupleIn(db, ["repo", "number"], xs.map((x) => [x.repo, x.row.number] as const), ["text", "bigint"]);
  return await db.write(async () => {
    let stored = 0;
    for (const chunk of kx.batches(page)) {
      const readAt = (e: ItemEntry): string => e.readAt ?? o.readAt;
      const rows = await q.all((q.k.selectFrom("main.items as i").leftJoin("main.item_reads as r", (j) => j.onRef("r.repo", "=", "i.repo").onRef("r.number", "=", "i.number"))
        .select([...ITEM_COLUMNS.map((c) => `i.${c}`), "r.synced_at as read_synced_at"] as never) as any)
        .where(kx.tupleIn(db, ["i.repo", "i.number"], chunk.map((x) => [x.repo, x.row.number] as const), ["text", "bigint"])), { label: "mirror.saveItems" }) as Record<string, unknown>[];
      const old = new Map(rows.map((r) => [refKey(String(r.repo), Number(r.number)), r]));
      const current = chunk.filter((e) => {
        const last = old.get(refKey(e.repo, e.row.number))?.read_synced_at;
        return typeof last !== "string" || !(Date.parse(last) > Date.parse(readAt(e)));
      });
      const changed = o.force ? current : current.filter((e) => {
        const s = old.get(refKey(e.repo, e.row.number));
        return !s || !ITEM_COLUMNS.every((c) => (s[c] ?? null) === ((e.row as Record<string, unknown>)[c] ?? null));
      });
      if (changed.length) {
        await db.run(q.k.insertInto("main.items").values(changed.map((e) => Object.fromEntries(ITEM_COLUMNS.map((c) => [c, (e.row as Record<string, unknown>)[c] ?? null])) as never))
          .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet((eb) => ({ ...kx.excluded(ITEM_UPSERT)(eb), mergeable: keepKnownMergeableExpr(eb, "items") }))));
        stored += changed.length;
        // After the upsert, which clears the stored refs of a row whose text was written (schema trigger items_text_refs_stale).
        const refs = changed.filter((e) => e.kind === "pr" && old.has(refKey(e.repo, e.row.number))).map((e) => ({ repo: e.repo, number: e.row.number, text_refs: e.row.text_refs ?? null }));
        await kx.updateFrom(db, "main.items", ["repo", "number"], refs, ["text_refs"]);
      }
      // The account seen under a login owns its id-less history for the whitelist; a later account with the same login does not inherit it.
      // A login with merged or closed PRs mirrored without an id is left to the backfill, which binds the author of that history.
      const ids = new Map<string, number>();
      for (const { row } of changed) if (typeof row.author === "string" && typeof row.author_id === "number" && !ids.has(row.author)) ids.set(row.author, row.author_id);
      if (ids.size) {
        const unbound = new Set((await q.all(q.k.selectFrom("main.items").select("author").distinct().where(kx.inList(db, "author", [...ids.keys()]))
          .where("kind", "=", "pr").where("state", "in", ["MERGED", "CLOSED"]).where("author_id", "is", null), { label: "mirror.saveItems" })).map((r) => r.author));
        const bind = [...ids].filter(([login]) => !unbound.has(login)).map(([login, id]) => ({ login, id }));
        for (const b of kx.batches(bind)) await db.run(q.k.insertInto("main.author_ids").values(b).onConflict((oc) => oc.doNothing()));
      }
      const full = changed.filter((e) => e.detail === "full");
      if (full.length) {
        const comments = [...new Map(full.flatMap((e) => e.comments).map((c) => [c.id, c])).values()];
        // A forced re-read of an unchanged item upserts in place: an identical comment bumps no topic. Comments the read no longer lists go.
        if (o.force) await db.run(q.k.deleteFrom("main.comments").where(isRef(full)).where((eb) => eb.not(kx.tupleIn(db, ["repo", "number", "id"], full.flatMap((e) => e.comments.map((c) => [e.repo, e.row.number, c.id] as const)), ["text", "bigint", "text"]))));
        else await db.run(q.k.deleteFrom("main.comments").where(isRef(full)));
        for (const b of kx.batches(comments)) await db.run(q.k.insertInto("main.comments").values(b as never).onConflict((oc) => oc.column("id").doUpdateSet(kx.excluded(COMMENT_UPSERT))));
      }
      if (current.length) {
        await db.run(q.k.insertInto("main.item_reads").values(current.map((e) => ({ repo: e.repo, number: e.row.number, synced_at: readAt(e) })))
          .onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["synced_at"]))
            .where((eb) => eb(eb.fn<number>("julianday", [eb.ref("excluded.synced_at")]), ">=", eb.fn<number>("julianday", [eb.ref("main.item_reads.synced_at")])))));
      }
    }
    if (o.advanceOrgHighWater !== undefined) await advanceOrgHighWater(db, o.advanceOrgHighWater);
    return { stored };
  });
}

const FILL_BATCH = 2000;

/**
 * Fills the embed hash of items that have none, and the class hash of open items whose class scheme is not `o.scheme`, in batches of 2,000 (a read
 * and one `updateFrom` per batch, in a write transaction each). The hash function is passed in so the module imports no classifier code; `o.around`
 * wraps the write of a batch (the planner's bulk-write mark for a large batch). Returns the rows written.
 */
export async function fillItemHashes(db: Db, hash: (row: HashFields) => ItemHashes, o: { scheme: string; batch?: number; around?: (source: "embed-hashes" | "class-hashes", rows: number, write: () => Promise<void>) => Promise<void> }): Promise<number> {
  const q = queryDb(db);
  const size = o.batch ?? FILL_BATCH;
  const cols = ["repo", "number", "kind", "title", "body", "additions", "deletions", "changed_files", "author_association"] as const;
  const pass = async (source: "embed-hashes" | "class-hashes"): Promise<number> => {
    let total = 0;
    for (;;) {
      const rows = await q.all(q.k.selectFrom("main.items").select(cols)
        .$if(source === "embed-hashes", (b) => b.where("embed_hash", "is", null))
        .$if(source === "class-hashes", (b) => b.where("state", "=", "OPEN").where("class_scheme", "is distinct from", o.scheme))
        .orderBy("repo").orderBy("number").limit(size), { label: "mirror.fillItemHashes" });
      const set = rows.flatMap((r): Record<string, Param>[] => {
        const h = hash(r);
        const value = source === "embed-hashes" ? h.embed_hash : h.class_hash;
        if (value === null) return [];
        return [source === "embed-hashes" ? { repo: r.repo, number: r.number, embed_hash: value } : { repo: r.repo, number: r.number, class_hash: value, class_scheme: o.scheme }];
      });
      // A hash function that gives nothing for a row leaves it unfilled: stop instead of reading it again.
      if (!set.length) return total;
      await db.write(async () => {
        const write = async (): Promise<void> => { await kx.updateFrom(db, "main.items", ["repo", "number"], set, source === "embed-hashes" ? ["embed_hash"] : ["class_hash", "class_scheme"]); };
        if (o.around) await o.around(source, set.length, write); else await write();
      });
      total += set.length;
      if (rows.length < size) return total;
    }
  };
  return (await pass("embed-hashes")) + (await pass("class-hashes"));
}
