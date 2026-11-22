// Who may resume a tripped breaker: operators any; maintainers a push breaker when they can write to every repo it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeTrips, trip } from "../src/push-outcomes.ts";
import { resumeTrip } from "../src/dash/api/pipeline.ts";
import { connectDb } from "../src/db/open.ts";

const as = (role: string, stage: string, writable: string[]) => ({
  method: "POST", path: "", params: { stage }, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
  user: { login: "m1", role, canWrite: async (r: string) => writable.includes(r), canRead: async () => true },
}) as never;

test("a maintainer resumes a push breaker only with write access to every repo it names", async () => {
  const db = await connectDb(":memory:");
  const at = "2026-01-01T00:00:00Z";
  const tripFixup = async () => await trip(db, "fixup", "2 of the last 10 fixup pushes broke a required check", ["a#1@abcd1234", "b#2@ef012345"], at);
  await tripFixup();
  await assert.rejects(resumeTrip(db, as("maintainer", "fixup", ["a"])), { status: 403 });
  await assert.rejects(resumeTrip(db, as("viewer", "fixup", ["a", "b"])), { status: 403 });
  assert.ok((await activeTrips(db)).fixup);
  await resumeTrip(db, as("maintainer", "fixup", ["a", "b"]));
  assert.equal((await activeTrips(db)).fixup, undefined);
  assert.equal((await db.get(db.k.selectFrom("stage_trips").select("cleared_by").where("stage", "=", "fixup")))?.cleared_by, "m1");
  // A trip that names no repo, and the outside-author surge breaker, stay with operators.
  await trip(db, "cifix", "x", [], at);
  await assert.rejects(resumeTrip(db, as("maintainer", "cifix", ["a"])), { status: 403 });
  await trip(db, "outside-surge", "41 new items", [], at);
  await assert.rejects(resumeTrip(db, as("maintainer", "outside-surge", ["a"])), { status: 403 });
  await resumeTrip(db, as("operator", "outside-surge", []));
  assert.equal((await activeTrips(db) as Record<string, string>)["outside-surge"], undefined);
});
