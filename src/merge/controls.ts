// Operator merge controls: hold or release a PR's merge, remove a PR from its integration batch, stop a batch.
//
//   autocraft-server merge-hold <repo#n>       autocraft-server merge-release <repo#n>
//   autocraft-server batch-remove <repo#n>     autocraft-server batch-stop <id>
//
// Hold and release change local tables only. Remove and stop close the batch's integration PR through
// src/github/write.ts (audited, on the GitHub activity page); the exec that runs `gh` is injectable.
import { guardRepo } from "../core/guard.ts";
import { type Exec, exec as defaultExec } from "../fixup/git.ts";
import { ghClosePr } from "../github/write.ts";
import { isTracked } from "../repos.ts";
import { ACTIVE_BATCH, cancelBuild, updateBatch } from "./batch-store.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { addAudit } from "../data/control/index.ts";
import { endBatches, getBatch, loadBatchRun } from "../data/merge/index.ts";
import { loadItems } from "../data/mirror/index.ts";
import { holdMerges, releaseMerges } from "../data/workflow/index.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

export class ControlError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

const refOf = (repo: string, number: number): string => `${repo}#${number}`;

async function openPr(db: Db, repo: string, number: number): Promise<void> {
  if (!await isTracked(db, repo)) throw new ControlError(`${repo} is not a tracked repo`, 404);
  const it = (await loadItems(db, [{ repo, number }], "ref")).get(refOf(repo, number));
  if (!it) throw new ControlError(`no item ${refOf(repo, number)} in the mirror`, 404);
  if (it.kind !== "pr") throw new ControlError(`${refOf(repo, number)} is not a pull request`);
  if (it.state !== "OPEN") throw new ControlError(`${refOf(repo, number)} is not open`);
}

/** Holds the PR's merge. Returns false when it was already held. */
export async function holdMerge(db: Db, by: string, repo: string, number: number, details: Record<string, unknown> = {}): Promise<boolean> {
  await openPr(db, repo, number);
  return (await holdMerges(db, [{ repo, number, by, details }])).length > 0;
}

/** Releases the PR's merge hold. Returns false when it was not held. */
export async function releaseMerge(db: Db, by: string, repo: string, number: number): Promise<boolean> {
  return (await releaseMerges(db, [{ repo, number }], by)).length > 0;
}

/** Marks the batch superseded and closes its integration PR, when it has one; the row goes back to its state if the close fails, so a later Stop, Remove or merge run retries. The PRs go back to the queue; the next merge run builds batches from what is eligible. */
async function endBatch(db: Db, by: string, id: number, why: string, comment: string, run: Exec): Promise<{ closed: number | null }> {
  const b = (await getBatch(db, id))!;
  await cancelBuild(db, b, by);
  await updateBatch(db, id, new Date().toISOString(), { state: "superseded", summary: why });
  if (b.pr_number === null) return { closed: null };
  const g = await guardRepo(db, b.repo, null, { operator: by });
  const r = "refused" in g ? { code: 1, stdout: "", stderr: g.refused }
    : await ghClosePr({ db, login: by }, g, run, { repo: b.repo, number: b.pr_number }, { by: "fixed-operator" }, `Closing: ${comment}.`, { batch: b.branch });
  if (r.code !== 0) {
    const state = await run("gh", ["pr", "view", String(b.pr_number), "--repo", `${slugOf(b.repo)}`, "--json", "state", "--jq", ".state"]);
    if (state.code === 0 && state.stdout.trim() === "MERGED") {
      // The merge went through while the batch was being ended: the merge bookkeeping records it.
      const at = new Date().toISOString();
      await endBatches(db, [{
        id, by, state: "merged", summary: null,
        stage: b.members.map((m) => ({ repo: b.repo, number: m.number, stage: "merged", at, actor: by, note: `merge in ${b.branch} at ${m.head_oid.slice(0, 7)}` })),
        audit: [{ at, actor: by, action: "batch-end-too-late", target: `${b.repo}:${b.branch}`, details: { pr: b.pr_number } }],
      }]);
      return { closed: null };
    }
    await updateBatch(db, id, new Date().toISOString(), { state: b.state, summary: b.summary });
    throw new ControlError(`the batch PR #${b.pr_number} could not be closed: ${r.stderr.replace(/\s+/g, " ").trim().slice(0, 200)}`, 502);
  }
  return { closed: b.pr_number };
}

async function activeBatch(db: Db, id: number) {
  const b = Number.isInteger(id) ? await getBatch(db, id) : undefined;
  if (!b) throw new ControlError(`no batch ${id}`, 404);
  if (!ACTIVE_BATCH.includes(b.state)) throw new ControlError(`batch ${b.branch} is ${b.state}, not in flight`);
  return b;
}

