import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { runnerRoomIn, stallNotices, type StalledCall } from "../src/core/runner-room.ts";
import { loadConversationsOfItem, loadMessages } from "../src/data/chat/index.ts";
import type { RunnerRow, RunnerSnapshot, UserSettings } from "../src/data/runners/index.ts";
import { startWorkflows } from "../src/data/workflow/index.ts";
import type { Db } from "../src/db/index.ts";
import { connectDb } from "../src/db/open.ts";
import type { RemoteView } from "../src/remote/view.ts";
import { RULE_STARTER } from "../src/workflow/types.ts";
import { tmpdir } from "./world-db.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const LATER = "2026-06-01T15:00:00.000Z", SOONER = "2026-06-01T13:00:00.000Z";
const ACCEPTED = { top: ["opus"], mid: ["sonnet"], small: ["haiku"] };

const row = (tokenId: number, login: string, o: Partial<RunnerRow> = {}): RunnerRow => ({
  tokenId, login, role: "maintainer", label: null, machine: null, helperVersion: null, createdAt: "", expiresAt: "", canAgent: true, canAnswer: false,
  readiness: "ready", until: null, reason: null, harness: null, models: { top: "claude-opus-5", mid: "claude-sonnet-5" }, reserve: null, usage: null, reportedAt: NOW - 1000, slots: 2, busy: 0,
  lastError: null, idleClaimAt: NOW - 1000, idleTiers: null, idleRepos: null, leased: 0, ownLaneLeased: 0, beatAt: null, ...o,
});
const view = (runners: RunnerRow[], settings: Record<string, Partial<UserSettings>> = {}): RemoteView => ({
  now: NOW, accepted: ACCEPTED, snapshot: {
    at: NOW, runners, cooled: new Map(), denied: new Set(), leasedByLogin: new Map(), started: { live: [], prs: [], merged: [] },
    settings: new Map(Object.entries(settings).map(([l, s]) => [l as never, { reserve: { fiveHour: 20, weekly: 20 }, repos: [], maxCalls: null, interactiveSlots: null, manualOnly: false, skipTasks: [], taskItems: "all", runnerPrivate: false, ...s }])),
  } satisfies RunnerSnapshot,
});

test("a person's command finds whether a Task Runner can take its repo and tier now, and why not", () => {
  const ask = { repo: "app", login: "mira", tier: "top" as const };
  // A ready runner picked other repos and another is Manual only: the ready ones exclude the repo. With none ready at all, none is.
  assert.deepEqual(runnerRoomIn(view([row(1, "ana", { idleRepos: ["other"] }), row(2, "bo")], { bo: { manualOnly: true } }), ask), { can: false, own: false, why: "repo", until: null });
  assert.deepEqual(runnerRoomIn(view([row(1, "ana", { reportedAt: NOW - 3_600_000 })]), ask), { can: false, own: false, why: "none", until: null });

  // Every runner that takes it is held by its usage limit: the earliest end is when it can start.
  const held = view([row(1, "ana", { readiness: "quota-held", until: LATER }), row(2, "cy", { readiness: "quota-held", until: SOONER })]);
  assert.deepEqual(runnerRoomIn(held, ask), { can: false, own: false, why: "held", until: SOONER });

  // The person's own runner is the only one, held; Manual only does not keep it from their own work.
  assert.deepEqual(runnerRoomIn(view([row(3, "Mira", { readiness: "quota-held", until: LATER })], { mira: { manualOnly: true } }), ask), { can: false, own: true, why: "own-held", until: LATER });

  // A ready runner takes the repo but offers no model of the call's tier.
  assert.deepEqual(runnerRoomIn(view([row(1, "ana", { models: { mid: "claude-sonnet-5" } })]), ask), { can: false, own: false, why: "tier", until: null, tier: "top" });

  // Someone else's ready runner takes it, though the person has none of their own; their own takes it outside their My repos.
  assert.deepEqual(runnerRoomIn(view([row(1, "ana")]), ask), { can: true, own: false });
  assert.deepEqual(runnerRoomIn(view([row(3, "mira", { idleRepos: ["other"] })], { mira: { repos: ["other"] } }), ask), { can: true, own: true });
});

let db: Db | undefined;
afterEach(async () => db?.close());

test("a stalled call tells the person whose work it is once per reason in the item's chat, and nobody for the automatic rule's work", async () => {
  const d = db = await connectDb(join(tmpdir("runner-room"), "t.db"));
  await startWorkflows(d, [
    { repo: "app", number: 1, kind: "pr", entry: "review", weight: 5, startedBy: "mira", startedVia: "discord" },
    { repo: "app", number: 2, kind: "pr", entry: "merge", weight: 5, startedBy: RULE_STARTER, startedVia: "github" },
  ]);
  const call = (number: number): StalledCall => ({ prompt_id: "review.pr", repos: ["app"], refs: [{ repo: "app", number }], step: "review", tier: "top" });
  const notices = async () => {
    const convs = await loadConversationsOfItem(d, "app", 1);
    return [...(await loadMessages(d, convs.map((c) => c.id))).values()].flat().filter((m) => m.kind === "notice");
  };

  const none = view([]);
  assert.equal(await stallNotices(d, none, [call(1), call(2)]), 1);
  assert.equal(await stallNotices(d, none, [call(1), call(2)]), 0, "the same reason posts no second notice");
  const [first] = await notices();
  assert.match(first!.body, /No Task Runner can take this right now .*Set up your own Task Runner: \S*\/connect/);
  assert.equal((await loadConversationsOfItem(d, "app", 2)).length, 0, "the automatic rule's work tells nobody");

  // The only runner that would take it becomes held: a different reason, one more notice.
  assert.equal(await stallNotices(d, view([row(1, "ana", { readiness: "quota-held", until: LATER })]), [call(1)]), 1);
  assert.equal((await notices()).length, 2);
});
