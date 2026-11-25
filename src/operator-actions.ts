// Operator releases for items that stop waiting for a person: clear a review hold at the current head,
// plan Verify again after it failed or errored, try a skipped or failed issue fix again, try the integration batch
// again after a single-PR batch failed. Each changes
// only local tables (the pipeline then picks the item up as usual) and is audited; none writes to GitHub.
import { loadPrMirror } from "./data/mirror/index.ts";
import { loadReviewsAt, dropHoldReviews } from "./data/review/index.ts";
import { loadFailedBatchOf, markVerificationsStale, supersedeFailedBatch, verificationOf } from "./data/merge/index.ts";
import { addAudit } from "./data/control/index.ts";
import { headOf } from "./core/rules.ts";
import type { Db } from "./db/index.ts";
import { openDb } from "./db/open.ts";

export class ActionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ItemActions = { reviewAgain: boolean; verifyAgain: boolean; batchAgain: boolean };

type Item = { kind: string; state: string; head: string | null };

/** The item's kind, state and current head (the newer of the item's and its checks' heads), or null when the mirror lacks it. */
async function itemOf(db: Db, repo: string, n: number): Promise<Item | null> {
  const m = (await loadPrMirror(db, [{ repo, number: n }])).get(`${repo}#${n}`);
  if (!m) return null;
  const c = m.checks;
  return { kind: m.item.kind, state: m.item.state, head: headOf({ head_oid: m.item.head_oid, updated_at: m.item.updated_at, c_head: c?.head_oid ?? null, c_at: c?.fetched_at ?? null }) };
}

async function openItem(db: Db, repo: string, n: number): Promise<Item> {
  const r = await itemOf(db, repo, n);
  if (!r) throw new ActionError(404, `no item ${repo}#${n} in the mirror`);
  if (r.state !== "OPEN") throw new ActionError(409, `${repo}#${n} is not open`);
  return r;
}

const heldReview = async (db: Db, repo: string, n: number, head: string | null) => {
  if (!head) return undefined;
  const r = (await loadReviewsAt(db, [{ repo, number: n, head }])).get(`${repo}#${n}@${head}`);
  return r?.verdict === "hold" ? { reason: r.reason } : undefined;
};
const failedVerify = async (db: Db, repo: string, n: number, head: string | null) => {
  const v = head ? await verificationOf(db, repo, n, head) : undefined;
  return v && (v.state === "failed" || v.state === "error") ? { state: v.state, summary: v.summary } : undefined;
};
/** The legacy fix step's stopped attempt; the fix step is retired, so there is none. */
export const stoppedFix = async (_db: Db, _repo: string, _n: number): Promise<{ state: string; round: number; retries: number; push_tries: number; reason: string | null; summary: string | null } | null> => null;

const failedBatch = async (db: Db, repo: string, n: number, head: string | null) =>
  head ? (await loadFailedBatchOf(db, [{ repo, number: n, head }])).get(`${repo}#${n}@${head}`) : undefined;

/** Which releases apply to the item now; the Item page shows only these. */
export async function actionsOf(db: Db, repo: string, n: number): Promise<ItemActions> {
  const r = await itemOf(db, repo, n);
  if (!r || r.state !== "OPEN" || r.kind !== "pr") return { reviewAgain: false, verifyAgain: false, batchAgain: false };
  const [review, verify, batch] = await db.together(() => Promise.all([heldReview(db, repo, n, r.head), failedVerify(db, repo, n, r.head), failedBatch(db, repo, n, r.head)]));
  return { reviewAgain: !!review, verifyAgain: !!verify, batchAgain: !!batch };
}

/** Removes the hold review at the PR's current head so the Review stage reviews that head again. */
export async function reviewAgain(db: Db, by: string, repo: string, n: number): Promise<void> {
  const it = await openItem(db, repo, n);
  if (it.kind !== "pr") throw new ActionError(409, `${repo}#${n} is not a pull request`);
  const gone = it.head ? await dropHoldReviews(db, [{ repo, number: n, head: it.head }], by) : [];
  if (!gone.length) throw new ActionError(409, `${repo}#${n} has no review hold at its current head`);
}

/** Marks the failed or errored verification of the current head stale so Verify plans it again. */
export async function verifyAgain(db: Db, by: string, repo: string, n: number): Promise<void> {
  const it = await openItem(db, repo, n);
  if (it.kind !== "pr") throw new ActionError(409, `${repo}#${n} is not a pull request`);
  const v = await failedVerify(db, repo, n, it.head);
  if (!v) throw new ActionError(409, `${repo}#${n} has no failed or errored verification at its current head`);
  await db.write(async () => {
    await markVerificationsStale(db, [`${repo}#${n}@${it.head!}`], by);
    await addAudit(db, [{ login: by, action: "verify-again", target: `${repo}#${n}`, details: { head: it.head, was: v.state, summary: v.summary } }]);
  });
}

/** Marks the failed batch that holds the PR's current head superseded, keeping its summary, so the merge queue considers the PR again. */
export async function batchAgain(db: Db, by: string, repo: string, n: number): Promise<void> {
  const it = await openItem(db, repo, n);
  if (it.kind !== "pr") throw new ActionError(409, `${repo}#${n} is not a pull request`);
  if (!it.head) throw new ActionError(409, `${repo}#${n} is not held by a failed batch at its current head`);
  try {
    await supersedeFailedBatch(db, by, { repo, number: n, head: it.head });
  } catch (e) {
    throw new ActionError(409, (e as Error).message);
  }
}

export const commands = {
  item: {
    summary: "item batch-again REPO NUMBER --by LOGIN: release a PR held by a failed integration batch",
    async run(args: string[]): Promise<void> {
      const [sub, repo, num] = args;
      const by = args[args.indexOf("--by") + 1];
      if (sub !== "batch-again" || !repo || !/^\d+$/.test(num ?? "") || !args.includes("--by") || !by) {
        console.error("usage: autocraft-server item batch-again <repo> <number> --by <login>");
        process.exit(2);
      }
      const db = await openDb();
      try {
        await batchAgain(db, by, repo, Number(num));
        console.log(`${repo}#${num}: released from its failed batch`);
      } catch (e) {
        if (!(e instanceof ActionError) && typeof (e as { status?: unknown }).status !== "number") throw e;
        console.error((e as Error).message);
        process.exit(1);
      }
    },
  },
};