/** Stops the batch: closes its integration PR and holds each member PR (audited per PR), so the next merge run does not rebuild the same batch. Release them one by one. */
export async function stopBatch(db: Db, by: string, id: number, run: Exec = defaultExec): Promise<{ batch: string; prs: number[]; held: number[]; closed: number | null }> {
  const b = await activeBatch(db, id);
  const prs = b.members.map((m) => m.number);
  await addAudit(db, [{ login: by, action: "batch-stop", target: `${b.repo}:${b.branch}`, details: { prs } }]);
  const items = await loadItems(db, prs.map((number) => ({ repo: b.repo, number })), "ref");
  const open = prs.filter((n) => items.get(refOf(b.repo, n))?.state === "OPEN");
  const newly = new Set(await holdMerges(db, open.map((number) => ({ repo: b.repo, number, by, details: { batch: b.branch } }))));
  const held = open.filter((n) => newly.has(refOf(b.repo, n)));
  const { closed } = await endBatch(db, by, id, `stopped in AutoCraft by ${by}`, `the batch was stopped in AutoCraft by ${by}. Its pull requests are held until released`, run);
  return { batch: b.branch, prs, held, closed };
}

/** Holds the PR and ends its batch: the others go back to the queue and the next merge run builds a batch without it. */
export async function removeFromBatch(db: Db, by: string, repo: string, number: number, run: Exec = defaultExec): Promise<{ batch: string; closed: number | null }> {
  const b = (await loadBatchRun(db, repo)).active.find((x) => x.members.some((m) => m.number === number));
  if (!b) throw new ControlError(`${refOf(repo, number)} is not in a batch in flight`);
  await holdMerge(db, by, repo, number, { batch: b.branch });
  await addAudit(db, [{ login: by, action: "batch-remove", target: refOf(repo, number), details: { batch: b.branch } }]);
  const { closed } = await endBatch(db, by, b.id, `${refOf(repo, number)} was removed in AutoCraft by ${by}`, `${refOf(repo, number)} was removed from the batch in AutoCraft by ${by}. The other pull requests are rebuilt in a new batch`, run);
  return { batch: b.branch, closed };
}

/** `repo#number`, `owner/repo#number` or a GitHub URL of a tracked repo's item. */
function parseRef(text: string | undefined): { repo: string; number: number } {
  const t = text?.trim() ?? "";
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(t)
    ?? /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(t);
  if (!m) throw new ControlError("not an item: use a GitHub URL, repo#number or owner/repo#number", 400);
  if (m[1] && m[1].toLowerCase() !== ownerOf(m[2]!).toLowerCase()) throw new ControlError(`${m[1]}/${m[2]} is not a tracked repo of ${m[1]}`, 400);
  return { repo: m[2]!, number: Number(m[3]) };
}

async function cli(f: () => Promise<string> | string): Promise<void> {
  try {
    console.log(await f());
  } catch (e) {
    if (!(e instanceof ControlError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

export const commands = {
  "merge-hold": {
    summary: "merge-hold <repo#n>: keep a PR from merging, alone or in a batch, until merge-release (reviews and fixes go on)",
    run: (args: string[]) => cli(async () => {
      const { connect } = await import("../db.ts");
      const r = parseRef(args[0]);
      return await holdMerge(await openDb(), "cli", r.repo, r.number) ? `${refOf(r.repo, r.number)}: merge held` : `${refOf(r.repo, r.number)}: already held`;
    }),
  },
  "merge-release": {
    summary: "merge-release <repo#n>: let a held PR merge again",
    run: (args: string[]) => cli(async () => {
      const { connect } = await import("../db.ts");
      const r = parseRef(args[0]);
      return await releaseMerge(await openDb(), "cli", r.repo, r.number) ? `${refOf(r.repo, r.number)}: released` : `${refOf(r.repo, r.number)}: was not held`;
    }),
  },
  "batch-remove": {
    summary: "batch-remove <repo#n>: close the PR's integration batch PR, hold the PR; the others are rebuilt in a new batch (writes to GitHub)",
    run: (args: string[]) => cli(async () => {
      const { connect } = await import("../db.ts");
      const r = parseRef(args[0]);
      const out = await removeFromBatch(await openDb(), "cli", r.repo, r.number);
      return `${refOf(r.repo, r.number)}: held and removed from ${out.batch}${out.closed ? `; closed batch PR #${out.closed}` : ""}`;
    }),
  },
  "batch-stop": {
    summary: "batch-stop <id>: close a batch's integration PR; holds its PRs (writes to GitHub)",
    run: (args: string[]) => cli(async () => {
      const { connect } = await import("../db.ts");
      const out = await stopBatch(await openDb(), "cli", Number(args[0]));
      return `${out.batch}: stopped${out.closed ? `; closed batch PR #${out.closed}` : ""}; held ${out.held.length ? out.held.map((n) => `#${n}`).join(", ") : "no PRs"} (merge-release to let them merge)`;
    }),
  },
};
