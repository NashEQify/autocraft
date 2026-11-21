// The PRs Verify plans: those whose Plan holds a `verify` action (a take at the current head, CI not failing, not verified yet).
import { planned } from "../core/select.ts";
import type { ReviewInfo, VerifyCandidate } from "./candidates.ts";
import { mapSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";

const list = <T>(s: string | null): T[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
};

/** The PRs to plan and build, in selection order. */
export async function selectCandidates(db: Db, repo: string | undefined, run?: string | null): Promise<VerifyCandidate[]> {
  return (await candidatesIn(db, "plan", repo, run)).map((x) => x.c);
}

/** The PRs Verify cannot build (private repo, or no Cargo.toml at the root of a repo without CI), with why. */
export async function unavailableCandidates(db: Db, repo: string | undefined, run?: string | null): Promise<{ c: VerifyCandidate; reason: string }[]> {
  return (await candidatesIn(db, "unavailable", repo, run)).map((x) => ({ c: x.c, reason: x.reason! }));
}

async function candidatesIn(db: Db, bucket: "plan" | "unavailable", repo: string | undefined, run: string | null | undefined): Promise<{ c: VerifyCandidate; reason: string | null }[]> {
  const review = db.prepare("SELECT verdict, reason, risks, fixes FROM final_reviews WHERE repo = ? AND number = ? AND head_oid = ?");
  const text = db.prepare("SELECT title, body FROM items WHERE repo = ? AND number = ?");
  return await mapSeq((await planned(db, "verify", { bucket, ...(repo ? { repo } : {}), ...(run !== undefined ? { run } : {}) })), async ({ facts: f, action }) => {
    const r = await review.get(f.repo, f.number, action.head!) as { verdict: string; reason: string | null; risks: string | null; fixes: string | null } | undefined;
    const t = await text.get(f.repo, f.number) as { title: string | null; body: string | null } | undefined;
    const info: ReviewInfo = { verdict: r?.verdict ?? "take", reason: r?.reason ?? "", risks: list<string>(r?.risks ?? null), fixes: list<{ file: string; change: string }>(r?.fixes ?? null) };
    return { c: { repo: f.repo, number: f.number, title: t?.title ?? "", body: t?.body ?? "", head_oid: action.head!, label: f.label, review: info }, reason: f.verifyUnavailable };
  });
}
