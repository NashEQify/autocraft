// The PR of an implementation: the checked diff is applied on the base commit in a hardened clone of ours (no working
// tree; nothing of the repository runs), committed as the pipeline's identity, pushed to its own branch and opened as a
// PR, all through src/github/write.ts. The queuer's pre-approval then sends it through Review, Verify and the merge queue.
// A run that stops part way is picked up by the next one: an open PR of ours on the branch (or the one stored on the row)
// is adopted and the remaining steps run.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.ts";
import { diffStat } from "../build/workspaces.ts";
import { guardItem, guardRepo, type GuardedItem, type ItemWant } from "../core/guard.ts";
import type { By } from "../core/gates.ts";
import { addFastTrack } from "../fasttrack.ts";
import { branchOf, forkOf } from "../fixissue/index.ts";
import { hasOpenPr } from "../fixissue/candidates.ts";
import { exec as realExec, fixupDir, Git, type Exec } from "../fixup/git.ts";
import { buildScriptsAt, type BuildScripts } from "../fixup/patch.ts";
import { ownPrSelect } from "../github/adopt.ts";
import { commitIdentity, githubIdentity } from "../github/identity.ts";
import { pipelineAccount, setPipelineLogin } from "../github/pipeline-account.ts";
import { ghComment, ghOpenPr, pushOwnBranch, type Writer } from "../github/write.ts";
import { Client, ONE_QUERY, writeItemNode, type Querier } from "../mirror.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { preapproveMerge } from "../preapproval/index.ts";
import { MAX_BINARY_BYTES, validateImplementation, type ChangedFile, type ImplementationCheck } from "./diff.ts";
import { setImplementationState, updateImplementation } from "./store.ts";
import { implBranch, implCommentText, implCommitMessage, implPrBody, implTitle, type CheckLine } from "./template.ts";
import type { Implementation } from "./types.ts";

/** The audit login of the stage's writes. */
const ACTOR = "implement";

export type PrDeps = {
  /** Every git and gh command. */
  exec: Exec;
  /** Directory holding one bare cache repository per repo. */
  root: string;
  /** GitHub GraphQL, to read the new PR into the mirror. Absent: the PR waits for the sync, and the run ends as `retry`. */
  querier?: Querier;
  log: (line: string) => void;
};

export const defaultPrDeps = (): PrDeps => ({ exec: realExec, root: fixupDir(), querier: new Client(100), log: console.log });

export type OpenPrInput = {
  implementation: Implementation;
  /** The workspace diff (workspaceDiff) against `implementation.baseSha`. */
  diff: string;
  /** The model that wrote the change, for the PR's note and body. */
  model: string;
  checks: CheckLine[];
  /** The job's actor: the pipeline, or an operator at the command line. */
  by: By;
  draft?: boolean;
  /** The Plan action the writes are guarded under; default `implement` in the build bucket. */
  want?: ItemWant;
  /** The job's run id, for the audit rows. */
  run?: string;
};

export type OpenPrResult =
  | { ok: true; url: string; number: number; branch: string; adopted: boolean; draft: boolean; /** Why the PR was not pre-approved, or null when it was. */ notPreapproved: string | null }
  | {
    ok: false; reason: string;
    /** True when a later run may succeed as it is (a guard, a push or the mirror); false when the attempt cannot open a PR (the caller decides what follows). */
    retry: boolean;
    /** The diff check's problems, when the diff was refused. */
    problems?: string[];
  };

const refOf = (i: { repo: string; number: number }): string => `${i.repo}#${i.number}`;
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const urlOk = (url: string, repo: string): boolean => new RegExp(`^https://github\\.com/${slugOf(repo)}/pull/\\d+$`).test(url);
const prNumberOf = (url: string): number => Number(/\/pull\/(\d+)$/.exec(url)![1]);

/** Forks being looked up or created, per repo: two implementations of one repo must not both create the fork. */
const forkLocks = new Map<string, Promise<unknown>>();
function forkOnce<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const run = (forkLocks.get(repo) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => {}).finally(() => { if (forkLocks.get(repo) === tail) forkLocks.delete(repo); });
  forkLocks.set(repo, tail);
  return run;
}

