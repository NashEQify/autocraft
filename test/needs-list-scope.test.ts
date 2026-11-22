// A Needs list cursor carries its reader and filter scope and never decodes outside it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { privateCursor, scopeString, unwrapCursor } from "../web/src/modules/decisions/list-scope.ts";

const scope = { login: "ana", role: "operator", search: "repo=deckcraft&kind=scope" };

test("an internal cursor round-trips inside its own scope and fails closed outside it", () => {
  for (const server of ["abc", "a|b", "cursor/with+chars", "café", JSON.stringify(["x", "y"])]) {
    const raw = privateCursor(scopeString(scope), server);
    const unwrapped = unwrapCursor(raw, scopeString(scope));
    assert.deepEqual(unwrapped, { ok: true, cursor: server });
    // The backend never sees the scope or the JSON: only the server cursor.
    assert.equal(unwrapped.ok && unwrapped.cursor?.includes("ana"), false);
  }
  // `undefined` is the first page and stays distinct from any decoded value.
  assert.deepEqual(unwrapCursor(undefined, scopeString(scope)), { ok: true, cursor: undefined });
  // The server never emits an empty continuation; a decoded empty string is invalid, not a first page.
  assert.deepEqual(unwrapCursor(privateCursor(scopeString(scope), ""), scopeString(scope)), { ok: false, reason: "empty" });
  // Another reader/filter, a malformed value or the wrong shape fails closed.
  assert.deepEqual(unwrapCursor(privateCursor(scopeString({ ...scope, login: "bo" }), "abc"), scopeString(scope)), { ok: false, reason: "scope" });
  assert.deepEqual(unwrapCursor(privateCursor(scopeString({ ...scope, search: "repo=deckcraft" }), "abc"), scopeString(scope)), { ok: false, reason: "scope" });
  assert.deepEqual(unwrapCursor("not json", scopeString(scope)), { ok: false, reason: "malformed" });
  assert.deepEqual(unwrapCursor("[\"only-one\"]", scopeString(scope)), { ok: false, reason: "malformed" });
  assert.deepEqual(unwrapCursor(JSON.stringify([scopeString(scope), 7]), scopeString(scope)), { ok: false, reason: "malformed" });
});
