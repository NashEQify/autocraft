import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/workflow/apply.ts";
import { parse } from "../src/workflow/parse.ts";
import { runText, type ReadDeps } from "../src/workflow/read.ts";
import { liveWorkflow } from "../src/workflow/store.ts";
import { actor, unstarted } from "./workflow-start-world.ts";
import type { World } from "./world-db.ts";

const item = { repo: "app", number: 1 };
const send = async (w: World, text: string, deps: ReadDeps) =>
  (await runText(w.db, actor, "github", { parsed: parse(text, { repo: "app" }), items: [item] }, { text, own: [item], named: false, parse: { repo: "app" }, deps })).items[0]!;
const reads = (command: string, confidence: number): ReadDeps => ({ translate: async () => ({ command, confidence }), score: async () => null });

test("a message the parser cannot read runs the command a model reads in it when the reading is clear, and is proposed otherwise", async () => {
  const w = await unstarted();
  const text = "could you take a look at this one for me";
  assert.equal(parse(text).kind, "ambiguous");

  const unsure = await send(w, text, reads("review", 0.6));
  assert.equal(unsure.outcome, "ambiguous");
  assert.match(unsure.line, /`review`/);
  const hedged = await send(w, "maybe take a look at this one", reads("review", 0.95));
  assert.equal(hedged.outcome, "ambiguous");
  assert.equal(await liveWorkflow(w.db, "app", 1), null);

  const clear = await send(w, text, reads("review", 0.95));
  assert.equal(clear.outcome, "run", clear.line);
  assert.match(clear.line, /`review`/);
  assert.equal((await liveWorkflow(w.db, "app", 1))?.entry, "review");
});

test("with no reading (no Task Runner took the call), the reply is the parser's own", async () => {
  const w = await unstarted();
  const text = "could you take a look at this one for me";
  const own = (await runCommand(w.db, actor, "github", { parsed: parse(text, { repo: "app" }), items: [item] })).items[0]!;
  const none = await send(w, text, { translate: async () => null });
  assert.deepEqual({ outcome: none.outcome, line: none.line }, { outcome: own.outcome, line: own.line });
});