/** The issue's state on GitHub now; null when the read fails, in which case the mirror's state stands. */
async function liveState(exec: Exec, repo: string, path: string): Promise<"OPEN" | "CLOSED" | null> {
  const r = await exec("gh", ["api", `repos/${slugOf(repo)}/${path}`, "--jq", ".state"]);
  const v = r.code === 0 ? r.stdout.trim().toLowerCase() : "";
  return v === "open" ? "OPEN" : v === "closed" ? "CLOSED" : null;
}

/** True when the issue is closed on GitHub; the mirror row is brought up to date. */
async function issueClosedLive(db: Db, d: PrDeps, repo: string, number: number): Promise<boolean> {
  if (await liveState(d.exec, repo, `issues/${number}`) !== "CLOSED") return false;
  await db.run(db.k.updateTable("main.items").set({ state: "CLOSED" }).where("repo", "=", repo).where("number", "=", number).where("state", "=", "OPEN"));
  return true;
}

/**
 * Checks the diff against the build scripts both before and after it (a manifest change can name a new build script),
 * applies it on `base` and checks the commit's changes and binary sizes against the checked file list. Returns the commit.
 */
async function commitDiff(git: Git, root: string, base: string, diff: string, message: (c: Extract<ImplementationCheck, { ok: true }>) => string, who: { name: string; email: string }):
  Promise<{ ok: true; commit: string; check: Extract<ImplementationCheck, { ok: true }> } | { ok: false; reason: string; problems?: string[] }> {
  const check = validateImplementation(diff, await buildScriptsAt(git, base));
  if (!check.ok) return check;
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(join(root, ".index-"));
  let tree: string;
  try {
    const applied = await git.applyToTree(base, diff, join(scratch, "index"));
    if (!applied.ok) return { ok: false, reason: applied.reason };
    tree = applied.tree;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const after: BuildScripts = await buildScriptsAt(git, tree);
  const again = validateImplementation(diff, after);
  if (!again.ok) return again;
  const big = await oversized(git, tree, check.files.filter((f) => f.binary && f.status !== "D"));
  if (big.length) return { ok: false, reason: `binary files over ${MAX_BINARY_BYTES / 1024 ** 2} MiB: ${big.join(", ")}`, problems: big.map((p) => `${p}: a binary file over ${MAX_BINARY_BYTES / 1024 ** 2} MiB`) };
  const commit = await git.commit(tree, base, message(check), who);
  if (!sameChanges(await git.rawChanges(base, commit), check.files)) return { ok: false, reason: "the commit would change files or modes outside the checked diff" };
  return { ok: true, commit, check };
}

/** Binary files of the tree over MAX_BINARY_BYTES (a delta's result size is only known once applied). */
async function oversized(git: Git, tree: string, files: ChangedFile[]): Promise<string[]> {
  if (!files.length) return [];
  const out = await git.must(["ls-tree", "-r", "-l", "-z", tree, "--", ...files.map((f) => f.path)]);
  return out.split("\0").filter(Boolean).flatMap((row) => {
    const m = /^\d+ blob [0-9a-f]+ +(\d+)\t(.*)$/s.exec(row);
    return m && Number(m[1]) > MAX_BINARY_BYTES ? [m[2]!] : [];
  });
}

/** The commit's `diff-tree --raw` rows are exactly the checked files, with their status and modes. */
function sameChanges(rows: string[][], files: ChangedFile[]): boolean {
  if (rows.length !== files.length) return false;
  const want = new Map(files.map((f) => [f.path, f]));
  return rows.every(([from, to, status, path]) => {
    const f = want.get(path!);
    if (!f || f.status !== status) return false;
    if (f.status === "A") return from === "000000" && to === "100644";
    if (f.status === "D") return from === f.mode && to === "000000";
    return from === f.mode && to === f.mode;
  });
}

/** Comments on the issue once per PR: a row of an earlier comment on this PR (done, or begun with an unknown outcome) stops it. */
async function commentOnce(db: Db, d: PrDeps, g: GuardedItem, im: Implementation, pr: { number: number; url: string; draft: boolean }, run?: string): Promise<void> {
  const ref = refOf(im);
  const rows = await db.all(db.k.selectFrom("audit").select("details").where("action", "=", "implement-comment").where("target", "=", ref));
  if (rows.some((r) => { try { const x = JSON.parse(r.details ?? "{}") as { pr?: unknown; state?: unknown }; return x.pr === pr.number && x.state !== "failed"; } catch { return false; } })) return;
  const cm = await ghComment({ db, login: ACTOR }, g, d.exec, "implement-comment", { repo: im.repo, number: im.number, pr: false }, { by: "fixed" }, implCommentText(pr.url, pr.draft), { pr: pr.number, ...(run && { run }) });
  if (cm.code !== 0) d.log(`  ${ref}: comment failed: ${oneLine(cm.stderr)}`);
}

/** Reads the PR into the mirror, so the pre-approval and the planner see it now. True when the mirror has it with its head. */
async function mirrorPr(db: Db, d: PrDeps, repo: string, number: number): Promise<boolean> {
  const has = async () => !!(await db.get(db.k.selectFrom("main.items").select("head_oid").where("repo", "=", repo).where("number", "=", number).where("kind", "=", "pr")))?.head_oid;
  if (await has()) return true;
  if (!d.querier) return false;
  try {
    const sentAt = new Date();
    const data = await d.querier.query(ONE_QUERY, { owner: ownerOf(repo), name: repo, number }) as { repository?: { issueOrPullRequest?: Parameters<typeof writeItemNode>[2] } };
    await writeItemNode(db, repo, data.repository?.issueOrPullRequest, sentAt);
  } catch (e) {
    d.log(`  ${repo}#${number}: the PR could not be read into the mirror: ${oneLine(String((e as Error).message ?? e))}`);
  }
  return await has();
}

/**
 * Opens the implementation's PR, or adopts the one an earlier run opened, then pre-approves its merge as the queuer
 * (not for a draft), fast-tracks it with the issue's weight and comments on the issue once. The row moves to `opening`
 * at the start, keeps branch, PR number and URL as soon as the PR exists, and moves to `pr-opened` when every step is
 * done. A failure leaves the state to the caller: `retry` says whether the same input may succeed later.
 */
export async function openImplementationPr(db: Db, input: OpenPrInput, d: PrDeps = defaultPrDeps()): Promise<OpenPrResult> {
  const im = input.implementation;
  const { repo, number } = im;
  const ref = refOf(im);
  const draft = input.draft === true;
  const w: Writer = { db, login: ACTOR };
  const run = input.run ? { run: input.run } : {};
  const fail = (reason: string, retry: boolean, problems?: string[]): OpenPrResult => { d.log(`  ${ref}: PR not opened: ${reason}`); return { ok: false, reason, retry, ...(problems && { problems }) }; };
  try {
    if (!im.baseSha) return fail("the implementation has no base commit", false);
    const issue = await db.get(db.k.selectFrom("main.items").select(["state", "title"]).where("repo", "=", repo).where("number", "=", number));
    if (!issue || issue.state !== "OPEN" || await issueClosedLive(db, d, repo, number)) return fail("the issue is closed", false);
    if (im.state !== "opening") await setImplementationState(db, im.id, "opening");
    const guard = async (): Promise<GuardedItem | string> => {
      const g = await guardItem(db, { repo, number }, input.want ?? { kind: "implement", bucket: "build" }, input.by);
      return "refused" in g ? g.refused : g;
    };
    const who = await pipelineAccount(d.exec);
    await setPipelineLogin(db, who.login);
    const base = await branchOf(db, repo);
    const branch = im.branch ?? implBranch(number, issue.title ?? "", who.login);
    const title = implTitle(im.plan?.kind ?? "change", issue.title ?? "");

    // A PR an earlier run opened: the stored one, else an open PR of ours on the branch.
    let url: string | null = null;
    if (im.prNumber !== null && im.prUrl) {
      const s = await liveState(d.exec, repo, `pulls/${im.prNumber}`);
      if (s === "CLOSED") return fail(`our PR #${im.prNumber} was closed`, false);
      url = im.prUrl;
    } else {
      const headOwners = [who.login, ...(await githubIdentity(db) === "app" ? [ownerOf(repo)] : [])];
      const sel = await ownPrSelect(db, repo, headOwners, base);
      const found = await d.exec("gh", ["pr", "list", "--repo", slugOf(repo), "--state", "open", "--head", branch, "--json", sel.json, "--jq", sel.jq]);
      if (found.code !== 0) return fail(`the open PRs could not be listed: ${oneLine(found.stderr)}`, true);
      const existing = found.stdout.trim().split("\n")[0] ?? "";
      if (existing && urlOk(existing, repo)) url = existing;
    }
    const adopted = url !== null;
    let g: GuardedItem | null = null;

    if (url === null) {
      if (await hasOpenPr(db, repo, number)) return fail("another pull request already covers the issue", false);
      const git = new Git(d.exec, d.root, repo);
      if (!await git.fetchBranch(ownerOf(repo), repo, base, im.baseSha)) return fail("the base commit is no longer in the repository", false);
      const author = await commitIdentity(db, repo, async () => who);
      const made = await commitDiff(git, d.root, im.baseSha, input.diff, (c) => implCommitMessage(title, number, c.files.map((f) => f.path)), { name: author.name, email: author.email });
      if (!made.ok) return fail(made.reason, false, made.problems);
      const gi = await guard();
      if (typeof gi === "string") return fail(gi, true);
      g = gi;
      const rg = await guardRepo(db, repo, "fix-issue", input.by);
      if ("refused" in rg) return fail(rg.refused, true);
      const fork = await forkOnce(repo, () => forkOf(w, rg, d.exec, who.login, repo, run));
      const push = await pushOwnBranch(w, g, git, "implement-push", { repo, number, remote: fork, branch, sha: made.commit }, { ...run, fork, base: im.baseSha });
      if (push.code !== 0) return fail(`the push failed: ${oneLine(push.stderr)}`, true);
      if (await issueClosedLive(db, d, repo, number)) return fail("the issue is closed", false);
      const body = implPrBody({ number, summary: im.report?.summary ?? im.plan?.summary ?? "", checks: input.checks, plan: im.planMd ?? im.plan?.plan ?? null, model: input.model, manifests: made.check.manifests, draft });
      const pr = await ghOpenPr(w, g, d.exec, "implement-pr", { repo, target: ref, base, head: `${fork.split("/")[0]}:${branch}`, title, body, draft },
        { by: "model", kind: "pull request", model: input.model }, { ...run, branch });
      const out = pr.stdout.trim().split("\n").pop() ?? "";
      if (pr.code !== 0 || !urlOk(out, repo)) return fail(`gh pr create: ${oneLine(pr.stderr || pr.stdout)}`, true);
      url = out;
      const bytes = Buffer.from(input.diff);
      await updateImplementation(db, im.id, { branch, prNumber: prNumberOf(url), prUrl: url, diffHash: createHash("sha256").update(bytes).digest("hex"), diffStat: diffStat(bytes) });
      d.log(`  ${ref}: opened ${url}`);
    } else if (im.prUrl !== url) {
      await updateImplementation(db, im.id, { branch, prNumber: prNumberOf(url), prUrl: url });
      d.log(`  ${ref}: adopted ${url}`);
    }
    const prNumber = prNumberOf(url);

    if (!g) {
      const gi = await guard();
      if (typeof gi === "string") return fail(gi, true);
      g = gi;
    }
    if (!await mirrorPr(db, d, repo, prNumber)) return fail(`#${prNumber} is not in the mirror yet`, true);
    const isDraft = draft || !!(await db.get(db.k.selectFrom("main.items").select("is_draft").where("repo", "=", repo).where("number", "=", prNumber)))?.is_draft;
    let notPreapproved: string | null = null;
    if (isDraft) notPreapproved = "a draft is not pre-approved";
    else {
      try {
        await preapproveMerge(db, { repo, number: prNumber, by: im.queuedBy, via: "implement" });
      } catch (e) {
        const why = oneLine(String((e as Error).message ?? e));
        if (!/already has a pre-approved merge/.test(why)) { notPreapproved = why; d.log(`  ${ref}: #${prNumber} not pre-approved: ${why}`); }
      }
    }
    try {
      const weight = (await db.get(db.k.selectFrom("main.fast_track").select("weight").where("repo", "=", repo).where("number", "=", number)))?.weight;
      await addFastTrack(db, im.queuedBy, `${repo}#${prNumber}`, weight ?? undefined, "implement");
    } catch (e) {
      d.log(`  ${ref}: #${prNumber} not fast-tracked: ${oneLine(String((e as Error).message ?? e))}`);
    }
    await commentOnce(db, d, g, im, { number: prNumber, url, draft: isDraft }, input.run);
    await setImplementationState(db, im.id, "pr-opened", { branch, prNumber, prUrl: url, reason: notPreapproved });
    return { ok: true, url, number: prNumber, branch, adopted, draft: isDraft, notPreapproved };
  } catch (e) {
    return fail(oneLine(String((e as Error).message ?? e)), true);
  }
}

