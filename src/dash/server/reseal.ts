// Startup migration: values sealed under the earlier key label are sealed again under the current key, so
// TokenBox.open never needs the earlier one. Every table that holds TokenBox-sealed values is listed here.
import type { TokenBox } from "./crypto.ts";
import type { Db, RunResult } from "../../db/index.ts";

type Sealed = { id: string | number; token_enc: string; fields: Record<string, string | null> };
type Store = {
  table: string;
  read: (db: Db) => Promise<Sealed[]>;
  write: (db: Db, id: string | number, old: string, sealed: string) => Promise<RunResult>;
  aad: (r: Record<string, string | null>) => string;
};

const userAad = (login: string | null): string => `user_tokens:${login!.toLowerCase()}`;

const STORES: Store[] = [
  {
    table: "sessions",
    read: async (db) => (await db.all(db.k.selectFrom("sessions").select(["id_hash", "token_enc"]).where("token_enc", "is not", null).$narrowType<{ token_enc: string }>()))
      .map((r) => ({ id: r.id_hash, token_enc: r.token_enc, fields: { id_hash: r.id_hash } })),
    write: (db, id, old, sealed) => db.run(db.k.updateTable("sessions").set({ token_enc: sealed }).where("id_hash", "=", String(id)).where("token_enc", "=", old)),
    aad: (r) => r.id_hash!,
  },
  {
    table: "user_tokens",
    read: async (db) => (await db.all(db.k.selectFrom("user_tokens").select(["login", "token_enc"]).where("token_enc", "is not", null)))
      .map((r) => ({ id: r.login, token_enc: r.token_enc, fields: { login: r.login } })),
    write: (db, id, old, sealed) => db.run(db.k.updateTable("user_tokens").set({ token_enc: sealed }).where("login", "=", String(id)).where("token_enc", "=", old)),
    aad: (r) => userAad(r.login!),
  },
  {
    table: "user_token_revocations",
    read: async (db) => (await db.all(db.k.selectFrom("user_token_revocations").select(["id", "token_enc", "login", "aad"]).where("token_enc", "is not", null)))
      .map((r) => ({ id: r.id, token_enc: r.token_enc, fields: { login: r.login, aad: r.aad } })),
    write: (db, id, old, sealed) => db.run(db.k.updateTable("user_token_revocations").set({ token_enc: sealed }).where("id", "=", Number(id)).where("token_enc", "=", old)),
    aad: (r) => r.aad ?? userAad(r.login!),
  },
  {
    table: "reporter_tokens",
    read: async (db) => (await db.all(db.k.selectFrom("reporter_tokens").select(["reporter", "token_enc"]).where("token_enc", "is not", null)))
      .map((r) => ({ id: r.reporter, token_enc: r.token_enc, fields: { reporter: r.reporter } })),
    write: (db, id, old, sealed) => db.run(db.k.updateTable("reporter_tokens").set({ token_enc: sealed }).where("reporter", "=", String(id)).where("token_enc", "=", old)),
    aad: (r) => `reporter_tokens:${r.reporter!}`,
  },
];

/** Re-seals every legacy-sealed token_enc value in one transaction; returns the count per table (tables with a change only). Idempotent. */
export async function resealLegacyValues(db: Db, box: TokenBox): Promise<Record<string, number>> {
  const todo: Array<{ store: Store; id: string | number; old: string; sealed: string }> = [];
  for (const s of STORES) {
    for (const r of await s.read(db)) {
      const old = String(r.token_enc);
      const sealed = box.resealLegacy(old, s.aad(r.fields));
      if (sealed) todo.push({ store: s, id: r.id, old, sealed });
    }
  }
  const counts: Record<string, number> = {};
  if (!todo.length) return counts;
  await db.write(async () => {
    for (const t of todo) {
      const r = await t.store.write(db, t.id, t.old, t.sealed);
      if (Number(r.changes)) counts[t.store.table] = (counts[t.store.table] ?? 0) + 1;
    }
  });
  return counts;
}
