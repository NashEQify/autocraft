// The Needs scope reads exactly the URL keys the decisions endpoint reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScope } from "../web/src/modules/decisions/needs-controls.ts";

const KINDS = ["scope", "duplicate", "close", "merge", "hold", "split", "other"];

test("the scope parses exactly the keys the server reads", () => {
  const scope = parseScope("?repo=deckcraft&kind=scope,merge&age=3&all=1", KINDS);
  assert.deepEqual(scope.repo, ["deckcraft"]);
  assert.deepEqual(scope.kind, ["scope", "merge"]);
  assert.equal(scope.minAge, 3);
  assert.equal(scope.all, true);
  assert.deepEqual(scope.unusedKinds, []);
  assert.equal(scope.unusedAge, undefined);
  assert.deepEqual(parseScope("", KINDS), { repo: [], kind: [], minAge: undefined, all: false, unusedKinds: [], unusedAge: undefined, cappedAge: undefined, raw: { repo: [], kind: [], age: undefined } });
});
