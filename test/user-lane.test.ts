// The user lane's reading of GitHub's refusals: which ones are transient and which mean the person's token or permission.
import assert from "node:assert/strict";
import { test } from "node:test";
import { authFailure } from "../src/github/user-lane.ts";

test("a rate limit is transient and a 403 or 404 status is no access; words and numbers in the text decide nothing", () => {
  assert.equal(authFailure(new Error("gh failed: You have exceeded a secondary rate limit (HTTP 403)")), "transient");
  assert.equal(authFailure(new Error("gh failed: Resource not accessible by integration (HTTP 403)")), "waiting-permission");
  assert.equal(authFailure(new Error("gh failed: Bad credentials (HTTP 401)")), "waiting-token");
  assert.equal(authFailure(new Error("refused: app#403 not found, bad credentials in the title")), null);
});
