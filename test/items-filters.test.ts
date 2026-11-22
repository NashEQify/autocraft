// Items is one browser over two server endpoints: a phase URL reaches the status endpoint and every
// other URL the list endpoint, and neither receives the other's keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { itemFilter, parseBrowse, statusFilter } from "../web/src/modules/items/browseState.ts";

const of = (search: string) => parseBrowse(search.startsWith("?") ? search.slice(1) : search);

test("a phase link selects the status endpoint and sends it only what it serves", () => {
  const browse = of("phase=Fixing&q=crash&kind=pr&repo=wordcraft&discord=1&status=settled&label=bugfix&flag=security&author=ana&since=2026-01-01&flow=review.take-fix&sort=created&desc=0&run=org-1&limit=25&offset=50");
  assert.equal(browse.phase, "Fixing");
  const filter = statusFilter(browse);
  assert.deepEqual(Object.keys(filter).sort(), ["discord", "kind", "phase", "q", "repo"]);
  assert.deepEqual(filter, { q: "crash", phase: "Fixing", kind: "pr", repo: ["wordcraft"], discord: true });
  // The list filter builder never carries phase; the status builder never carries the rest.
  assert.equal(itemFilter(of("phase=Fixing&status=settled")).state, "open");
  assert.equal(Object.hasOwn(statusFilter(browse), "state"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "status"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "sort"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "offset"), false);
  assert.equal(Object.hasOwn(statusFilter(browse), "limit"), false);
});

test("a classification URL keeps its filters on the list endpoint and never gains a phase", () => {
  const browse = of("state=all&status=waiting&label=bugfix&flag=security&repo=photocraft,deckcraft&q=dialog&sort=created&limit=100&offset=100");
  const filter = itemFilter(browse);
  assert.equal(filter.state, "all");
  assert.deepEqual(filter.status, ["waiting"]);
  assert.equal(filter.label, "bugfix");
  assert.deepEqual(filter.flag, ["security"]);
  assert.deepEqual(filter.repo, ["photocraft", "deckcraft"]);
  assert.equal(filter.q, "dialog");
  assert.equal(filter.sort, "created");
  assert.equal(filter.limit, 100);
  assert.equal(filter.offset, 100);
  assert.equal(Object.hasOwn(filter, "phase"), false);
});
