import assert from "node:assert/strict";
import { test } from "node:test";
import { inPilot } from "../src/pilot.ts";
import { refreshOutsideHolds, releaseOutside, setOutsideLimits } from "../src/outside.ts";
import { resumeStage } from "../src/push-outcomes.ts";
import { everySeq, mapSeq } from "../src/async-seq.ts";
import { connectDb } from "../src/db/open.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

async function setup() {
  const db = await connectDb(":memory:");
  await db.run(db.k.insertInto("tracked_repos").values({ name: "app", pipeline: 1 }).onConflict((oc) => oc.doNothing()));
  await db.run(db.k.insertInto("settings").values({ key: "pipeline_login", value: "bot" }));
  let n = 0;
  const add = async (author: string, kind: "pr" | "issue", minAgo: number, assoc = "NONE") =>
    await db.run(db.k.insertInto("items").values({ repo: "app", number: ++n, kind, state: "OPEN", author, author_association: assoc, created_at: ago(minAgo) })) && n;
  return { db, add };
}

test("an outside author's 6th PR in 24 hours waits; members and the pipeline's own account do not; Release lets it through", async () => {
  const { db, add } = await setup();
  const outsider = await mapSeq(Array.from({ length: 6 }, (_, k) => k), async (k) => await add("outsider", "pr", 600 - k * 10));
  const member = await mapSeq(Array.from({ length: 8 }, (_, k) => k), async (k) => await add("regular", "pr", 300 - k, "MEMBER"));
  const own = await add("bot", "pr", 5);
  const app = await mapSeq(Array.from({ length: 7 }, (_, k) => k), async (k) => await add("renovate[bot]", "pr", 100 - k));
  const old = await add("outsider", "pr", 30 * 60); // older than 24 hours: outside the window
  await refreshOutsideHolds(db, NOW);
  assert.deepEqual(await mapSeq(outsider, async (n) => await inPilot(db, "app", n)), [true, true, true, true, true, false]);
  assert.ok(await everySeq([...member, own, old, ...app], async (n) => await inPilot(db, "app", n)));

  await releaseOutside(db, "op", "app", outsider[5]!);
  await refreshOutsideHolds(db, NOW);
  assert.equal(await inPilot(db, "app", outsider[5]!), true, "a released item stays exempt");

  // Sticky admission: lowering the limit does not hold items that were let through.
  await setOutsideLimits(db, "op", { prsPerDay: 2 });
  await refreshOutsideHolds(db, NOW);
  assert.deepEqual(await mapSeq(outsider.slice(0, 5), async (n) => await inPilot(db, "app", n)), [true, true, true, true, true]);
  await setOutsideLimits(db, "op", { prsPerDay: 5 });

  // Items of a repo whose pipeline is off are neither counted nor held.
  await db.run(db.k.insertInto("tracked_repos").values({ name: "idle", pipeline: 0 }));
  for (let k = 1; k <= 8; k++) await db.run(db.k.insertInto("items").values({ repo: "idle", number: k, kind: "pr", state: "OPEN", author: "offauthor", author_association: "NONE", created_at: ago(50) }));
  await refreshOutsideHolds(db, NOW);
  assert.equal((await db.get(db.k.selectFrom("outside_holds").select((eb) => eb.fn.countAll<number>().as("n")).where("repo", "=", "idle")))!.n, 0);

  // The oldest items age out of the window: the held one starts by itself.
  const held = await add("outsider", "pr", 1);
  await refreshOutsideHolds(db, NOW);
  assert.equal(await inPilot(db, "app", held), false);
  await refreshOutsideHolds(db, NOW + 25 * 3_600_000 - 595 * 60_000);
  assert.equal(await inPilot(db, "app", held), true);
});

test("the surge breaker trips on many new outside items, holds only those, and stays until an operator resumes it", async () => {
  const { db, add } = await setup();
  await setOutsideLimits(db, "op", { prsPerDay: 0, issuesPerDay: 0, surgePerHour: 3 });
  const older = await add("early", "issue", 120);
  const insider = await add("regular", "pr", 10, "COLLABORATOR");
  const surge = [await add("a", "pr", 30), await add("b", "issue", 20), await add("c", "pr", 10), await add("d", "pr", 5)];
  await refreshOutsideHolds(db, NOW);
  assert.equal((await db.get(db.k.selectFrom("stage_trips").select("active").where("stage", "=", "outside-surge")))!.active, 1);
  assert.deepEqual(await mapSeq(surge, async (n) => await inPilot(db, "app", n)), [false, false, false, false]);
  assert.ok(await inPilot(db, "app", older) && await inPilot(db, "app", insider));

  await refreshOutsideHolds(db, NOW + 3 * 3_600_000);
  assert.equal(await inPilot(db, "app", surge[0]!), false, "no timer: the hold stays");
  await resumeStage(db, "outside-surge", "op");
  await refreshOutsideHolds(db, NOW + 3 * 3_600_000);
  assert.ok(await everySeq(surge, async (n) => await inPilot(db, "app", n)));
  assert.equal((await db.get(db.k.selectFrom("stage_trips").select("active").where("stage", "=", "outside-surge")))!.active, 0, "the old items do not trip it again");
});
