// A task that requires `display` is routed to a pod environment whose settings declare it, and to no other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kubeCapabilities, parseSettings } from "../src/build/pods.ts";
import { satisfies } from "../src/build/tasks.ts";

const base = { toolchainImages: { "rust-stable": "rust-stable:test" } };

test("display tasks are claimed only by pod environments declared with display", () => {
  const req = { display: true, toolchains: ["rust-stable"] };
  assert.equal(satisfies(kubeCapabilities(parseSettings({ ...base, display: true })), req), true);
  assert.equal(satisfies(kubeCapabilities(parseSettings(base)), req), false);
  assert.equal(satisfies(kubeCapabilities(parseSettings({ ...base, display: true })), { toolchains: ["rust-stable"] }), true);
});
