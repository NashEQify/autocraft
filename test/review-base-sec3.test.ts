// A review binds the base branch its diff was read against; a Merge answer carried across a base merge covers no fix-up.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mergeDecisionId } from "../src/core/rules.ts";
import { recordLiveBase } from "../src/merge/base.ts";
import { premergeAt } from "../src/premerge/store.ts";
import { advancePreapprovals, preapprovalOf } from "../src/preapproval/index.ts";
import { markedStaleSince, staleReviews } from "../src/review/discussion.ts";
import { reviewHold } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());
const answerOf = async (w: World, n: number, head: string) => await w.db.all(w.db.k.selectFrom("decisions").select("answer").where("id", "=", mergeDecisionId("app", n, head)));
