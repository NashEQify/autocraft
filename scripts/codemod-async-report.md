# Async codemod report

- Files changed: 496
- Functions made async: 2830
- Function types made async: 165
- Awaits inserted: 13240
- Return types wrapped in Promise: 1868
- Sequential helpers: every 12, filter 53, find 9, flatMap 9, forEach 10, map 95, reduce 1, some 13, sort 2
- Transactions rewritten: write 42, read 1

## Plain BEGIN blocks (kind chosen from the block's own statements)

- src/core/plan-engine.ts:77 inReadSnapshot -> read
- src/discord/store.ts:35 recordMessage -> write
- src/downloads/poll.ts:107 foldDeltas -> write
- src/downloads/poll.ts:66 recordRepo -> write

## Residue for hand work

| Kind | Count |
| --- | --- |
| accessor | 4 |
| connect-tree | 9 |
| initializer | 13 |
| sync-callback | 1 |
| top-level | 105 |
| transaction | 26 |
| type-predicate | 3 |
| void-callback | 29 |

### accessor

- src/review/discussion.ts:309 `computeDiscussionState.map-callback.hash`: call of computeDiscussionState.prime inside a accessor, which cannot be async
- src/review/ours.ts:25 `madeBy.b`: a database call inside a accessor, which cannot be async
- src/review/ours.ts:26 `madeBy.c`: a database call inside a accessor, which cannot be async
- src/review/ours.ts:27 `madeBy.d`: a database call inside a accessor, which cannot be async

### connect-tree

- src/db.ts:389 `splitRunnerTokens`: called by connect() and by 2 converted call site(s), e.g. test/runner-credentials.test.ts:43
- src/db.ts:455 `migrateValues`: call of mentionNames inside connect()'s call tree, which stays synchronous
- src/db.ts:575 `ciFirst`: call of repoHasNoCi inside connect()'s call tree, which stays synchronous
- src/db.ts:637 `buildHashes`: call of fillEmbedHashes inside connect()'s call tree, which stays synchronous
- src/db.ts:638 `buildHashes`: call of fillClassHashes inside connect()'s call tree, which stays synchronous
- src/db.ts:655 `buildItemStage`: call of bulkWrites inside connect()'s call tree, which stays synchronous
- src/db.ts:655 `buildItemStage.<anonymous>`: would become async, but it is in connect()'s call tree
- src/fixissue/candidates.ts:99 `fillTextRefs.write`: would become async, but it is in connect()'s call tree
- src/fixissue/candidates.ts:100 `fillTextRefs`: call of bulkWrites inside connect()'s call tree, which stays synchronous

### initializer

- src/agents/accounts.ts:43 `syncAccounts`: call of boxAccounts in an initializer, which cannot await
- src/classify/run.ts:827 `runJev`: call of jevParallel in an initializer, which cannot await
- src/classify/settled.ts:178 `settledOf`: call of latestRun in an initializer, which cannot await
- src/conversations/queue.ts:81 `queuePlaces`: call of queuedCards in an initializer, which cannot await
- src/dupes/canonical.ts:37 `canonInfo`: call of canonInfoAll in an initializer, which cannot await
- src/flow/count.ts:53 `Ctx.constructor`: call of latestRun in an initializer, which cannot await
- src/flow/count.ts:448 `countAll`: call of latestRun in an initializer, which cannot await
- src/flow/summary.ts:85 `countRepo`: call of latestRun in an initializer, which cannot await
- src/outside.ts:83 `isOutsideAuthor`: call of insiders in an initializer, which cannot await
- src/prbuild/select.ts:43 `inBuildScope`: call of baseScopeRepos in an initializer, which cannot await
- src/review/discussion.ts:337 `reviewRequestedSince`: call of discussionState in an initializer, which cannot await
- src/runner/autopilot.ts:278 `fingerprintOf`: call of readSeqs in an initializer, which cannot await
- test/cifix.test.ts:251 `<anonymous>.formatRun`: call of fresh in an initializer, which cannot await

### sync-callback

- src/runner/autopilot.ts:1284 `laneItems.waits.map-callback`: Array.map callback cannot take an async callback (optional chain, thisArg or no sequential helper)

### top-level

- scripts/golive-gate.ts:39 `<top-level>`: top-level await of connect
- scripts/golive-gate.ts:45 `<top-level>`: top-level await of call of planPass
- scripts/golive-gate.ts:46 `<top-level>`: top-level await of call of computeLiveness
- scripts/golive-gate.ts:54 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:55 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:57 `<top-level>`: top-level await of call of pipelineRepos
- scripts/golive-gate.ts:58 `<top-level>`: top-level await of call of setCommentApproval
- scripts/golive-gate.ts:99 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:107 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:108 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:130 `<top-level>`: top-level await of call of getDecision
- scripts/golive-gate.ts:133 `<top-level>`: top-level await of call of canSettleCached
- scripts/golive-gate.ts:139 `<top-level>`: top-level await of call of decisionStamp
- scripts/golive-gate.ts:140 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:145 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:148 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:150 `<top-level>`: top-level await of call of dashboard
- scripts/golive-gate.ts:150 `<top-level>`: top-level await of call of getDecision
- scripts/golive-gate.ts:168 `<top-level>`: top-level await of call of dashboard
- scripts/golive-gate.ts:169 `<top-level>`: top-level await of call of getDecision
- scripts/golive-gate.ts:170 `<top-level>`: top-level await of call of openDispute
- scripts/golive-gate.ts:175 `<top-level>`: top-level await of call of clearDispute
- scripts/golive-gate.ts:178 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:189 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:191 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:192 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:194 `<top-level>`: top-level await of a database call
- scripts/golive-gate.ts:197 `<top-level>`: top-level await of call of planPass
- scripts/golive-gate.ts:198 `<top-level>`: top-level await of call of computeLiveness
- scripts/golive-gate.ts:199 `<top-level>`: top-level await of call of refreshLiveness
- scripts/remote-claim-bench.ts:16 `<top-level>`: top-level await of connect
- scripts/remote-claim-bench.ts:17 `<top-level>`: top-level await of call of setInferenceMode
- scripts/remote-claim-bench.ts:27 `<top-level>`: top-level await of call of caller
- scripts/remote-claim-bench.ts:29 `<top-level>`: top-level await of call of caller
- scripts/remote-claim-bench.ts:30 `<top-level>`: top-level await of a database call
- scripts/remote-claim-bench.ts:31 `<top-level>`: top-level await of a database call
- scripts/remote-claim-bench.ts:35 `<top-level>`: top-level await of a database call
- scripts/remote-claim-bench.ts:36 `<top-level>`: top-level await of a database call
- scripts/remote-claim-bench.ts:37 `<top-level>`: top-level await of call of enqueueCall
- scripts/remote-claim-bench.ts:54 `<top-level>`: top-level await of a database call
- src/runner/worker.ts:12 `<top-level>`: top-level await of connect
- test/account-token.test.ts:56 `<top-level>`: top-level await of connect
- test/admin.test.ts:25 `<top-level>`: top-level await of connect
- test/api-shapes.test.ts:17 `<top-level>`: top-level await of call of issue
- test/api-shapes.test.ts:17 `<top-level>`: top-level await of call of pr
- test/api-shapes.test.ts:17 `<top-level>`: top-level await of call of premerge
- test/api-shapes.test.ts:17 `<top-level>`: top-level await of call of repo
- test/api-shapes.test.ts:17 `<top-level>`: top-level await of call of review
- test/api-shapes.test.ts:17 `<top-level>`: top-level await of call of verified
- test/api-shapes.test.ts:17 `<top-level>`: top-level await of call of world
- test/api-shapes.test.ts:18 `<top-level>`: top-level await of a database call
- test/api-shapes.test.ts:19 `<top-level>`: top-level await of a database call
- test/api-shapes.test.ts:21 `<top-level>`: top-level await of a database call
- test/api.test.ts:31 `<top-level>`: top-level await of connect
- test/auth-hardening.test.ts:19 `<top-level>`: top-level await of connect
- test/build.test.ts:24 `<top-level>`: top-level await of connect
- test/claude-accounts.test.ts:43 `<top-level>`: top-level await of connect
- test/discord-file-issue.test.ts:19 `<top-level>`: top-level await of connect
- test/discord-file-issue.test.ts:21 `<top-level>`: top-level await of a database call
- test/discord-issue-new.test.ts:26 `<top-level>`: top-level await of connect
- test/discord-issue-new.test.ts:28 `<top-level>`: top-level await of call of useTestAccount
- test/discord-links.test.ts:14 `<top-level>`: top-level await of connect
- test/discord-mentions.test.ts:19 `<top-level>`: top-level await of connect
- test/discord-react.test.ts:15 `<top-level>`: top-level await of connect
- test/discord-search.test.ts:26 `<top-level>`: top-level await of connect
- test/discord-search.test.ts:28 `<top-level>`: top-level await of call of useTestAccount
- test/discord-signals.test.ts:17 `<top-level>`: top-level await of connect
- test/github-app.test.ts:31 `<top-level>`: top-level await of connect
- test/images.test.ts:41 `<top-level>`: top-level await of connect
- test/itemtools-safety.test.ts:20 `<top-level>`: top-level await of connect
- test/itemtools-safety.test.ts:21 `<top-level>`: top-level await of a database call
- test/itemtools-safety.test.ts:22 `<top-level>`: top-level await of a database call
- test/itemtools-safety.test.ts:24 `<top-level>`: top-level await of a database call
- test/itemtools-safety.test.ts:25 `<top-level>`: top-level await of a database call
- test/itemtools-safety.test.ts:26 `<top-level>`: top-level await of a database call
- test/itemtools-safety.test.ts:27 `<top-level>`: top-level await of a database call
- test/itemtools-safety.test.ts:28 `<top-level>`: top-level await of a database call
- test/itemtools-safety.test.ts:29 `<top-level>`: top-level await of a database call
- test/job-items.test.ts:16 `<top-level>`: top-level await of connect
- test/mcp.test.ts:28 `<top-level>`: top-level await of connect
- test/pipeline.test.ts:30 `<top-level>`: top-level await of connect
- test/prompts.test.ts:18 `<top-level>`: top-level await of connect
- test/prompts.test.ts:19 `<top-level>`: top-level await of call of useTestAccount
- test/prompts.test.ts:23 `<top-level>`: top-level await of a database call
- test/reference.test.ts:19 `<top-level>`: top-level await of connect
- test/reference.test.ts:20 `<top-level>`: top-level await of call of trackRepo
- test/runner.test.ts:23 `<top-level>`: top-level await of connect
- test/runner.test.ts:24 `<top-level>`: top-level await of a database call
- test/secfix-rounds.test.ts:19 `<top-level>`: top-level await of connect
- test/secfix-rounds.test.ts:21 `<top-level>`: top-level await of a database call
- test/secfix-rounds.test.ts:26 `<top-level>`: top-level await of a database call
- test/security-fix-land.test.ts:24 `<top-level>`: top-level await of connect
- test/security-fix-land.test.ts:26 `<top-level>`: top-level await of a database call
- test/security-scan-tests.test.ts:21 `<top-level>`: top-level await of connect
- test/security-scan-tests.test.ts:23 `<top-level>`: top-level await of a database call
- test/security-scan-tests.test.ts:26 `<top-level>`: top-level await of a database call
- test/security-scan-tests.test.ts:27 `<top-level>`: top-level await of a database call
- test/security-scan-tests.test.ts:28 `<top-level>`: top-level await of call of scopeToTracked
- test/security-scan.test.ts:32 `<top-level>`: top-level await of connect
- test/server.test.ts:53 `<top-level>`: top-level await of connect
- test/step-repo.test.ts:19 `<top-level>`: top-level await of connect
- test/step-repo.test.ts:20 `<top-level>`: top-level await of a database call
- test/stuck-jobs.test.ts:26 `<top-level>`: top-level await of connect
- test/visibility-sec3.test.ts:23 `<top-level>`: top-level await of connect
- test/visibility.test.ts:30 `<top-level>`: top-level await of connect

### transaction

- src/agents/call.ts:271 `tryStartClaudeRun`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/agents/call.ts:295 `pollClaude`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/agents/call.ts:361 `tryStartFollowUp`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/build/tasks.ts:183 `claim`: statements with calls after COMMIT inside the try
- src/conversations/act.ts:130 `answerDecision`: statements with calls after COMMIT inside the try
- src/conversations/act.ts:581 `doCard`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/conversations/act.ts:646 `failQueued`: return inside the block, which is not the end of the function
- src/core/plan-changes.ts:183 `bulkWrites`: conditional BEGIN: the Db joins nested transactions, so this can become db.write
- src/dash/api/conversations.ts:340 `doChoice`: ROLLBACK, COMMIT or BEGIN inside the block (early rollback and return): needs a hand rewrite
- src/decide/choices-convert.ts:134 `convertOpenDecisions`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/decide/choices.ts:309 `writeChoices`: conditional BEGIN: the Db joins nested transactions, so this can become db.write
- src/decisions.ts:154 `ask`: conditional BEGIN: the Db joins nested transactions, so this can become db.write
- src/discord/links.ts:31 `redeemLinkCode`: ROLLBACK, COMMIT or BEGIN inside the block (early rollback and return): needs a hand rewrite
- src/dupes/decide.ts:212 `askGroupDecisions`: statements with calls after COMMIT inside the try
- src/github/write.ts:198 `tryBegin`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/postmerge/file.ts:47 `claim`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/prbuild/index.ts:34 `queuePrBuild`: ROLLBACK, COMMIT or BEGIN inside the block (early rollback and return): needs a hand rewrite
- src/preapproval/index.ts:118 `cancelRow`: BEGIN without a matching COMMIT in the same block
- src/preapproval/index.ts:289 `handOver`: ROLLBACK, COMMIT or BEGIN inside the block (early rollback and return): needs a hand rewrite
- src/preapproval/index.ts:564 `carryAnswers`: BEGIN without a matching COMMIT in the same block
- src/remote/calls.ts:418 `leaseCall`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/remote/device-login.ts:138 `approveLogin`: statements with calls after COMMIT inside the try
- src/remote/liveness.ts:21 `stampAlive`: try block of another shape (no COMMIT at the end, a catch other than ROLLBACK + rethrow, or a finally)
- src/remote/picks.ts:139 `pickCall`: BEGIN without a matching COMMIT in the same block
- src/runner/leases.ts:25 `take`: ROLLBACK, COMMIT or BEGIN inside the block (early rollback and return): needs a hand rewrite
- src/runner/runner.ts:477 `Runner.start`: BEGIN without a matching COMMIT in the same block

### type-predicate

- src/conversations/cards.ts:318 `isTracked`: a database call inside a type-predicate, which cannot be async
- src/dash/api/build.ts:95 `postFeature.tracked`: a database call inside a type-predicate, which cannot be async
- src/security/actions.ts:167 `advanceSecurityFixes.filter-callback`: call of getTask inside a type-predicate, which cannot be async

### void-callback

- src/classify/progress.ts:72 `coalesce.run`: setTimeout(callback) ignores the returned promise (fire and forget)
- src/dash/server/index.ts:292 `createApp.<anonymous>`: setInterval(callback) ignores the returned promise (fire and forget)
- src/dash/server/live.ts:87 `LiveHub.start.<anonymous>`: setInterval(callback) ignores the returned promise (fire and forget)
- src/dash/server/live.ts:88 `LiveHub.start.<anonymous>`: setInterval(callback) ignores the returned promise (fire and forget)
- src/discord/alerts.ts:176 `DecisionAlerts.start.<anonymous>`: setInterval(callback) ignores the returned promise (fire and forget)
- src/health.ts:33 `startHealthServer.<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- src/remote/liveness.ts:51 `startLiveness.tick`: setInterval(callback) ignores the returned promise (fire and forget)
- src/remote/tools.ts:129 `closeSnapshot`: setTimeout(callback) ignores the returned promise (fire and forget)
- src/runner/runner.ts:504 `Runner.start.<anonymous>.on-callback`: InternalEventEmitter.on(listener) ignores the returned promise (fire and forget)
- src/runner/runner.ts:527 `Runner.stop.<anonymous>`: setInterval(callback) ignores the returned promise (fire and forget)
- test/build.test.ts:42 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/build.test.ts:46 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-file-issue.test.ts:20 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-issue-new.test.ts:29 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-links.test.ts:16 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-mentions.test.ts:23 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-mentions.test.ts:40 `<anonymous>.<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-react.test.ts:16 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-search.test.ts:29 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-signals.test.ts:19 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/discord-signals.test.ts:41 `<anonymous>.<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/github-app.test.ts:145 `<anonymous>.<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/health.test.ts:10 `<anonymous>.<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/itemtools.test.ts:28 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/journeys.test.ts:307 `<anonymous>.<anonymous>.<anonymous>`: setInterval(callback) ignores the returned promise (fire and forget)
- test/security-fix-land.test.ts:64 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/security-scan-tests.test.ts:24 `<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/sync-health.test.ts:106 `<anonymous>.<anonymous>`: FunctionType ignores the returned promise (fire and forget)
- test/worker-hardening.test.ts:38 `<anonymous>.<anonymous>.<anonymous>`: setTimeout(callback) ignores the returned promise (fire and forget)

## Read-then-write candidates outside a transaction (841)

| Subsystem | Functions |
| --- | --- |
| (top-level) | 84 |
| act | 13 |
| agents | 40 |
| answers | 1 |
| areas | 11 |
| build | 18 |
| checktool | 2 |
| cifix | 17 |
| classify | 16 |
| conversations | 36 |
| core | 8 |
| dash | 106 |
| decide | 4 |
| discord | 30 |
| downloads | 5 |
| dupes | 18 |
| embed | 3 |
| fixissue | 17 |
| fixup | 21 |
| flow | 9 |
| github | 48 |
| labels | 7 |
| mainci | 3 |
| mainfix | 11 |
| memory | 2 |
| merge | 55 |
| nightly | 8 |
| postmerge | 8 |
| prbuild | 5 |
| preapproval | 16 |
| premerge | 2 |
| prepush | 5 |
| priority | 4 |
| rank | 2 |
| remote | 41 |
| repin | 5 |
| review | 25 |
| runner | 85 |
| sandbox | 2 |
| security | 29 |
| unassign | 1 |
| verify | 16 |
| worker | 2 |

### (top-level)

- src/access.ts:28 `checkGithubId`: reads 29: SELECT github_id FROM access WHERE login = ?; writes 32: UPDATE access SET github_id = ? WHERE login = ? AND github_i
- src/access.ts:64 `addLogin.<anonymous>`: reads 65: call getAccess; writes 66: INSERT INTO access (login, role, added_by, added_at, note, g
- src/access.ts:82 `removeLogin.<anonymous>`: reads 83: call getAccess; writes 86: DELETE FROM access WHERE login = ?
- src/access.ts:105 `setRole.<anonymous>`: reads 106: call getAccess; writes 110: UPDATE access SET role = ? WHERE login = ?
- src/access.ts:128 `run`: reads 130: call connect; writes 151: call addLogin
- src/activity.ts:90 `syncActivity`: reads 92: SELECT i.repo, i.number, i.head_oid AS head, i.updated_at FR; writes 105: call saveActivity
- src/author-ids.ts:60 `backfillAuthorIds`: reads 63: SELECT author, author_id FROM items i WHERE author IS NOT NU; writes 67: INSERT OR IGNORE INTO main.author_ids (login, id) VALUES (?,
- src/cli.ts:8 `main`: reads 31: call connect; writes 32: call scopeToTracked
- src/db.ts:316 `backfill`: reads 344: SELECT 1 FROM main.settings WHERE key = 'review_base_backfil; writes 345: UPDATE main.opus_reviews SET base_ref = (SELECT i.base_ref F
- src/db.ts:414 `addColumns`: reads 419: PRAGMA main.table_info(; writes 422: exec
- src/db.ts:426 `dropColumns`: reads 428: PRAGMA main.table_info(; writes 431: exec
- src/db.ts:437 `migrateValues`: reads 446: call migrateValues.scannedAt; writes 489: UPDATE main.access SET role = 'operator' WHERE role = 'admin
- src/db.ts:635 `buildHashes`: reads 636: SELECT 1 FROM main.settings WHERE key = 'hashes_built'; writes 637: call fillEmbedHashes
- src/db.ts:643 `buildTextRefs`: reads 644: SELECT 1 FROM main.settings WHERE key = 'text_refs_built'; writes 646: INSERT OR IGNORE INTO main.settings (key, value) VALUES ('te
- src/db.ts:703 `connect`: reads 704: call open; writes 705: exec
- src/db.ts:712 `open`: reads 722: call schemaStamp; writes 725: call migrateValues
- src/decisions-used.ts:22 `applyUsedAnswers`: reads 27: call actionable; writes 44: UPDATE main.decisions SET applied_at = ? WHERE id = ? AND ap
- src/decisions.ts:204 `backlogOpen`: reads 205: call backlogCandidates; writes 208: write block
- src/decisions.ts:229 `clearAskedStage.<anonymous>`: reads 231: SELECT stage, at FROM stages WHERE repo = ? AND number = ? O; writes 232: UPDATE item_stage SET stage = ?, at = ?, reviewed = ? WHERE 
- src/decisions.ts:242 `withdrawOpen`: reads 243: call backlogCandidates; writes 246: write block
- src/decisions.ts:272 `setTestRepo`: reads 273: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 275: INSERT INTO main.settings (key, value) VALUES (?, '1')
- src/decisions.ts:285 `answerAsSession`: reads 286: call sessionDecision; writes 292: call applyAnswer
- src/decisions.ts:309 `retryAsSession`: reads 310: call sessionDecision; writes 313: call retryDecision
- src/decisions.ts:324 `cardAsSession`: reads 325: SELECT id, repo, number, params, state FROM main.conversatio; writes 331: call doCard
- src/decisions.ts:345 `cardCmd`: reads 353: call connect; writes 353: call cardAsSession
- src/decisions.ts:357 `retryCmd`: reads 362: call connect; writes 362: call retryAsSession
- src/decisions.ts:366 `answerCmd`: reads 373: call connect; writes 373: call answerAsSession
- src/decisions.ts:382 `testRepoCmd`: reads 383: call connect; writes 390: call setTestRepo
- src/decisions.ts:393 `withdrawCmd`: reads 399: call connect; writes 399: call withdrawOpen
- src/decisions.ts:404 `backlogCmd`: reads 410: call connect; writes 410: call backlogOpen
- src/decisions.ts:415 `list`: reads 417: call connect; writes 427: call connect
- src/fasttrack.ts:63 `addFastTrack`: reads 65: call isTracked; writes 70: INSERT OR IGNORE INTO main.fast_track (repo, number, added_b
- src/fasttrack.ts:76 `setFastTrackWeight`: reads 79: SELECT 1 FROM main.fast_track WHERE repo = ? AND number = ?; writes 80: UPDATE main.fast_track SET weight = ? WHERE repo = ? AND num
- src/fasttrack.ts:176 `run`: reads 177: call connect; writes 187: call setFastTrackWeight
- src/itemhash.ts:55 `fill`: reads 59: all; writes 61: write block
- src/liveness.ts:131 `refreshLiveness`: reads 132: call setting; writes 135: write block
- src/mirror.ts:338 `writePage`: reads 354: call rememberSlug; writes 357: write block
- src/mirror.ts:407 `readRepoSince`: reads 416: call writePage; writes 416: call writePage
- src/mirror.ts:426 `syncRepo`: reads 429: SELECT high_water FROM repos WHERE name=?; writes 432: call readRepoSince
- src/mirror.ts:524 `syncBySearch`: reads 604: call window; writes 610: call readRepoSince
- src/mirror.ts:550 `syncBySearch.write`: reads 564: call writePage; writes 564: call writePage
- src/mirror.ts:569 `syncBySearch.window`: reads 575: call window; writes 576: call window
- src/mirror.ts:720 `refreshRepoList`: reads 723: call trackedNames; writes 728: call failRepo
- src/mirror.ts:764 `syncPerRepo`: reads 765: call refreshRepoList; writes 786: call syncRepo
- src/mirror.ts:835 `reconcileRepo`: reads 840: call writePage; writes 840: call writePage
- src/mirror.ts:875 `reconcileNext`: reads 876: call trackedNames; writes 879: call reconcileRepo
- src/mirror.ts:891 `runSync`: reads 893: call getSetting; writes 906: call syncBySearch
- src/mirror.ts:964 `sync`: reads 982: call connect; writes 984: DELETE FROM settings WHERE key='full_sync_cursor'
- src/operator-actions.ts:57 `reviewAgain`: reads 58: call openItem; writes 62: DELETE FROM opus_reviews WHERE repo = ? AND number = ? AND h
- src/operator-actions.ts:67 `verifyAgain`: reads 68: call openItem; writes 72: UPDATE verifications SET state = 'stale' WHERE repo = ? AND 
- src/operator-actions.ts:77 `fixAgain`: reads 78: call openItem; writes 82: DELETE FROM fix_attempts WHERE repo = ? AND number = ?
- src/operator-actions.ts:87 `batchAgain`: reads 88: call openItem; writes 92: call updateBatch
- src/operator-actions.ts:99 `run`: reads 106: call connect; writes 111: call backlogItem
- src/optional-checks.ts:35 `setOptionalCheck`: reads 38: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 41: call save
- src/optional-checks.ts:92 `run`: reads 94: call connect; writes 100: call setOptionalCheck
- src/outside.ts:49 `setOutsideLimits`: reads 51: call outsideLimits; writes 60: INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONF
- src/outside.ts:75 `backfillAdmitted`: reads 76: SELECT 1 FROM main.settings WHERE key = 'outside_admitted_ba; writes 78: INSERT OR IGNORE INTO main.outside_admitted (repo, number, a
- src/outside.ts:89 `insiders`: reads 91: call listAccess; writes 92: call allOwnLogins
- src/outside.ts:102 `refreshOutsideHolds`: reads 103: call outsideLimits; writes 127: call backfillAdmitted
- src/outside.ts:210 `releaseOutside`: reads 211: SELECT author FROM main.outside_holds WHERE repo = ? AND num; writes 214: INSERT OR IGNORE INTO main.outside_released (repo, number, b
- src/outside.ts:220 `releaseAuthor`: reads 221: SELECT repo, number FROM main.outside_holds WHERE author = ?; writes 225: INSERT OR IGNORE INTO main.outside_released (repo, number, b
- src/pilot.ts:41 `setRepoPipeline`: reads 42: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 43: UPDATE main.tracked_repos SET pipeline = ? WHERE name = ? AN
- src/pilot.ts:82 `setPilot`: reads 83: call parsePilotRefs; writes 84: INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONF
- src/push-outcomes.ts:47 `recordPush`: reads 52: SELECT state FROM main_ci WHERE repo = ? AND head_sha = ?; writes 60: INSERT INTO push_outcomes (at, stage, action, repo, number, 
- src/push-outcomes.ts:68 `resolvePushes`: reads 73: SELECT id, stage, before_res FROM push_outcomes WHERE repo =; writes 79: UPDATE push_outcomes SET number = ?, after_res = ?, outcome 
- src/push-outcomes.ts:130 `trip`: reads 131: call tripRow; writes 133: INSERT INTO stage_trips (stage, active, reason, evidence, tr
- src/push-outcomes.ts:142 `evaluatePushBreaker`: reads 143: call tripRow; writes 147: call trip
- src/push-outcomes.ts:154 `mainRedAfterMerge`: reads 155: call weMerged; writes 157: call trip
- src/push-outcomes.ts:161 `mergeDefect`: reads 163: call weMerged; writes 165: call trip
- src/push-outcomes.ts:173 `resumeStage`: reads 176: call tripRow; writes 179: UPDATE stage_trips SET active = 0, cleared_at = ?, cleared_b
- src/reference-lint.ts:171 `defaultSemanticDeps.haiku`: reads 172: call inferenceMode; writes 172: call runModelStep
- src/reference.ts:81 `importReference`: reads 82: call isTracked; writes 105: call audit
- src/reference.ts:146 `run`: reads 163: call connect; writes 163: call importReference
- src/repos.ts:24 `trackRepo`: reads 28: SELECT owner FROM main.repos WHERE name = ?; writes 33: INSERT INTO main.repos (name, owner) VALUES (?, ?)
- src/repos.ts:58 `trackRepoChecked`: reads 60: SELECT 1 FROM main.repos WHERE name = ?; writes 72: call trackRepo
- src/repos.ts:83 `purgeRepo`: reads 85: call isTracked; writes 86: write block
- src/repos.ts:154 `track`: reads 156: call connect; writes 156: call trackRepoChecked
- src/repos.ts:164 `untrack`: reads 166: call connect; writes 166: call untrackRepo
- src/repos.ts:168 `pipeline`: reads 174: call connect; writes 174: call setRepoPipeline
- src/repos.ts:181 `purge`: reads 184: call connect; writes 184: call purgeRepo
- src/repos.ts:197 `run`: reads 198: call connect; writes 203: call setGithubIdentityChecked
- src/settlers.ts:19 `setMaintainerWrites`: reads 20: call maintainerWritesOn; writes 21: INSERT INTO main.settings (key, value) VALUES (?, '1') ON CO
- src/whitelist.ts:205 `override.<anonymous>`: reads 210: call connect; writes 210: call setOverride
- src/whitelist.ts:215 `rule`: reads 216: call connect; writes 221: call setRule

### act

- src/act/approval.ts:21 `setCommentApproval`: reads 22: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 24: INSERT INTO main.settings (key, value) VALUES (?, ?)
- src/act/dupe-groups.ts:74 `actOnGroups`: reads 81: call groupDecisionsToAct; writes 95: call compareAgain
- src/act/dupe-groups.ts:221 `queueCarry`: reads 223: SELECT 1 FROM dupe_group_posts WHERE decision_id = ? AND num; writes 224: INSERT OR IGNORE INTO dupe_carries (decision_id, repo, numbe
- src/act/index.ts:169 `askHoldDecisions`: reads 172: call planned; writes 175: call withdrawHoldQuestion
- src/act/index.ts:185 `askCloseDecisions`: reads 186: call closeRows; writes 187: call setAsideSupersededQuestions
- src/act/index.ts:280 `runAct`: reads 292: call fillEmbedHashes; writes 292: call applyDuplicateAnswers
- src/act/index.ts:329 `runAct.save`: reads 330: call rowOf; writes 331: UPDATE actions SET state = ?, reason = ?, comment_url = COAL
- src/act/index.ts:335 `runAct.settle`: reads 336: call actionable; writes 338: UPDATE main.decisions SET applied_at = ? WHERE id = ? AND ap
- src/act/index.ts:340 `runAct.skip`: reads 341: call runAct.save; writes 342: call audit
- src/act/index.ts:451 `runAct.begin`: reads 453: call laneForDecision; writes 455: call setExecState
- src/act/index.ts:468 `runAct.comment`: reads 468: call runAct.asAnswerer; writes 468: call commentOn
- src/act/index.ts:469 `runAct.close`: reads 469: call runAct.asAnswerer; writes 469: call closeItem
- src/act/index.ts:517 `run`: reads 519: call connect; writes 519: call runAct

### agents

- src/agents/accounts.ts:43 `syncAccounts`: reads 43: call boxAccounts; writes 45: INSERT OR IGNORE INTO claude_accounts (id, label) VALUES (?,
- src/agents/accounts.ts:64 `setUsagePause`: reads 67: call usagePause; writes 69: INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT 
- src/agents/accounts.ts:122 `listAccounts`: reads 123: call boxAccounts; writes 124: call syncAccounts
- src/agents/accounts.ts:129 `updateAccount`: reads 130: call boxAccounts; writes 143: call syncAccounts
- src/agents/accounts.ts:171 `chooseAccount`: reads 172: call boxAccounts; writes 173: call syncAccounts
- src/agents/accounts.ts:194 `accountHasRoom`: reads 195: call boxAccounts; writes 196: call syncAccounts
- src/agents/accounts.ts:203 `freeSlots`: reads 204: call boxAccounts; writes 205: call syncAccounts
- src/agents/accounts.ts:225 `setJevParallel`: reads 227: call jevParallel; writes 228: INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT 
- src/agents/accounts.ts:237 `claudePauseReason`: reads 238: call boxAccounts; writes 239: call syncAccounts
- src/agents/accounts.ts:256 `recordUsageSamples`: reads 259: call boxAccounts; writes 262: INSERT OR IGNORE INTO account_usage_samples (account_id, t, 
- src/agents/call.ts:159 `queueRoom`: reads 160: call inferenceMode; writes 162: call freeSlots
- src/agents/call.ts:294 `pollClaude`: reads 307: call waiterOrder; writes 308: call freeSlots
- src/agents/call.ts:323 `startClaudeRun`: reads 327: call levelBand; writes 329: INSERT INTO model_waits (provider, class, level, job_id, ste
- src/agents/index.ts:19 `print`: reads 20: call connect; writes 20: call listAccounts
- src/agents/index.ts:28 `set`: reads 43: call connect; writes 43: call updateAccount
- src/agents/index.ts:51 `jev`: reads 52: call connect; writes 54: call setJevEnabled
- src/agents/index.ts:68 `pause`: reads 69: call connect; writes 81: call setUsagePause
- src/agents/index.ts:94 `run`: reads 95: call print; writes 96: call set
- src/agents/jev.ts:57 `setJevEnabled`: reads 58: call jevEnabled; writes 59: call put
- src/agents/jev.ts:76 `jevAvailable`: reads 77: call jevEnabled; writes 78: call put
- src/agents/jev.ts:88 `markJevUnavailable`: reads 89: call jevOutage; writes 91: call put
- src/agents/jev.ts:95 `markJevWorking`: reads 96: call jevOutage; writes 97: call clear
- src/agents/manage.ts:24 `addAccount`: reads 28: SELECT id FROM claude_accounts; writes 37: INSERT INTO claude_accounts (id, label, enabled, updated_by,
- src/agents/manage.ts:44 `beginLogin`: reads 45: call dirOf; writes 47: call audit
- src/agents/manage.ts:52 `sendCode`: reads 53: call dirOf; writes 58: call audit
- src/agents/manage.ts:62 `stopLogin`: reads 63: call dirOf; writes 64: call audit
- src/agents/manage.ts:69 `beginToken`: reads 70: call dirOf; writes 72: call audit
- src/agents/manage.ts:93 `sendTokenCode`: reads 94: call dirOf; writes 99: call audit
- src/agents/manage.ts:103 `stopToken`: reads 104: call dirOf; writes 105: call audit
- src/agents/manage.ts:110 `removeToken`: reads 111: call dirOf; writes 113: call recordTokenRemoved
- src/agents/manage.ts:118 `signOut`: reads 119: call dirOf; writes 125: call recordTokenRemoved
- src/agents/manage.ts:132 `refreshNow`: reads 133: call dirOf; writes 134: call refreshStatus
- src/agents/manage.ts:160 `AccountWatcher.tick`: reads 164: call syncAccounts; writes 171: call refreshStatus
- src/agents/runs.ts:257 `pruneRuns`: reads 259: call pruneRuns.maxBefore; writes 259: DELETE FROM agent_run_texts WHERE run_id <= ?
- src/agents/step.ts:112 `runModelStep`: reads 123: call jevAvailable; writes 127: call call
- src/agents/step.ts:167 `call`: reads 172: call askClaude; writes 175: call askJev
- src/agents/step.ts:227 `runTiered`: reads 229: call jevAvailable; writes 236: call jevAvailable
- src/agents/step.ts:230 `runTiered.map-callback.<anonymous>`: reads 231: call jevAvailable; writes 232: call runModelStep
- src/agents/tools.ts:75 `saveRemoteTools`: reads 77: SELECT result FROM main.remote_checks WHERE call_id = ? AND ; writes 94: call saveUses
- src/agents/tools.ts:97 `saveUses`: reads 99: SELECT id, command FROM model_checks WHERE run_id = ? ORDER ; writes 104: INSERT OR REPLACE INTO agent_run_tools (run_id, seq, tool, a

### answers

- src/answers/sweep.ts:34 `sweepStaleAnswers`: reads 35: SELECT * FROM main.decisions WHERE answer IS NOT NULL AND ap; writes 43: UPDATE main.decisions SET applied_at = ?, exec_state = 'done

### areas

- src/areas/assign.ts:32 `diffPaths.<anonymous>`: reads 36: SELECT value FROM settings WHERE key = 'sync_rate_remaining'; writes 37: call cachedDiff
- src/areas/assign.ts:89 `assignRepo`: reads 90: call currentList; writes 102: call jevAvailable
- src/areas/assign.ts:92 `assignRepo.store`: reads 94: call currentList; writes 95: call setItemArea
- src/areas/assign.ts:121 `assignAreas`: reads 122: call dueForArea; writes 128: call assignRepo
- src/areas/index.ts:41 `run`: reads 45: call connect; writes 62: call proposeAreas
- src/areas/propose.ts:28 `proposeAreas`: reads 30: SELECT COALESCE(i.title, '') AS title FROM items i WHERE i.r; writes 38: call askClaude
- src/areas/propose.ts:52 `suggestAreas`: reads 53: call currentList; writes 64: call askClaude
- src/areas/store.ts:100 `editAreas`: reads 101: SELECT 1 FROM tracked_repos WHERE name = ?; writes 154: call save
- src/areas/store.ts:215 `acceptProposal`: reads 216: call proposalById; writes 218: call editAreas
- src/areas/store.ts:223 `dismissProposal`: reads 224: call proposalById; writes 226: UPDATE area_proposals SET state = 'dismissed', decided_by = 
- src/areas/store.ts:230 `decideSuggestion`: reads 231: call proposalById; writes 238: call editAreas

### build

- src/build/artifacts.ts:73 `storeArtifact`: reads 78: SELECT artifact_bytes FROM build_tasks WHERE id = ?; writes 88: write block
- src/build/cli.ts:92 `envs`: reads 94: call connect; writes 107: call envs.<anonymous>
- src/build/envs.ts:129 `updateEnv`: reads 133: SELECT * FROM build_envs WHERE id = ?; writes 143: UPDATE build_envs SET label = ?, enabled = ?, slots = ?, con
- src/build/envs.ts:158 `rotateKey`: reads 159: SELECT 1 FROM build_envs WHERE id = ?; writes 161: UPDATE build_envs SET key_hash = ?, updated_by = ?, updated_
- src/build/features.ts:41 `stopQueuedTasks`: reads 45: SELECT id FROM build_tasks WHERE step = ? AND state NOT IN (; writes 46: call cancelTask
- src/build/rounds.ts:28 `queueRound`: reads 29: call createTask; writes 31: call queueWarmBuild
- src/build/rounds.ts:36 `requeueRound`: reads 36: call cloneTask; writes 36: call cloneTask
- src/build/tasks.ts:127 `createTask`: reads 139: SELECT COUNT(*) AS n FROM build_tasks WHERE state = 'queued'; writes 141: INSERT INTO build_tasks (job_id, step, repo, number, head_sh
- src/build/tasks.ts:231 `reapLost`: reads 233: SELECT id, attempts, cancel_requested_at FROM build_tasks WH; writes 238: call removeArtifacts
- src/build/tasks.ts:262 `startTask`: reads 263: call mine; writes 265: UPDATE build_tasks SET state = 'running', started_at = COALE
- src/build/tasks.ts:270 `heartbeat`: reads 271: SELECT state, env_id FROM build_tasks WHERE id = ?; writes 274: UPDATE build_tasks SET heartbeat_at = ? WHERE id = ?
- src/build/tasks.ts:282 `appendLog`: reads 283: call mine; writes 297: UPDATE build_tasks SET log_bytes = ? WHERE id = ? AND log_by
- src/build/tasks.ts:341 `finishTask`: reads 343: SELECT state, env_id FROM build_tasks WHERE id = ?; writes 353: UPDATE build_tasks SET state = ?, ended_at = ?, results = ?,
- src/build/tasks.ts:365 `cancelTask`: reads 367: SELECT * FROM build_tasks WHERE id = ?; writes 375: UPDATE build_tasks SET state = 'cancelled', ended_at = ?, ca
- src/build/tasks.ts:533 `pruneTasks`: reads 536: SELECT id FROM build_tasks WHERE ended_at IS NOT NULL AND en; writes 538: call removeArtifacts
- src/build/worker-api.ts:108 `handler.route`: reads 112: call authenticate; writes 123: call hello
- src/build/worker-update.ts:118 `requestUpdate`: reads 124: call busyTasks; writes 126: call putSetting
- src/build/worker-update.ts:137 `checkPendingUpdate`: reads 138: call pendingUpdate; writes 145: call clearSetting

### checktool

- src/checktool/index.ts:170 `CheckTool.close`: reads 173: call cancelTask; writes 173: call cancelTask
- src/checktool/index.ts:178 `CheckTool.runOne`: reads 192: call confidentialReadyAt; writes 198: INSERT INTO model_checks (run_id, step, repo, number, head, 

### cifix

- src/cifix/index.ts:190 `Recorder.pushing`: reads 191: call open; writes 192: UPDATE ci_fixes SET state = 'pushing', to_head = ?, files = 
- src/cifix/index.ts:210 `Recorder.dropUnlisted`: reads 212: SELECT rowid AS id, number, head, lint_task FROM ci_fixes WH; writes 220: UPDATE ci_fixes SET state = 'superseded', reason = 'the plan
- src/cifix/index.ts:228 `Recorder.set`: reads 232: call open; writes 234: UPDATE ci_fixes SET state = ?, reason = ?, files = ?, to_hea
- src/cifix/index.ts:376 `runCifix`: reads 379: call sweepSessions; writes 380: call runCifixWith
- src/cifix/index.ts:386 `runCifixWith`: reads 393: call selectCifix; writes 405: call dropUnlisted
- src/cifix/index.ts:425 `runCifixWith.deliver`: reads 433: call ensureAuthorWrites; writes 438: call set
- src/cifix/index.ts:553 `runCifixWith.collectFormat`: reads 556: call getTask; writes 558: call runCifixWith.collectFormat.fail
- src/cifix/index.ts:576 `runCifixWith.claim`: reads 577: call duplicateHeld; writes 580: call claimForWork
- src/cifix/index.ts:582 `runCifixWith.fixCode`: reads 584: call runCifixWith.claim; writes 592: call noteLive
- src/cifix/index.ts:609 `runCifixWith.collectLint`: reads 621: call runCifixWith.readPr; writes 625: call runCifixWith.collectLint.fail
- src/cifix/index.ts:660 `runCifixWith.workOne`: reads 663: call runCifixWith.readPr; writes 669: call runCifixWith.workOne.skip
- src/cifix/index.ts:786 `runCifixWith.<anonymous>`: reads 787: call runCifixWith.collectFormat; writes 791: call set
- src/cifix/index.ts:795 `runCifixWith.<anonymous>`: reads 796: call runCifixWith.collectLint; writes 800: call set
- src/cifix/index.ts:812 `runRerun`: reads 816: call selectCifix; writes 829: call leaseItem
- src/cifix/index.ts:876 `run`: reads 878: call connect; writes 878: call runCifix
- src/cifix/index.ts:883 `run`: reads 885: call connect; writes 885: call runRerun
- src/cifix/select.ts:7 `selectCifix`: reads 9: call planned; writes 23: call planned

### classify

- src/classify/index.ts:34 `current`: reads 35: call connect; writes 50: call setCurrentRun
- src/classify/index.ts:54 `classify`: reads 55: call current; writes 62: call connect
- src/classify/index.ts:97 `referee`: reads 100: call connect; writes 104: call markSpotCheck
- src/classify/referee.ts:44 `refereeItems.map-callback.<anonymous>`: reads 49: SELECT 1 FROM classifications WHERE repo = ? AND number = ? ; writes 51: call runModelStep
- src/classify/referee.ts:86 `markSpotCheck`: reads 88: SELECT repo, number, type_label FROM classifications WHERE c; writes 93: UPDATE main.classifications SET flags = '[]' WHERE classifie
- src/classify/run.ts:454 `askClaude`: reads 457: call askOnce; writes 461: call askOnce
- src/classify/run.ts:469 `askOnce`: reads 470: call inferenceMode; writes 470: call askRemote
- src/classify/run.ts:531 `askOnce.turn`: reads 534: call askOnce.withToken; writes 540: call askOnce.turn.finish
- src/classify/run.ts:624 `askOnce.<anonymous>`: reads 626: call credentialsNearExpiry; writes 633: call tryStartFollowUp
- src/classify/run.ts:685 `askRemote`: reads 690: call docsOf; writes 741: call askRemote.turn
- src/classify/run.ts:714 `askRemote.turn`: reads 715: call enqueueCall; writes 723: call awaitCall
- src/classify/run.ts:777 `askJev`: reads 792: call markJevUnavailable; writes 793: call markJevWorking
- src/classify/run.ts:818 `runHaiku.map-callback.<anonymous>`: reads 819: call runModelStep; writes 820: call saveVerdict
- src/classify/run.ts:828 `runJev.map-callback.<anonymous>`: reads 830: call jevAvailable; writes 832: call runModelStep
- src/classify/settled.ts:126 `setCurrentRun`: reads 127: SELECT value FROM settings WHERE key = 'classify_run'; writes 128: INSERT INTO settings (key, value) VALUES ('classify_run', ?)
- src/classify/settled.ts:232 `settledTable`: reads 233: SELECT COALESCE(MAX(rowid), 0) AS maxRowid, COUNT(*) AS coun; writes 236: CREATE TEMP TABLE IF NOT EXISTS item_settled (repo TEXT NOT 

### conversations

- src/conversations/act.ts:67 `editCard`: reads 68: call need; writes 101: UPDATE conversation_cards SET text = ?, params = ?, edited_b
- src/conversations/act.ts:108 `dismissCard`: reads 109: call need; writes 111: write block
- src/conversations/act.ts:125 `answerDecision`: reads 127: call getDecision; writes 144: call initExecState
- src/conversations/act.ts:190 `postComment`: reads 191: call actGrant; writes 193: call commentOn
- src/conversations/act.ts:197 `addLabel`: reads 198: call actGrant; writes 205: call addLabels
- src/conversations/act.ts:212 `closeThe`: reads 213: call actGrant; writes 218: call commentOn
- src/conversations/act.ts:226 `settleOthers`: reads 227: SELECT id FROM decisions WHERE repo = ? AND number = ? AND a; writes 230: call resolveDecision
- src/conversations/act.ts:235 `closeDuplicate`: reads 236: call actGrant; writes 242: call commentOn
- src/conversations/act.ts:301 `unlabel`: reads 303: call actGrant; writes 307: call removeLabel
- src/conversations/act.ts:317 `reopen`: reads 319: call actGrant; writes 326: call reopenItem
- src/conversations/act.ts:330 `openIssue`: reads 333: call actGrant; writes 335: call createIssue
- src/conversations/act.ts:343 `transfer`: reads 345: call actGrant; writes 354: call transferIssue
- src/conversations/act.ts:358 `assign`: reads 360: call actGrant; writes 364: call assignTo
- src/conversations/act.ts:368 `askReviewers`: reads 370: call actGrant; writes 380: call requestReviewers
- src/conversations/act.ts:393 `runResolution`: reads 395: call checkSettle; writes 415: call runResolution.answerNow
- src/conversations/act.ts:490 `run`: reads 493: call run.laneFor; writes 496: call runResolution
- src/conversations/act.ts:518 `doCard`: reads 519: call need; writes 568: call laneForOperator
- src/conversations/act.ts:667 `drainQueuedCards`: reads 669: call queuedCards; writes 681: call failQueued
- src/conversations/held.ts:132 `say`: reads 133: call conversationOf; writes 133: call insertTurn
- src/conversations/held.ts:154 `fileHeldFollowups`: reads 157: call dueHeld; writes 162: UPDATE main.held_followups SET state = 'filed', issue_number
- src/conversations/index.ts:24 `run`: reads 26: call connect; writes 32: call doCard
- src/conversations/run.ts:44 `answerPending.map-callback.<anonymous>`: reads 49: call refreshItem; writes 51: call claimPending
- src/conversations/store.ts:197 `ensureConversation`: reads 198: call conversationOf; writes 200: INSERT OR IGNORE INTO conversations (repo, number, item_bloc
- src/conversations/store.ts:220 `insertRow`: reads 226: call seenOf; writes 228: INSERT INTO conversation_cards (turn_id, repo, number, kind,
- src/conversations/store.ts:240 `appendTurn`: reads 241: call pendingTurn; writes 244: call insertRow
- src/conversations/store.ts:261 `refreshItem`: reads 262: call conversationOf; writes 290: call inTx
- src/conversations/store.ts:290 `refreshItem.<anonymous>`: reads 292: call conversationOf; writes 293: call appendTurn
- src/conversations/store.ts:303 `addOperatorMessage`: reads 307: call itemRow; writes 309: call ensureConversation
- src/conversations/store.ts:313 `addOperatorMessage.<anonymous>`: reads 314: call applicableSteps; writes 318: call appendTurn
- src/conversations/store.ts:363 `setInclude`: reads 364: SELECT sent_turn FROM conversation_includes WHERE repo = ? A; writes 366: DELETE FROM conversation_includes WHERE repo = ? AND number 
- src/conversations/store.ts:374 `startFromOpus`: reads 376: call conversationOf; writes 377: call ensureConversation
- src/conversations/store.ts:392 `claimPending.<anonymous>`: reads 395: SELECT 1 FROM conversation_turns WHERE repo = ? AND number =; writes 397: UPDATE conversation_turns SET status = NULL, seq = ? WHERE i
- src/conversations/store.ts:420 `settleWait`: reads 421: call nextSeq; writes 421: UPDATE conversation_turns SET status = ?, error = ?, seq = ?
- src/conversations/store.ts:435 `storeReply.<anonymous>`: reads 436: call claimed; writes 439: call settleWait
- src/conversations/store.ts:439 `storeReply.<anonymous>.<anonymous>`: reads 439: call nextSeq; writes 439: call insertRow
- src/conversations/store.ts:445 `failTurn.<anonymous>`: reads 446: call claimed; writes 448: call settleWait

### core

- src/core/facts.ts:135 `loadPrFacts`: reads 146: ; writes 168: call staleReviews
- src/core/guard.ts:63 `check`: reads 65: call disputeOn; writes 78: call loadPrFact
- src/core/guard.ts:106 `guardBatchMerge`: reads 108: call guard; writes 108: call guard
- src/core/plan-cache.ts:152 `writePlanCache`: reads 165: call storedRows; writes 178: write block
- src/core/plan-cache.ts:205 `refreshPlanCache`: reads 206: call loadPlanSet; writes 206: call writePlanCache
- src/core/plan-changes.ts:202 `dropPlanChanges`: reads 203: SELECT name FROM main.sqlite_master WHERE type = 'trigger' A; writes 204: write block
- src/core/plan-engine.ts:143 `planPass`: reads 146: call shadowMode; writes 157: call loadPrFacts
- src/core/plan-set.ts:32 `loadPlanSet`: reads 34: call latestRun; writes 37: call loadPrFacts

### dash

- src/dash/api/activity.ts:213 `activity`: reads 227: call needVisible; writes 238: call allOwnLogins
- src/dash/api/admin.ts:230 `override`: reads 239: call override.kept; writes 251: call setOverride
- src/dash/api/admin.ts:519 `revokeSession`: reads 523: DELETE FROM sessions WHERE rowid = ? RETURNING id_hash, logi; writes 527: call endTokens
- src/dash/api/admin.ts:534 `revokeAgentToken`: reads 538: call revokeAnyToken; writes 540: call audit
- src/dash/api/admin.ts:591 `putPilot`: reads 596: call setPilot; writes 601: call pipelineState
- src/dash/api/areas.ts:58 `edit`: reads 60: call needVisible; writes 73: call audit
- src/dash/api/areas.ts:79 `acceptProposalApi`: reads 81: SELECT repo FROM area_proposals WHERE id = ?; writes 89: call audit
- src/dash/api/areas.ts:86 `acceptProposalApi.<anonymous>`: reads 87: call decideSuggestion; writes 88: call acceptProposal
- src/dash/api/build.ts:70 `cancel.<anonymous>`: reads 71: call visibleTask; writes 72: call cancelTask
- src/dash/api/build.ts:92 `postFeature`: reads 100: call postFeature.tracked; writes 111: call setScope
- src/dash/api/build.ts:132 `putScreenshots`: reads 133: call trackedRepo; writes 135: call putConfig
- src/dash/api/conversations.ts:176 `getConversation`: reads 178: call needVisible; writes 179: call conversationView
- src/dash/api/conversations.ts:189 `postMessage`: reads 192: call needVisible; writes 194: call conversationView
- src/dash/api/conversations.ts:198 `postInclude`: reads 201: call needVisible; writes 205: call conversationView
- src/dash/api/conversations.ts:238 `disputePress`: reads 239: call needCard; writes 245: call disputeCard
- src/dash/api/conversations.ts:251 `keepPress`: reads 252: call needCard; writes 254: call keepCard
- src/dash/api/conversations.ts:300 `doChoice`: reads 301: call choicesById; writes 348: UPDATE main.conversation_cards SET state = 'replaced' WHERE 
- src/dash/api/decisions.ts:648 `answer`: reads 649: call needDecision; writes 651: call applyAnswer
- src/dash/api/decisions.ts:659 `applyAnswer`: reads 661: call settlingBy; writes 685: call inTransaction
- src/dash/api/decisions.ts:685 `applyAnswer.<anonymous>`: reads 686: call textsFor; writes 690: UPDATE main.decisions SET answer = ?, answer_note = ?, excep
- src/dash/api/decisions.ts:709 `snooze`: reads 710: call needDecision; writes 716: UPDATE main.decisions SET snoozed_by = ?, snoozed_at = ? WHE
- src/dash/api/decisions.ts:725 `reprepare`: reads 726: call needDecision; writes 730: UPDATE main.decisions SET prepared_at = NULL, prepared_head 
- src/dash/api/decisions.ts:737 `undo`: reads 738: call needDecision; writes 741: call releaseBacklogItem
- src/dash/api/decisions.ts:744 `undo.<anonymous>`: reads 745: call canUndo; writes 746: UPDATE main.decisions SET answer = NULL, answer_note = NULL,
- src/dash/api/decisions.ts:761 `dispute`: reads 762: call needDecision; writes 771: call openDispute
- src/dash/api/decisions.ts:776 `keepAnswer`: reads 777: call needDecision; writes 780: call clearDispute
- src/dash/api/decisions.ts:788 `retry`: reads 789: call needDecision; writes 792: call retryDecision
- src/dash/api/decisions.ts:798 `reopen`: reads 799: call needDecision; writes 802: call releaseBacklogItem
- src/dash/api/decisions.ts:815 `backlogItem`: reads 816: SELECT state FROM items WHERE repo = ? AND number = ?; writes 824: call applyAnswer
- src/dash/api/decisions.ts:829 `backlogItem.<anonymous>`: reads 830: call getDecision; writes 831: INSERT INTO main.decisions (id, kind, repo, number, question
- src/dash/api/decisions.ts:845 `backlogItemRoute`: reads 849: call needVisible; writes 851: call backlogItem
- src/dash/api/decisions.ts:878 `adopt`: reads 879: call needDecision; writes 890: call inTransaction
- src/dash/api/decisions.ts:890 `adopt.<anonymous>`: reads 891: call textsFor; writes 893: UPDATE main.decisions SET answer = ?, answer_note = NULL, ex
- src/dash/api/decisions.ts:920 `feedback`: reads 922: call needDecision; writes 932: INSERT INTO decision_comments (id, decision_id, login, at, b
- src/dash/api/decisions.ts:953 `retract`: reads 955: call needDecision; writes 958: UPDATE decision_opinions SET retracted_at = ? WHERE decision
- src/dash/api/decisions.ts:967 `claim`: reads 969: call needDecision; writes 973: INSERT INTO decision_claims (decision_id, login, since, at) 
- src/dash/api/discord.ts:78 `putChannelRepo`: reads 82: call isPublicRepo; writes 83: UPDATE discord_channels SET default_repo = ? WHERE channel_i
- src/dash/api/discord.ts:128 `removeLink`: reads 132: call unlinkRow; writes 134: call audit
- src/dash/api/flow.ts:13 `flow`: reads 15: call needVisible; writes 16: call readSummary
- src/dash/api/github-writes.ts:34 `writesOf`: reads 36: SELECT rowid, at, action, details FROM audit WHERE target = ; writes 57: call ownLogins
- src/dash/api/home.ts:155 `home`: reads 156: call hiddenRepos; writes 161: call needs
- src/dash/api/index.ts:323 `progressItems`: reads 324: SELECT (SELECT MAX(synced_at) FROM main.repos) AS synced, (S; writes 338: call funnelByRepo
- src/dash/api/index.ts:472 `apiRoutes.<anonymous>`: reads 472: call hiddenRepos; writes 472: call progress
- src/dash/api/inference.ts:13 `put`: reads 20: call setAcceptedModels; writes 22: call setInferenceMode
- src/dash/api/item-page.ts:263 `itemPage`: reads 264: call context; writes 278: call githubOf
- src/dash/api/items.ts:100 `build`: reads 104: call latestRun; writes 105: call settledTable
- src/dash/api/items.ts:247 `listItems`: reads 248: call hiddenRepos; writes 248: call build
- src/dash/api/items.ts:408 `statusList`: reads 415: call readerOf; writes 416: call build
- src/dash/api/mcp.ts:24 `create`: reads 30: call maintainerWritesOn; writes 32: call audit
- src/dash/api/needs.ts:80 `feedback`: reads 81: call ownLogin; writes 81: call allOwnLogins
- src/dash/api/needs.ts:128 `stopped`: reads 130: SELECT stage, reason, tripped_at FROM stage_trips WHERE acti; writes 135: call listAccounts
- src/dash/api/needs.ts:190 `needs`: reads 191: call hiddenRepos; writes 203: call feedback
- src/dash/api/next.ts:20 `nextPage`: reads 22: call trackedNames; writes 37: call laneGate
- src/dash/api/next.ts:56 `next`: reads 57: call visibleRepos; writes 57: call nextPage
- src/dash/api/nightly.ts:76 `select`: reads 78: call visible; writes 83: call setSelection
- src/dash/api/now.ts:82 `healthOf`: reads 83: call pipelineSwitch; writes 98: call listAccounts
- src/dash/api/now.ts:388 `now`: reads 389: call hiddenRepos; writes 392: call healthOf
- src/dash/api/operator.ts:29 `cancelItemPreapproval`: reads 34: call needVisible; writes 36: call cancelPreapproval
- src/dash/api/operator.ts:43 `retryItemPreapproval`: reads 48: call needVisible; writes 50: call retryPreapproval
- src/dash/api/operator.ts:60 `stopFixItem`: reads 65: call needVisible; writes 79: call applyAnswer
- src/dash/api/pipeline.ts:192 `putState`: reads 196: call pipelineState; writes 197: call setEnabled
- src/dash/api/pipeline.ts:205 `putJudgementModel`: reads 209: call judgementModel; writes 210: call setJudgementModel
- src/dash/api/pipeline.ts:227 `resumeTrip`: reads 230: call resumeStage; writes 235: call pipelineState
- src/dash/api/queue-page.ts:295 `markFast.<anonymous>`: reads 295: call addFastTrack; writes 295: call setFastTrackWeight
- src/dash/api/queue-page.ts:324 `queueAdd`: reads 330: call needVisible; writes 344: call preapproveMerge
- src/dash/api/queue-page.ts:379 `mergeHoldPr.<anonymous>`: reads 379: call holdMerge; writes 379: call releaseMerge
- src/dash/api/queue.ts:43 `queue`: reads 48: call readerOf; writes 55: call flowMembers
- src/dash/api/runners.ts:81 `approve`: reads 83: call inferenceMode; writes 88: call audit
- src/dash/api/runners.ts:92 `scopes`: reads 95: SELECT can_answer FROM mcp_tokens WHERE id = ? AND login = ?; writes 98: call setRunnerScopes
- src/dash/api/security-page.ts:103 `securityFindings`: reads 105: call visibleRepos; writes 108: call reconcileFindings
- src/dash/api/security-page.ts:156 `findingPage`: reads 159: call needVisible; writes 160: call reconcileFindings
- src/dash/api/security.ts:35 `security`: reads 38: call needVisible; writes 39: call overview
- src/dash/api/security.ts:78 `finding`: reads 81: call needVisible; writes 82: call reconcileFindings
- src/dash/api/security.ts:98 `scans`: reads 100: call visibleRepos; writes 100: call listScans
- src/dash/api/security.ts:103 `scanOf`: reads 105: call scanRow; writes 108: call scanDetail
- src/dash/api/stats.ts:30 `funnelByRepo`: reads 31: call latestRun; writes 31: call settledTable
- src/dash/api/trace.ts:540 `context`: reads 544: call needVisible; writes 547: call ownLogins
- src/dash/api/user-settings.ts:28 `setSettings`: reads 39: call parseRepos; writes 45: call setUserReserve
- src/dash/audit.ts:6 `auditRefusedSignIn`: reads 8: SELECT rowid, details FROM audit WHERE action = 'sign-in-ref; writes 10: call audit
- src/dash/index.ts:10 `serve`: reads 19: call connect; writes 20: call scopeToTracked
- src/dash/mcp/index.ts:518 `setWeight`: reads 524: call needVisible; writes 529: call removeFastTrack
- src/dash/mcp/index.ts:655 `pickModelCall`: reads 659: call pick; writes 659: call unpick
- src/dash/mcp/index.ts:670 `nextTask`: reads 686: call listHelpers; writes 693: call claimableCalls
- src/dash/mcp/index.ts:728 `callTool`: reads 731: call listRepos; writes 734: call sendFeedback
- src/dash/mcp/tokens.ts:115 `loadToken`: reads 120: SELECT t.id, t.login, t.kind, t.last_used_at, t.can_answer, ; writes 127: UPDATE mcp_tokens SET last_used_at = ?, expires_at = ? WHERE
- src/dash/server/github-app.ts:54 `githubAppRoutes.handler`: reads 57: call githubIdentity; writes 66: DELETE FROM github_app_states
- src/dash/server/github-app.ts:152 `finishRegistration`: reads 157: SELECT login, session_hash, created_at FROM github_app_state; writes 159: call convertAndStore
- src/dash/server/github-setup.ts:42 `revokeLink`: reads 45: SELECT org FROM github_setup_links WHERE id = ?; writes 46: call audit
- src/dash/server/github-setup.ts:115 `OrgSetup.handle`: reads 118: call #page; writes 119: call #manager
- src/dash/server/github-setup.ts:206 `OrgSetup.#page`: reads 207: call #flowOf; writes 221: call #newState
- src/dash/server/github-setup.ts:235 `OrgSetup.#manager`: reads 237: call #flowOf; writes 247: call grantOrgRole
- src/dash/server/github-setup.ts:266 `OrgSetup.#registered`: reads 269: call #flowOf; writes 272: call convertAndStore
- src/dash/server/github-setup.ts:277 `OrgSetup.#installed`: reads 280: SELECT login, session_hash, created_at FROM github_app_state; writes 285: DELETE FROM github_app_states WHERE state = ?
- src/dash/server/index.ts:417 `createApp.startOAuth`: reads 420: call githubIdentity; writes 419: INSERT INTO oauth_states (state, verifier, return_to, identi
- src/dash/server/index.ts:434 `createApp.auth`: reads 437: call ownsState; writes 439: call loadSession
- src/dash/server/index.ts:585 `createApp.handle`: reads 586: call serveChecks; writes 591: call pruneExpired
- src/dash/server/index.ts:750 `createApp.handleRemoteHttp`: reads 779: call startLogin; writes 784: call pollLogin
- src/dash/server/index.ts:870 `createApp.handleTaskMcp`: reads 880: call leaseState; writes 884: call taskLease
- src/dash/server/reporter-signin.ts:23 `reporterSignIn`: reads 27: call peekReporterState; writes 44: call saveReporter
- src/dash/server/reseal.ts:18 `resealLegacyValues`: reads 21: SELECT; writes 30: write block
- src/dash/server/sessions.ts:56 `loadSession`: reads 59: SELECT s.rowid, s.login, s.csrf, s.token_enc, s.last_seen, s; writes 68: DELETE FROM sessions WHERE id_hash = ?
- src/dash/server/sessions.ts:95 `accessToken`: reads 96: SELECT token_enc, login FROM sessions WHERE id_hash = ?; writes 104: call accessToken.<anonymous>
- src/dash/server/sessions.ts:104 `accessToken.<anonymous>`: reads 120: SELECT token_enc FROM sessions WHERE id_hash = ?; writes 126: call accessToken.<anonymous>.end
- src/dash/server/sessions.ts:177 `makeUser.check`: reads 180: SELECT permission, checked_at FROM repo_permissions WHERE lo; writes 186: call accessToken
- src/dash/server/user-tokens.ts:63 `dropUserTokens`: reads 64: DELETE FROM user_tokens WHERE login = ? RETURNING token_enc; writes 66: INSERT INTO user_token_revocations (login, token_enc, queued
- src/dash/server/user-tokens.ts:88 `shareRefresh`: reads 89: call readUserTokens; writes 90: call swapUserTokens

### decide

- src/decide/choices-convert.ts:186 `convertOpenDecisionsOnce`: reads 187: SELECT 1 FROM main.settings WHERE key = 'choices_converted'; writes 189: INSERT INTO main.settings (key, value) VALUES ('choices_conv
- src/decide/index.ts:73 `runDecide`: reads 76: call trackedNames; writes 108: call setAsideLapsedScope
- src/decide/index.ts:157 `run`: reads 158: call connect; writes 158: call runDecide
- src/decide/prepare.ts:204 `prepare.map-callback.<anonymous>`: reads 206: SELECT * FROM decisions WHERE id = ? AND answer IS NULL; writes 217: call loadSummaryItems

### discord

- src/discord/alerts.ts:176 `DecisionAlerts.start.<anonymous>`: reads 178: call readSeqs; writes 188: call sync
- src/discord/alerts.ts:198 `DecisionAlerts.sync`: reads 204: call #pass; writes 204: call #pass
- src/discord/alerts.ts:222 `DecisionAlerts.#pass`: reads 225: call #alerters; writes 226: call #refreshPermissions
- src/discord/alerts.ts:258 `DecisionAlerts.#summary`: reads 261: SELECT 1 FROM discord_alert_msgs WHERE user_hash = ? AND dec; writes 270: INSERT OR IGNORE INTO discord_alert_msgs (decision_id, user_
- src/discord/alerts.ts:282 `DecisionAlerts.#refreshPermissions`: reads 285: call maintainerWritesOn; writes 304: INSERT INTO main.repo_permissions (login, repo, permission, 
- src/discord/alerts.ts:310 `DecisionAlerts.#refresh`: reads 317: call getDecision; writes 321: call DecisionAlerts.#refresh.forget
- src/discord/alerts.ts:378 `installAlertCommands.command-callback`: reads 380: call loginOf; writes 383: call setAlerts
- src/discord/alerts.ts:399 `installAlertCommands.press`: reads 402: call loginOf; writes 428: call doChoice
- src/discord/commands.ts:82 `installAccountCommands.command-callback`: reads 84: call forgetReporter; writes 85: call audit
- src/discord/file-issue.ts:81 `junkCheck`: reads 83: call jevAvailable; writes 96: DELETE FROM agent_run_texts WHERE run_id IN (SELECT id FROM 
- src/discord/file-issue.ts:112 `fileIssue`: reads 117: call isPublicRepo; writes 125: call reporterToken
- src/discord/index.ts:70 `dispatcher.<anonymous>`: reads 71: call handleDispatch; writes 73: call handleMeta
- src/discord/index.ts:96 `startDiscord`: reads 118: call installDecisionAlerts; writes 123: call dropTexts
- src/discord/index.ts:154 `discord`: reads 156: call connect; writes 161: call forgetMessages
- src/discord/issue-new.ts:181 `IssueNew.form`: reads 187: call trackedRepos; writes 197: call #model
- src/discord/issue-new.ts:243 `IssueNew.#finish`: reads 244: call #repos; writes 248: call #model
- src/discord/issue-new.ts:354 `installIssueNew.component-callback`: reads 356: call open; writes 357: call none
- src/discord/issue-new.ts:363 `installIssueNew.component-callback`: reads 365: call form; writes 366: call answers
- src/discord/links.ts:62 `unlinkRow`: reads 63: SELECT login FROM discord_links WHERE user_hash = ?; writes 65: DELETE FROM discord_links WHERE user_hash = ?
- src/discord/pings.ts:90 `Pings.#ping`: reads 93: SELECT 1 FROM discord_replies WHERE ping_hash = ?; writes 100: call find
- src/discord/replies.ts:8 `deleteRepliesOf`: reads 14: SELECT ping_hash, sealed FROM discord_replies WHERE ping_has; writes 22: DELETE FROM discord_replies WHERE ping_hash = ?
- src/discord/reporter.ts:17 `saveReporter`: reads 18: SELECT login, token_enc FROM reporter_tokens WHERE reporter ; writes 19: call queueRevoke
- src/discord/reporter.ts:61 `obtain`: reads 62: call readReporter; writes 67: call failReporter
- src/discord/reporter.ts:109 `forgetReporterRow`: reads 112: DELETE FROM reporter_tokens WHERE reporter = ? RETURNING log; writes 114: call queueRevoke
- src/discord/search.ts:138 `Search.find`: reads 141: call candidates; writes 158: call dropTexts
- src/discord/signals.ts:135 `Signals.#check`: reads 141: SELECT title FROM main.items WHERE repo = ? AND number = ?; writes 146: UPDATE discord_mentions SET signal = ? WHERE msg_hash = ? AN
- src/discord/signals.ts:155 `Signals.#decide`: reads 160: call signalSpentUsd; writes 161: call jevAvailable
- src/discord/store.ts:23 `recordMessage`: reads 26: call trackedRepos; writes 35: write block
- src/discord/store.ts:58 `forgetAuthor`: reads 62: SELECT msg_hash, repo, number, sealed FROM discord_mentions; writes 63: DELETE FROM discord_mentions WHERE msg_hash = ? AND repo = ?
- src/discord/store.ts:68 `handleDispatch`: reads 71: call isWatched; writes 72: call recordMessage

### downloads

- src/downloads/poll.ts:52 `recordRepo`: reads 55: SELECT asset_id, downloads, repo FROM release_assets; writes 66: write block
- src/downloads/poll.ts:98 `foldDeltas`: reads 100: SELECT asset_id, t, delta FROM download_deltas WHERE span = ; writes 102: write block
- src/downloads/poll.ts:113 `pollReleases`: reads 114: call trackedNames; writes 133: INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT 
- src/downloads/poll.ts:120 `pollReleases.worker`: reads 124: call recordRepo; writes 124: call recordRepo
- src/downloads/poll.ts:145 `pollReleasesIfDue`: reads 146: call setting; writes 148: call pollReleases

### dupes

- src/dupes/check.ts:75 `store`: reads 76: call pickCanonical; writes 77: UPDATE duplicate_pairs SET jev_p = ?, haiku = ?, verdict = ?
- src/dupes/check.ts:85 `checkPairs`: reads 90: call pairInput; writes 109: call checkPairs.done
- src/dupes/check.ts:113 `checkPairs.map-callback.<anonymous>`: reads 116: call runModelStep; writes 124: call checkPairs.done
- src/dupes/compare.ts:110 `prInput`: reads 114: call bodyOf; writes 117: call cachedDiff
- src/dupes/compare.ts:149 `compareChunk`: reads 152: call prInput; writes 164: call runModelStep
- src/dupes/compare.ts:185 `compareSet`: reads 188: call canonInfo; writes 202: call compareChunk
- src/dupes/compare.ts:227 `runDupeCompare`: reads 231: call dueSets; writes 244: call saveComparison
- src/dupes/compare.ts:274 `runDupeCompare.map-callback.<anonymous>`: reads 275: call compareSet; writes 280: call saveComparison
- src/dupes/compare.ts:315 `run`: reads 316: call connect; writes 321: call compareAgain
- src/dupes/decide.ts:133 `supersede`: reads 135: SELECT id FROM decisions WHERE kind = 'duplicate' AND repo =; writes 139: UPDATE main.decisions SET answer = 'superseded', answered_by
- src/dupes/decide.ts:209 `askGroupDecisions`: reads 211: call groupPlans; writes 238: call supersede
- src/dupes/decide.ts:320 `rekeep`: reads 322: SELECT kind FROM dupe_group_items WHERE decision_id = ? AND ; writes 327: UPDATE dupe_group_items SET role = ?, target = ? WHERE decis
- src/dupes/decide.ts:339 `applyDuplicateAnswers`: reads 341: call actionable; writes 347: call restoreRoles
- src/dupes/index.ts:58 `runDupes`: reads 65: call fillEmbedHashes; writes 72: call applyDuplicateAnswers
- src/dupes/index.ts:108 `run`: reads 109: call connect; writes 110: call runDupes
- src/dupes/plan.ts:154 `saveComparison`: reads 161: SELECT additions, deletions, head_oid FROM items WHERE repo ; writes 165: INSERT OR REPLACE INTO dupe_comparisons (repo, key, kind, me
- src/dupes/scan.ts:66 `scanItem`: reads 67: call neighbourPairs; writes 71: write block
- src/dupes/texts.ts:56 `storeOptionTexts`: reads 57: SELECT number, kind, role, target, detail FROM dupe_group_it; writes 58: DELETE FROM dupe_group_texts WHERE decision_id = ?

### embed

- src/embed/index.ts:28 `embedCommand`: reads 38: call connect; writes 42: call embedItems
- src/embed/store.ts:39 `embedDue`: reads 40: call plannedItems; writes 42: call statementsDue
- src/embed/store.ts:54 `embedItems`: reads 58: call fillEmbedHashes; writes 67: write block

### fixissue

- src/fixissue/approval.ts:21 `setFixIssueApproval`: reads 22: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 24: INSERT INTO main.settings (key, value) VALUES (?, ?)
- src/fixissue/index.ts:267 `startAttempt`: reads 270: call branchOf; writes 273: call cachedCrates
- src/fixissue/index.ts:313 `assignIssue`: reads 316: call duplicateHeld; writes 319: call claimForWork
- src/fixissue/index.ts:326 `claimIssue`: reads 337: call attemptOf; writes 346: call ghComment
- src/fixissue/index.ts:368 `unclaimHeld`: reads 372: SELECT number FROM fix_attempts WHERE repo = ? AND state IN ; writes 384: call ownLogins
- src/fixissue/index.ts:394 `patchRound`: reads 400: call attemptOf; writes 402: call fail
- src/fixissue/index.ts:453 `runFixIssue`: reads 460: call plannedItems; writes 506: call unclaimHeld
- src/fixissue/index.ts:475 `runFixIssue.map-callback.<anonymous>`: reads 481: call unchanged; writes 482: call patchRound
- src/fixissue/index.ts:489 `runFixIssue.map-callback.<anonymous>`: reads 495: call unchanged; writes 498: call startAttempt
- src/fixissue/index.ts:537 `runFixIssueCollect`: reads 542: call plannedItems; writes 612: call unclaimHeld
- src/fixissue/index.ts:551 `runFixIssueCollect.map-callback.<anonymous>`: reads 559: call unchanged; writes 560: call openPr
- src/fixissue/index.ts:618 `checkPatch`: reads 623: SELECT title, body FROM items WHERE repo = ? AND number = ?; writes 625: call issueText
- src/fixissue/index.ts:639 `forkOf`: reads 641: call githubIdentity; writes 650: call ghFork
- src/fixissue/index.ts:686 `comment`: reads 689: SELECT 1 FROM audit WHERE action = 'fixissue-comment' AND ta; writes 690: call closedLive
- src/fixissue/index.ts:697 `openPr`: reads 716: call openPr.permitted; writes 718: call fail
- src/fixissue/index.ts:818 `run`: reads 820: call connect; writes 820: call runFixIssue
- src/fixissue/index.ts:825 `run`: reads 827: call connect; writes 827: call runFixIssueCollect

### fixup

- src/fixup/approval.ts:22 `setPushApproval`: reads 23: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 25: INSERT INTO main.settings (key, value) VALUES (?, ?)
- src/fixup/author-permission.ts:99 `ensureAuthorWrites`: reads 101: call authorOf; writes 108: INSERT INTO main.author_permissions (login, repo, permission
- src/fixup/conflict.ts:81 `record`: reads 82: SELECT rowid AS id FROM conflict_merges WHERE repo = ? AND n; writes 83: UPDATE conflict_merges SET state = ?, reason = ?, files = ?,
- src/fixup/conflict.ts:155 `askConflict`: reads 158: call live; writes 163: call guard
- src/fixup/conflict.ts:183 `mergeConflict`: reads 201: call mergeConflict.skip; writes 203: call mergeConflict.skip
- src/fixup/index.ts:153 `noteLive`: reads 157: SELECT head_oid FROM pr_checks WHERE repo = ? AND number = ?; writes 160: UPDATE pr_checks SET state = ?, is_draft = ?, mergeable = CA
- src/fixup/index.ts:210 `Recorder.dropUnlisted`: reads 212: SELECT rowid AS id, lint_task FROM fixups WHERE repo = ? AND; writes 216: UPDATE fixups SET state = 'superseded', reason = 'the plan n
- src/fixup/index.ts:221 `Recorder.fixup`: reads 227: SELECT created_at FROM fixups WHERE repo = ? AND number = ? ; writes 229: INSERT INTO fixups (repo, number, from_head, state, reason, 
- src/fixup/index.ts:262 `runFixup`: reads 265: call sweepSessions; writes 266: call runFixupWith
- src/fixup/index.ts:272 `runFixupWith`: reads 280: call selectFixups; writes 303: call dropUnlisted
- src/fixup/index.ts:312 `runFixupWith.askOne`: reads 317: call noteLive; writes 323: call fixup
- src/fixup/index.ts:373 `runFixupWith.claim`: reads 374: call duplicateHeld; writes 377: call claimForWork
- src/fixup/index.ts:393 `runFixupWith.fixOne`: reads 398: call pushesUnsettled; writes 399: call leaseItem
- src/fixup/index.ts:407 `runFixupWith.fixOne.fail`: reads 409: call fixup; writes 411: call jobItem
- src/fixup/index.ts:413 `runFixupWith.fixOne.hold`: reads 415: call fixup; writes 417: call jobItem
- src/fixup/index.ts:609 `runFixupWith.map-callback.<anonymous>`: reads 609: call runFixupWith.fixOne; writes 609: call runFixupWith.fixOne
- src/fixup/index.ts:630 `carryWork`: reads 635: call cachedDiff; writes 635: call cachedDiff
- src/fixup/index.ts:689 `repostAsk`: reads 690: SELECT state, from_head FROM fixups WHERE repo = ? AND numbe; writes 709: call ghEditComment
- src/fixup/index.ts:730 `run`: reads 734: call connect; writes 734: call runFixupTry
- src/fixup/select.ts:32 `selectFixups`: reads 38: call planned; writes 38: call planned
- src/fixup/try.ts:29 `runFixupTry`: reads 31: SELECT head_oid, title FROM items WHERE repo = ? AND number ; writes 47: call cachedDiff

### flow

- src/flow/count.ts:119 `classify`: reads 122: call open; writes 135: call open
- src/flow/count.ts:141 `decide`: reads 142: SELECT repo, number, items, answer, asked_at, answered_at FR; writes 144: call openRefs
- src/flow/count.ts:266 `labels`: reads 267: call trackedNames; writes 269: call openRefs
- src/flow/count.ts:292 `dupes`: reads 297: SELECT p.repo, p.a, p.b, ia.state AS sa, ib.state AS sb FROM; writes 315: call open
- src/flow/count.ts:448 `countAll`: reads 448: call latestRun; writes 452: call synced
- src/flow/summary.ts:46 `markChanged`: reads 47: call getMarks; writes 78: UPDATE main.flow_summary SET stale = 1
- src/flow/summary.ts:85 `countRepo`: reads 85: call latestRun; writes 86: call countAll
- src/flow/summary.ts:98 `refreshSummary`: reads 100: call markChanged; writes 101: DELETE FROM main.flow_summary WHERE repo NOT IN (SELECT name
- src/flow/summary.ts:123 `readSummary`: reads 125: call trackedNames; writes 136: call countRepo

### github

- src/github/claim.ts:37 `claimForWork`: reads 42: call weAssigned; writes 42: call claimItem
- src/github/claim.ts:59 `releaseItem`: reads 60: call weAssigned; writes 61: call unassignFrom
- src/github/commands.ts:280 `knownCommenter`: reads 281: call boundAccess; writes 282: call settle
- src/github/commands.ts:292 `expire`: reads 293: call boundAccess; writes 295: call settle
- src/github/commands.ts:306 `carryOut`: reads 309: call knownCommenter; writes 320: call settle
- src/github/commands.ts:380 `carryOutRepin`: reads 384: call expire; writes 385: call knownCommenter
- src/github/commands.ts:408 `refuse`: reads 409: call refusal; writes 409: call settle
- src/github/commands.ts:420 `waitsForRead`: reads 422: call openPrsClosing; writes 429: INSERT INTO main.sync_requests (repo, number, event, request
- src/github/commands.ts:445 `answer`: reads 446: call guardRepo; writes 453: call ghComment
- src/github/commands.ts:473 `drainCommands`: reads 479: SELECT; writes 490: call expire
- src/github/identity.ts:30 `setGithubIdentity`: reads 32: call githubIdentity; writes 34: write block
- src/github/identity.ts:122 `setGithubIdentityChecked`: reads 125: call githubIdentity; writes 133: call setGithubIdentity
- src/github/identity.ts:200 `ownLogins`: reads 202: call setting; writes 204: call ownBotLogins
- src/github/slugs.ts:18 `rememberSlug`: reads 20: SELECT value FROM main.settings WHERE key = ?; writes 22: call writeSetting
- src/github/user-lane.ts:40 `initExecState`: reads 41: SELECT repo, answered_by FROM main.decisions WHERE id = ? AN; writes 44: call setExecState
- src/github/user-lane.ts:141 `resolveLane`: reads 144: call userToken; writes 161: call userToken
- src/github/user-lane.ts:173 `laneForDecision`: reads 174: call githubIdentity; writes 183: call defaultLaneDeps
- src/github/user-lane.ts:187 `laneForOperator`: reads 188: call githubIdentity; writes 189: call defaultLaneDeps
- src/github/vault.ts:58 `Vault.#obtain`: reads 60: call readUserTokens; writes 66: call failUserTokens
- src/github/vault.ts:100 `Vault.sweepRevocations`: reads 104: SELECT id, login, token_enc, kind, aad, attempts FROM user_t; writes 108: UPDATE user_token_revocations SET attempts = attempts + 1 WH
- src/github/vault.ts:129 `Vault.#revokeRow`: reads 138: call readUserTokens; writes 159: DELETE FROM user_tokens WHERE login = ?
- src/github/webhooks.ts:63 `queueDelivery`: reads 65: call trackedName; writes 69: call queueCommand
- src/github/webhooks.ts:107 `drainSyncRequests`: reads 109: SELECT repo, number, requested_at FROM main.sync_requests OR; writes 114: call drainSyncRequests.gone
- src/github/write.ts:293 `commentOn`: reads 295: call laneQuery; writes 297: call recorded
- src/github/write.ts:312 `closeItem`: reads 314: call laneQuery; writes 321: call recorded
- src/github/write.ts:335 `assignTo`: reads 337: call laneQuery; writes 338: call recorded
- src/github/write.ts:341 `unassignFrom`: reads 343: call laneQuery; writes 344: call recorded
- src/github/write.ts:347 `reopenItem`: reads 349: call laneQuery; writes 350: call recorded
- src/github/write.ts:353 `removeLabel`: reads 355: call laneQuery; writes 356: call recorded
- src/github/write.ts:360 `transferIssue`: reads 364: call laneQuery; writes 365: call recorded
- src/github/write.ts:372 `requestReviewers`: reads 374: call laneQuery; writes 375: call recorded
- src/github/write.ts:380 `postReview`: reads 381: call laneQuery; writes 383: call recorded
- src/github/write.ts:390 `editReview`: reads 391: call laneQuery; writes 393: call recorded
- src/github/write.ts:396 `createLabel`: reads 398: call laneQuery; writes 399: call recorded
- src/github/write.ts:405 `addLabels`: reads 408: call inAppLane; writes 410: call addLabels
- src/github/write.ts:459 `ghComment`: reads 461: call laneExec; writes 463: call viaGh
- src/github/write.ts:468 `ghEditComment`: reads 470: call laneExec; writes 472: call viaGh
- src/github/write.ts:480 `ghDeleteComment`: reads 482: call laneExec; writes 486: call recorded
- src/github/write.ts:499 `ghOpenPr`: reads 501: call laneExec; writes 503: call viaGh
- src/github/write.ts:507 `ghClosePr`: reads 509: call laneExec; writes 511: call viaGh
- src/github/write.ts:516 `ghFork`: reads 519: call inAppLane; writes 520: call viaGh
- src/github/write.ts:538 `createIssue`: reads 540: call laneExec; writes 544: call viaGh
- src/github/write.ts:589 `ghApproveRun`: reads 590: call laneExec; writes 591: call viaGh
- src/github/write.ts:609 `ghRerunFailed`: reads 610: call laneExec; writes 613: call viaGh
- src/github/write.ts:618 `ghRerunMainFailed`: reads 620: call laneExec; writes 623: call viaGh
- src/github/write.ts:661 `pushed`: reads 663: call laneGit; writes 666: call recorded
- src/github/write.ts:785 `mergeViaCommand`: reads 789: call idOf; writes 791: call begin
- src/github/write.ts:829 `cliMergeRecorder.<anonymous>`: reads 830: call connect; writes 835: call begin

### labels

- src/labels/approval.ts:21 `setApproval`: reads 22: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 26: INSERT INTO main.settings (key, value) VALUES (?, ?)
- src/labels/github.ts:51 `ensureLabels`: reads 55: call guardRepo; writes 58: call createLabel
- src/labels/github.ts:76 `applyLabels`: reads 80: call approvalOf; writes 104: UPDATE main.items SET state = ? WHERE repo = ? AND number = 
- src/labels/github.ts:170 `mutate`: reads 175: call mutate.run; writes 184: call mutate.run
- src/labels/index.ts:41 `ensure`: reads 43: call connect; writes 43: call ensureLabels
- src/labels/index.ts:49 `plan`: reads 51: call connect; writes 58: call connect
- src/labels/index.ts:64 `apply`: reads 69: call connect; writes 69: call applyLabels

### mainci

- src/mainci/index.ts:78 `saveHead`: reads 79: call optionalChecks; writes 81: INSERT INTO main_ci (repo, head_sha, branch, state, failing,
- src/mainci/index.ts:92 `pollMainCi`: reads 93: SELECT name FROM repos WHERE synced_at IS NOT NULL; writes 101: call saveHead
- src/mainci/index.ts:113 `pollMainCiIfDue`: reads 114: call setting; writes 116: call pollMainCi

### mainfix

- src/mainfix/approval.ts:33 `setMainFixApproval`: reads 34: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 36: INSERT INTO main.settings (key, value) VALUES (?, ?)
- src/mainfix/index.ts:85 `defaultDeps.classify`: reads 88: call askClaude; writes 90: call saveUsage
- src/mainfix/index.ts:194 `classifyHead`: reads 196: call optionalChecks; writes 199: call save
- src/mainfix/index.ts:232 `askInfra`: reads 234: call getDecision; writes 253: call setState
- src/mainfix/index.ts:257 `settleReruns`: reads 259: call rowsAt; writes 260: call setState
- src/mainfix/index.ts:268 `applyAnswers`: reads 269: call actionable; writes 273: call setState
- src/mainfix/index.ts:296 `runMainFix`: reads 299: call mainFixApprovalOf; writes 306: call applyAnswers
- src/mainfix/index.ts:334 `run`: reads 338: call connect; writes 339: call runMainFix
- src/mainfix/pr.ts:128 `attempt`: reads 144: call optionalChecks; writes 201: call queueLintFor
- src/mainfix/pr.ts:295 `openFixPrs`: reads 297: SELECT * FROM main_fixes WHERE repo = ? AND state IN ('needs; writes 302: call sweepSessions
- src/mainfix/pr.ts:305 `openFixPrs.map-callback.<anonymous>`: reads 310: call pushesUnsettled; writes 311: call leaseItem

### memory

- src/memory/statements.ts:73 `collectStatements`: reads 74: SELECT s.* FROM (; writes 87: INSERT OR IGNORE INTO owner_statements (source_kind, source_
- src/memory/statements.ts:104 `embedStatements`: reads 105: call collectStatements; writes 111: UPDATE owner_statements SET embedding = ?, model = ? WHERE i

### merge

- src/merge/approval.ts:22 `setMergeApproval`: reads 23: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 25: INSERT INTO main.settings (key, value) VALUES (?, ?)
- src/merge/base.ts:36 `recordLiveBase`: reads 38: SELECT base_ref FROM items WHERE repo = ? AND number = ?; writes 40: UPDATE main.items SET base_ref = ? WHERE repo = ? AND number
- src/merge/batch-store.ts:67 `growBatchSize`: reads 67: call batchSizeOf; writes 67: call setBatchSize
- src/merge/batch-store.ts:68 `shrinkBatchSize`: reads 68: call batchSizeOf; writes 68: call setBatchSize
- src/merge/batch-store.ts:89 `cancelBuild`: reads 91: call getTask; writes 92: call cancelTask
- src/merge/batch.ts:114 `runBatches`: reads 117: call mergeApprovalOf; writes 692: call advance
- src/merge/batch.ts:144 `runBatches.closePr`: reads 146: call runBatches.grant; writes 148: call ghClosePr
- src/merge/batch.ts:171 `runBatches.holdGone`: reads 172: call holdMerge; writes 173: call audit
- src/merge/batch.ts:181 `runBatches.startBatch`: reads 184: call commitIdentity; writes 185: call setPipelineLogin
- src/merge/batch.ts:255 `runBatches.supersede`: reads 257: call getBatch; writes 258: call cancelBuild
- src/merge/batch.ts:279 `runBatches.fail`: reads 280: call membersOf; writes 281: call shrinkBatchSize
- src/merge/batch.ts:309 `runBatches.drop`: reads 311: call getBatch; writes 312: call cancelBuild
- src/merge/batch.ts:373 `runBatches.red`: reads 374: call optionalChecks; writes 380: call supersede
- src/merge/batch.ts:442 `runBatches.publishFailed`: reads 447: call membersOf; writes 450: call updateBatch
- src/merge/batch.ts:454 `runBatches.publish`: reads 456: call supersede; writes 458: call refreshChecks
- src/merge/batch.ts:500 `runBatches.recordLanded`: reads 502: call getBatch; writes 503: call audit
- src/merge/batch.ts:523 `runBatches.land`: reads 525: call refreshChecks; writes 528: call recordLanded
- src/merge/batch.ts:633 `runBatches.readBuild`: reads 635: call getTask; writes 636: call runBatches.readBuild.open
- src/merge/batch.ts:634 `runBatches.readBuild.open`: reads 634: call getBatch; writes 634: call publish
- src/merge/batch.ts:671 `runBatches.advance`: reads 672: call getBatch; writes 675: call buildQueue
- src/merge/batch.ts:715 `run`: reads 719: call connect; writes 719: call runBatches
- src/merge/ci-approval.ts:39 `setCiApproval`: reads 40: SELECT 1 FROM main.tracked_repos WHERE name = ?; writes 42: INSERT INTO main.settings (key, value) VALUES (?, ?)
- src/merge/ci-approval.ts:63 `recordRuns`: reads 65: SELECT * FROM ci_run_approvals WHERE repo = ? AND number = ?; writes 77: INSERT INTO ci_run_approvals (repo, number, head_oid, cross_
- src/merge/ci-approval.ts:142 `approveRuns`: reads 152: call needsWork; writes 163: call jobItem
- src/merge/ci-approval.ts:146 `approveRuns.save`: reads 147: SELECT approved FROM ci_run_approvals WHERE repo = ? AND num; writes 149: UPDATE ci_run_approvals SET runs = ?, approved = ?, reread =
- src/merge/ci-approval.ts:199 `run`: reads 200: call connect; writes 206: call setCiApproval
- src/merge/controls.ts:37 `holdMerge`: reads 38: call openPr; writes 39: INSERT OR IGNORE INTO main.merge_holds (repo, number, held_b
- src/merge/controls.ts:52 `endBatch`: reads 53: call getBatch; writes 54: call cancelBuild
- src/merge/controls.ts:84 `stopBatch`: reads 85: call activeBatch; writes 87: call audit
- src/merge/controls.ts:94 `removeFromBatch`: reads 95: call activeBatches; writes 97: call holdMerge
- src/merge/controls.ts:125 `run.<anonymous>`: reads 128: call connect; writes 128: call holdMerge
- src/merge/controls.ts:133 `run.<anonymous>`: reads 136: call connect; writes 136: call releaseMerge
- src/merge/controls.ts:141 `run.<anonymous>`: reads 144: call connect; writes 144: call removeFromBatch
- src/merge/controls.ts:150 `run.<anonymous>`: reads 152: call connect; writes 152: call stopBatch
- src/merge/index.ts:206 `askDue`: reads 211: call withdrawOtherHeadQuestions; writes 211: call withdrawOtherHeadQuestions
- src/merge/index.ts:220 `askMergeDecisions`: reads 222: call buildQueue; writes 223: call planned
- src/merge/index.ts:236 `runMerge`: reads 243: call scopeRepos; writes 250: call buildQueue
- src/merge/index.ts:432 `run`: reads 433: call connect; writes 433: call askMergeDecisions
- src/merge/index.ts:439 `run`: reads 441: call connect; writes 441: call runMerge
- src/merge/index.ts:446 `run`: reads 448: call connect; writes 448: call buildQueue
- src/merge/mergeable.ts:28 `noteMergeable`: reads 37: SELECT value FROM main.settings WHERE key = ?; writes 41: DELETE FROM main.settings WHERE key = ?
- src/merge/mergeable.ts:80 `rereadUnknown`: reads 81: SELECT key, value FROM main.settings WHERE key LIKE ?; writes 89: DELETE FROM main.settings WHERE key = ?
- src/merge/single.ts:24 `setSingleMergeMax`: reads 26: call singleMergeMax; writes 27: INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONF
- src/merge/single.ts:47 `planSingles`: reads 48: call singleMergeMax; writes 50: call planned
- src/merge/single.ts:71 `runSingles`: reads 75: call mergeApprovalOf; writes 77: call planSingles
- src/merge/single.ts:86 `run`: reads 88: call connect; writes 92: call setSingleMergeMax
- src/merge/verify-override.ts:18 `setAsideAnswerBeforeFailure`: reads 19: SELECT answer FROM decisions WHERE id = ?; writes 20: call withdrawMergeQuestion
- src/merge/withdraw.ts:32 `setAside`: reads 33: SELECT answer, applied_at FROM decisions WHERE id = ?; writes 37: write block
- src/merge/withdraw.ts:54 `withdrawBlockedQuestions`: reads 59: SELECT answer, applied_at FROM decisions WHERE id = ?; writes 61: call withdrawMergeQuestion
- src/merge/withdraw.ts:73 `withdrawGroupedQuestions`: reads 74: SELECT DISTINCT m.repo, m.number, m.id FROM decisions m JOIN; writes 82: call withdrawMergeQuestion
- src/merge/withdraw.ts:94 `withdrawOtherHeadQuestions`: reads 96: SELECT id FROM decisions WHERE repo = ? AND number = ? AND k; writes 99: call withdrawMergeQuestion
- src/merge/withdraw.ts:111 `setAsideLapsedScope`: reads 112: SELECT repo, number, answer FROM decisions WHERE id = ? AND ; writes 115: write block
- src/merge/withdraw.ts:133 `setAsideOldHeadQuestions`: reads 134: SELECT d.id, d.kind, d.repo, d.number FROM decisions d JOIN ; writes 140: write block
- src/merge/withdraw.ts:157 `setAsideSupersededQuestions`: reads 158: call setAsideOldHeadQuestions; writes 171: write block
- src/merge/withdraw.ts:193 `withdrawClosedQuestions`: reads 194: SELECT d.id, d.kind, d.repo, d.number, i.state, i.kind AS it; writes 204: write block

### nightly

- src/nightly/index.ts:83 `setSelection`: reads 85: call selectionOf; writes 87: INSERT INTO nightly_selection (repo, check_id, enabled, para
- src/nightly/index.ts:155 `defaultDeps.openIssue`: reads 156: call guardRepo; writes 158: call createIssue
- src/nightly/index.ts:182 `storeBench`: reads 186: SELECT value FROM nightly_bench WHERE repo = ? AND bench = ?; writes 191: INSERT OR REPLACE INTO nightly_bench (repo, bench, sha, at, 
- src/nightly/index.ts:248 `afterFailure`: reads 251: call history; writes 275: UPDATE nightly_results SET decision_id = ?, issue_number = ?
- src/nightly/index.ts:280 `collect`: reads 282: SELECT * FROM nightly_runs WHERE repo = ? AND state = 'runni; writes 288: UPDATE nightly_results SET state = 'error', summary = ?, fin
- src/nightly/index.ts:300 `applyAnswers`: reads 301: call actionable; writes 304: call applyAnswers.done
- src/nightly/index.ts:328 `queueRun`: reads 329: call headOf; writes 338: write block
- src/nightly/index.ts:354 `runNightly`: reads 357: call featureOn; writes 362: call applyAnswers

### postmerge

- src/postmerge/file.ts:68 `fileDefect`: reads 72: SELECT default_branch FROM repos WHERE name = ?; writes 74: call setFollowup
- src/postmerge/file.ts:114 `runPostmergeFile`: reads 117: call commentApprovalOf; writes 130: call setFollowup
- src/postmerge/file.ts:163 `fileFinding`: reads 167: call reviewOf; writes 177: call audit
- src/postmerge/index.ts:12 `reviewOne`: reads 16: call mergedPr; writes 20: call audit
- src/postmerge/index.ts:28 `run`: reads 35: call connect; writes 35: call reviewOne
- src/postmerge/review.ts:100 `saveReview`: reads 103: SELECT 1 FROM postmerge_reviews WHERE repo = ? AND number = ; writes 109: INSERT OR REPLACE INTO postmerge_reviews (repo, number, merg
- src/postmerge/review.ts:119 `runPostmerge`: reads 122: call mergedPr; writes 122: call selectPostmerge
- src/postmerge/review.ts:127 `runPostmerge.map-callback.<anonymous>`: reads 129: call prepare; writes 131: call jobItem

### prbuild

- src/prbuild/index.ts:30 `queuePrBuild`: reads 37: call createTask; writes 41: INSERT INTO main.pr_builds (repo, number, head_sha, scope, t
- src/prbuild/index.ts:67 `prBuildDue`: reads 68: call featureOn; writes 69: call selectPrBuilds
- src/prbuild/index.ts:84 `collectPrBuilds`: reads 86: call baseScopeRepos; writes 88: call leaseItem
- src/prbuild/index.ts:146 `runPrBuilds`: reads 148: call collectPrBuilds; writes 150: call selectPrBuilds
- src/prbuild/select.ts:48 `selectPrBuilds`: reads 49: SELECT 1 FROM repos WHERE name = ? AND visibility = 'public'; writes 65: call isOutsideAuthor

### preapproval

- src/preapproval/index.ts:76 `say`: reads 77: call conversationOf; writes 77: call insertTurn
- src/preapproval/index.ts:106 `revertAnswer`: reads 109: SELECT 1 FROM audit WHERE action = 'answer' AND target = ? A; writes 110: UPDATE main.decisions SET answer = NULL, answer_note = NULL,
- src/preapproval/index.ts:117 `cancelRow`: reads 128: call inActiveBatch; writes 132: call moveRaw
- src/preapproval/index.ts:150 `runPipelineStep`: reads 153: call prRow; writes 157: call markReviewsStale
- src/preapproval/index.ts:226 `preapproveMerge`: reads 229: call prRow; writes 232: call loadPrFact
- src/preapproval/index.ts:267 `askMerge`: reads 269: call getDecision; writes 276: call withdrawOtherHeadQuestions
- src/preapproval/index.ts:286 `handOver`: reads 296: SELECT 1 FROM verifications WHERE repo = ? AND number = ? AN; writes 314: call moveRaw
- src/preapproval/index.ts:350 `reviewAt`: reads 351: SELECT verdict, sure, reason FROM opus_reviews WHERE repo = ; writes 353: call staleReviews
- src/preapproval/index.ts:396 `advance`: reads 397: call prRow; writes 402: call advance.cancel
- src/preapproval/index.ts:399 `advance.stop`: reads 400: call move; writes 400: call askMerge
- src/preapproval/index.ts:519 `endStaleRequests`: reads 521: SELECT id, repo, number, from_head, by, preapproval_id FROM ; writes 523: UPDATE operator_fixups SET state = 'ended' WHERE id = ? AND 
- src/preapproval/index.ts:539 `settleCancelled`: reads 541: SELECT * FROM preapprovals WHERE state = 'cancelled' AND hea; writes 543: call move
- src/preapproval/index.ts:552 `carryAnswers`: reads 553: SELECT m.repo, m.number, m.from_head, m.to_head, 'base merge; writes 569: INSERT INTO preapprovals (repo, number, by, at, instructions
- src/preapproval/index.ts:584 `advancePreapprovals`: reads 588: call refreshSettlers; writes 595: call endStaleRequests
- src/preapproval/index.ts:628 `cancelPreapproval`: reads 629: SELECT id FROM preapprovals WHERE repo = ? AND number = ? AN; writes 642: call removeFromBatch
- src/preapproval/index.ts:659 `retryPreapproval`: reads 660: SELECT * FROM preapprovals WHERE repo = ? AND number = ? ORD; writes 663: call runPipelineStep

### premerge

- src/premerge/index.ts:24 `run`: reads 27: call connect; writes 31: call audit
- src/premerge/review.ts:94 `runPremerge.map-callback.<anonymous>`: reads 104: call coreRate; writes 111: call jobItem

### prepush

- src/prepush/cli.ts:40 `runLint`: reads 42: SELECT head_oid, state FROM items WHERE repo = ? AND number ; writes 61: call cratesForTests
- src/prepush/cli.ts:97 `run`: reads 98: call connect; writes 98: call runLint
- src/prepush/index.ts:73 `queueLintFor`: reads 74: call testsFeatureCrates; writes 75: call queueLint
- src/prepush/resume.ts:89 `sweepSessions`: reads 94: SELECT session FROM; writes 104: UPDATE
- src/prepush/tests.ts:139 `testsFeatureCrates`: reads 140: call featureOn; writes 140: call cratesForTests

### priority

- src/priority/index.ts:46 `rescore`: reads 47: call reachOfOpenItems; writes 52: write block
- src/priority/index.ts:66 `runPrioritize`: reads 68: call fillEmbedHashes; writes 76: call runTiered
- src/priority/index.ts:100 `run`: reads 104: call connect; writes 104: call runPrioritize
- src/priority/reach.ts:27 `reachOfOpenItems`: reads 29: SELECT repo, number, COUNT(DISTINCT author) AS n FROM commen; writes 32: call settledTable

### rank

- src/rank/index.ts:24 `runRank`: reads 25: call latestRun; writes 50: write block
- src/rank/index.ts:74 `run`: reads 75: call connect; writes 90: call runRank

### remote

- src/remote/calls.ts:105 `enqueueCall`: reads 107: SELECT user_login FROM main.remote_calls WHERE id = ?; writes 109: INSERT INTO main.remote_calls (job_id, step, stage, prompt_i
- src/remote/calls.ts:118 `withdrawCall`: reads 119: UPDATE main.remote_calls SET state = 'failed', error = ?, en; writes 122: call finishRun
- src/remote/calls.ts:127 `withdrawJobCalls`: reads 129: SELECT id FROM main.remote_calls WHERE state IN ('queued', '; writes 131: call withdrawCall
- src/remote/calls.ts:176 `expireLeases`: reads 178: call dashboardAlive; writes 192: call requeue
- src/remote/calls.ts:216 `liveLease`: reads 219: SELECT id FROM main.remote_calls WHERE lease_secret_hash = ?; writes 221: call expireLeases
- src/remote/calls.ts:412 `leaseCall`: reads 415: SELECT bundle FROM main.remote_calls WHERE id = ? AND state ; writes 436: call insertRun
- src/remote/calls.ts:530 `claimOrder`: reads 531: call queuedCalls; writes 544: call clearPick
- src/remote/calls.ts:603 `claimableCalls`: reads 604: call expireLeases; writes 613: call claimOrder
- src/remote/calls.ts:683 `prepareClaim`: reads 688: SELECT id, run_id, lease_secret_hash FROM main.remote_calls ; writes 689: call unlease
- src/remote/calls.ts:694 `prepareClaim.attempt`: reads 696: call claimOrder; writes 709: call claimOrder
- src/remote/calls.ts:771 `heartbeat`: reads 772: call liveLease; writes 776: UPDATE main.remote_calls SET heartbeat_at = ?, progress = CO
- src/remote/calls.ts:801 `submitCall`: reads 802: call liveLease; writes 819: call requeue
- src/remote/calls.ts:851 `releaseCall`: reads 852: call liveLease; writes 855: call unlease
- src/remote/calls.ts:883 `awaitCall`: reads 885: call pollCall; writes 887: call endChecks
- src/remote/calls.ts:891 `pollCall`: reads 901: call expireLeases; writes 908: UPDATE main.remote_calls SET reply = NULL WHERE id = ?
- src/remote/check-relay.ts:18 `serveChecks`: reads 19: SELECT id, run_id, input FROM main.remote_checks WHERE call_; writes 21: UPDATE main.remote_checks SET state = 'running' WHERE id = ?
- src/remote/check-relay.ts:42 `relayCheck`: reads 48: SELECT state, result FROM main.remote_checks WHERE id = ?; writes 53: UPDATE main.remote_checks SET state = 'done', result = ?, en
- src/remote/cli.ts:13 `run`: reads 14: call connect; writes 24: call setInferenceMode
- src/remote/cli.ts:29 `run`: reads 30: call makeToken; writes 35: call connect
- src/remote/cli.ts:42 `makeToken`: reads 55: call connect; writes 69: call audit
- src/remote/cooloff.ts:37 `noteDrop`: reads 38: SELECT 1 FROM main.remote_lease_drops WHERE token_id = ? AND; writes 40: INSERT INTO main.remote_lease_drops (token_id, login, call_i
- src/remote/cooloff.ts:46 `noteFailure`: reads 47: SELECT failures, failures_since FROM main.remote_cooloffs WH; writes 50: call coolOff
- src/remote/cooloff.ts:73 `clearCooloff`: reads 74: call cooloffOf; writes 75: DELETE FROM main.remote_cooloffs WHERE login = ?
- src/remote/device-login.ts:96 `pollLogin`: reads 98: SELECT id, state, expires_at FROM main.runner_logins WHERE s; writes 104: UPDATE main.runner_logins SET state = 'expired' WHERE id = ?
- src/remote/device-login.ts:136 `approveLogin`: reads 148: call addRunnerToken; writes 149: UPDATE main.runner_logins SET state = 'approved', login = ?,
- src/remote/device-login.ts:159 `denyLogin`: reads 160: call pendingRow; writes 162: UPDATE main.runner_logins SET state = 'denied', login = ? WH
- src/remote/manual-only.ts:26 `setManualOnly`: reads 27: call manualOnly; writes 28: DELETE FROM main.user_settings WHERE login = ? AND key = ?
- src/remote/max-calls.ts:26 `setUserMaxCalls`: reads 27: call userMaxCalls; writes 28: DELETE FROM main.user_settings WHERE login = ? AND key = ?
- src/remote/mode.ts:20 `setInferenceMode`: reads 21: call inferenceMode; writes 22: DELETE FROM main.settings WHERE key = ?
- src/remote/mode.ts:106 `setAcceptedModels`: reads 107: call acceptedModels; writes 120: INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONF
- src/remote/my-repos.ts:34 `setUserRepos`: reads 35: call userRepos; writes 36: INSERT INTO main.user_settings (login, key, value, updated_a
- src/remote/my-tasks.ts:72 `setUserTasks`: reads 73: call userTasks; writes 76: DELETE FROM main.user_settings WHERE login = ? AND key = ?
- src/remote/permission.ts:43 `lookup`: reads 44: SELECT owner FROM main.repos WHERE name = ?; writes 56: INSERT INTO repo_permissions (login, repo, permission, check
- src/remote/picks.ts:35 `setPickMinutes`: reads 38: call pickMinutes; writes 39: INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONF
- src/remote/picks.ts:129 `pickCall`: reads 130: call readCall; writes 147: UPDATE main.remote_calls SET picked_by = ?, picked_at = ?, p
- src/remote/picks.ts:161 `unpickCall`: reads 163: call readCall; writes 168: call clearPick
- src/remote/reserve.ts:37 `setUserReserve`: reads 38: call userReserve; writes 41: INSERT INTO main.user_settings (login, key, value, updated_a
- src/remote/takers.ts:144 `sweepTakers`: reads 145: call inferenceMode; writes 146: DELETE FROM main.remote_no_taker
- src/remote/task-items.ts:34 `setUserTaskItems`: reads 35: call userTaskItems; writes 36: DELETE FROM main.user_settings WHERE login = ? AND key = ?
- src/remote/tools.ts:91 `reference`: reads 94: SELECT COUNT(*) AS n FROM main.remote_passages WHERE call_id; writes 115: INSERT INTO main.remote_passages (call_id, run_id, user_logi
- src/remote/tools.ts:161 `callTaskTool`: reads 167: call reference; writes 168: call relayCheck

### repin

- src/repin/index.ts:118 `requestRepin`: reads 120: call settleRefusal; writes 127: INSERT INTO main.autorepin_offs (repo, number, off_at) VALUE
- src/repin/index.ts:218 `finish`: reads 219: call stopTask; writes 220: UPDATE main.autorepins SET state = ?, result = ?, done_at = 
- src/repin/index.ts:225 `step`: reads 230: call getTask; writes 232: call cancelTask
- src/repin/index.ts:450 `notify`: reads 452: call isQuiet; writes 453: UPDATE main.autorepins SET notice = 'none' WHERE
- src/repin/index.ts:474 `drainRepins`: reads 477: call repinsDue; writes 482: call step

### review

- src/review/carry-step.ts:9 `runCarry`: reads 10: call staleReviews; writes 13: call planned
- src/review/checks.ts:107 `saveChecks`: reads 114: call recordRuns; writes 114: call recordRuns
- src/review/checks.ts:120 `refreshChecks`: reads 121: SELECT number FROM items i WHERE repo = ? AND kind = 'pr' AN; writes 127: call saveChecks
- src/review/diff.ts:168 `cachedDiff`: reads 195: SELECT 1 FROM diff_facts WHERE repo = ? AND number = ? AND h; writes 195: call recordDiffFacts
- src/review/diff.ts:207 `rereadDiff`: reads 208: call cachedDiff; writes 209: call noteReread
- src/review/diff.ts:373 `buildDiffFacts`: reads 376: SELECT value FROM settings WHERE key = ?; writes 378: write block
- src/review/discussion.ts:274 `discussionState`: reads 275: SELECT topic, seq FROM change_seq WHERE topic IN ('items', '; writes 276: call allOwnLogins
- src/review/discussion.ts:287 `computeDiscussionState`: reads 288: call ownLogins; writes 288: call allOwnLogins
- src/review/discussion.ts:399 `staleReviews`: reads 401: call reviewedRows; writes 402: call discussionState
- src/review/discussion.ts:431 `ensurePipelineLogin`: reads 432: call pipelineLogin; writes 435: call setPipelineLogin
- src/review/discussion.ts:444 `liveGate`: reads 445: call liveDiscussion; writes 446: call recordGate
- src/review/gate.ts:30 `setReviewMinInterval`: reads 33: call reviewMinInterval; writes 34: INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONF
- src/review/gate.ts:42 `recordReviewFailure`: reads 44: call setting; writes 46: DELETE FROM main.settings WHERE key LIKE ? AND key <> ?
- src/review/gate.ts:113 `reviewHolds.<anonymous>`: reads 124: call discussionState; writes 132: call discussionState
- src/review/index.ts:37 `run`: reads 41: call connect; writes 44: call markReviewsStale
- src/review/index.ts:50 `run`: reads 53: call connect; writes 53: call runChecks
- src/review/opus.ts:78 `saveOpus`: reads 80: SELECT at FROM opus_reviews WHERE repo = ? AND number = ? AN; writes 85: call countRerun
- src/review/opus.ts:173 `prepareOpusInput`: reads 174: SELECT base_ref FROM items WHERE repo = ? AND number = ?; writes 175: call cachedDiff
- src/review/opus.ts:235 `runOpusReview`: reads 238: call selectOpusCandidates; writes 239: call staleReviews
- src/review/opus.ts:276 `runOpusReview.map-callback.<anonymous>`: reads 278: call prepareOpusInput; writes 280: call jobItem
- src/review/opus.ts:338 `run`: reads 354: call connect; writes 354: call runOpusReview
- src/review/post.ts:46 `postCandidates`: reads 50: call githubIdentity; writes 52: call planned
- src/review/post.ts:80 `runReviewPost`: reads 85: call commentApprovalOf; writes 90: call postCandidates
- src/review/post.ts:145 `run`: reads 158: call connect; writes 158: call runReviewPost
- src/review/summary.ts:51 `fillReviewSummaries`: reads 52: SELECT * FROM decisions WHERE kind IN ('merge', 'close', 'ho; writes 70: UPDATE main.decisions SET summary = ?, summary_by = ?, summa

### runner

- src/runner/autopilot.ts:161 `planCtx`: reads 165: call refreshOutsideHolds; writes 182: call loadPlanSet
- src/runner/autopilot.ts:172 `planCtx.<anonymous>`: reads 173: call rereadSettingsSnapshot; writes 176: call planPass
- src/runner/autopilot.ts:193 `servable`: reads 194: call untakenTest; writes 196: call plansOf
- src/runner/autopilot.ts:328 `cifixRepos`: reads 330: call plansOf; writes 330: call planned
- src/runner/autopilot.ts:339 `detect`: reads 340: call jevUsable; writes 341: call servable
- src/runner/autopilot.ts:347 `detect`: reads 348: call jevUsable; writes 349: call servable
- src/runner/autopilot.ts:362 `detect`: reads 362: call plansOf; writes 362: call embedDue
- src/runner/autopilot.ts:367 `detect`: reads 368: call plansOf; writes 370: call servable
- src/runner/autopilot.ts:382 `detect`: reads 384: SELECT recommend_failed_at AS at FROM decisions WHERE answer; writes 386: call servable
- src/runner/autopilot.ts:393 `detect`: reads 395: call plansOf; writes 395: call planned
- src/runner/autopilot.ts:431 `topScore`: reads 432: call plansOf; writes 432: call planned
- src/runner/autopilot.ts:460 `detect`: reads 462: call plansOf; writes 462: call planned
- src/runner/autopilot.ts:470 `detect`: reads 471: call plansOf; writes 475: call planned
- src/runner/autopilot.ts:513 `detect`: reads 516: call plansOf; writes 522: call plansOf
- src/runner/autopilot.ts:543 `detect`: reads 544: call plansOf; writes 545: call selectFixups
- src/runner/autopilot.ts:559 `detect`: reads 561: call plansOf; writes 562: call planned
- src/runner/autopilot.ts:586 `detect`: reads 586: call reposWithQueuedBuilds; writes 586: call prBuildDue
- src/runner/autopilot.ts:592 `detect`: reads 593: call plansOf; writes 594: call plansOf
- src/runner/autopilot.ts:611 `detect`: reads 613: SELECT json_extract(probs, '$.opusFailedAt') AS at FROM clas; writes 614: call servable
- src/runner/autopilot.ts:621 `detect`: reads 622: call plansOf; writes 622: call planned
- src/runner/autopilot.ts:630 `detect`: reads 631: call plansOf; writes 631: call planned
- src/runner/autopilot.ts:644 `detect`: reads 644: call plansOf; writes 644: call plansOf
- src/runner/autopilot.ts:651 `detect`: reads 653: call plansOf; writes 653: call planned
- src/runner/autopilot.ts:661 `detect`: reads 662: call plansOf; writes 663: call planned
- src/runner/autopilot.ts:676 `detect`: reads 678: call plansOf; writes 678: call premergeCandidates
- src/runner/autopilot.ts:686 `detect`: reads 686: call plansOf; writes 686: call selectPostmerge
- src/runner/autopilot.ts:841 `pauseOf`: reads 842: call limitRow; writes 852: call claudePauseReason
- src/runner/autopilot.ts:868 `setEnabled`: reads 874: SELECT id, step FROM jobs WHERE state = 'queued' AND request; writes 876: call requestCancel
- src/runner/autopilot.ts:955 `stageLimits`: reads 957: call stageStatus; writes 960: call pauseReason
- src/runner/autopilot.ts:964 `pipelineState`: reads 966: call judgementModel; writes 968: call stageLimits
- src/runner/autopilot.ts:1009 `detectPass`: reads 1015: call planCtx; writes 1083: call detectPass.gate
- src/runner/autopilot.ts:1043 `detectPass.gate`: reads 1048: call jobBlock; writes 1049: call detectPass.pausedWhy
- src/runner/autopilot.ts:1157 `applyProposals`: reads 1165: call untakenTest; writes 1166: call applyUsedAnswers
- src/runner/autopilot.ts:1203 `planAutopilot`: reads 1204: call detectAutopilot; writes 1205: call applyProposals
- src/runner/autopilot.ts:1219 `planDue`: reads 1221: call inputSignature; writes 1231: call writeSetting
- src/runner/autopilot.ts:1273 `laneItems`: reads 1276: call plansOf; writes 1303: call planned
- src/runner/autopilot.ts:1321 `storeLaneItems`: reads 1322: SELECT lane, total, items FROM lane_next; writes 1326: call laneItems
- src/runner/autopilot.ts:1360 `heldLookup.<anonymous>`: reads 1367: call heldLookup.laneHold; writes 1370: call heldLookup.laneHold
- src/runner/autopilot.ts:1392 `laneGate`: reads 1393: call isEnabled; writes 1400: call pauseReason
- src/runner/classify.ts:48 `jevPass`: reads 52: call jevAvailable; writes 54: call keepUsage
- src/runner/classify.ts:69 `haikuPass`: reads 75: call freeSlots; writes 77: call keepUsage
- src/runner/classify.ts:89 `haikuOnlyPass`: reads 92: call haikuPass; writes 98: UPDATE main.classifications SET input_hash = ? WHERE repo = 
- src/runner/classify.ts:123 `pass`: reads 127: call jevItems; writes 131: call jevPass
- src/runner/classify.ts:150 `classifyNew`: reads 151: call latestRun; writes 153: call pass
- src/runner/classify.ts:158 `classifyAll`: reads 160: call pass; writes 162: INSERT INTO settings (key, value) VALUES ('classify_run', ?)
- src/runner/cli-job.ts:51 `runCliJob`: reads 55: call checkRequest; writes 57: write block
- src/runner/concurrency.ts:31 `setStepParallel`: reads 36: call stepParallelSetting; writes 37: INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT 
- src/runner/exec.ts:25 `execJob`: reads 26: call connect; writes 51: call execJob.fail
- src/runner/exec.ts:34 `execJob.saveUsage`: reads 35: call usageOf; writes 36: UPDATE jobs SET usage = ? WHERE id = ?
- src/runner/exec.ts:38 `execJob.fail`: reads 39: call execJob.saveUsage; writes 40: UPDATE jobs SET error = ? WHERE id = ?
- src/runner/index.ts:37 `serve`: reads 41: call connect; writes 42: call scopeToTracked
- src/runner/index.ts:107 `enqueueCmd`: reads 118: call connect; writes 119: call scopeToTracked
- src/runner/index.ts:138 `cancel`: reads 142: call connect; writes 142: call requestCancel
- src/runner/index.ts:168 `planLog`: reads 169: call connect; writes 180: call writeSetting
- src/runner/index.ts:201 `pipeline`: reads 203: call connect; writes 212: call setEnabled
- src/runner/jobs.ts:122 `enqueue`: reads 123: call checkRequest; writes 132: INSERT INTO jobs (step, params, repo, requested_by, requeste
- src/runner/jobs.ts:138 `requestCancel`: reads 139: call jobRow; writes 143: UPDATE jobs SET state = 'cancelled', ended_at = ?, cancel_re
- src/runner/jobs.ts:157 `pruneJobs`: reads 164: SELECT id, log_path FROM jobs WHERE ended_at IS NOT NULL AND; writes 174: DELETE FROM job_items WHERE job_id = ?
- src/runner/jobs.ts:227 `endJob`: reads 228: call jobRow; writes 239: call failRunning
- src/runner/runner.ts:143 `Runner.recover`: reads 148: call withdrawJobCalls; writes 149: DELETE FROM work_leases
- src/runner/runner.ts:163 `Runner.tick`: reads 173: call cancels; writes 176: call reapLost
- src/runner/runner.ts:194 `Runner.webhookTick`: reads 197: SELECT 1 FROM main.github_commands WHERE; writes 201: call Runner.webhookTick.<anonymous>
- src/runner/runner.ts:201 `Runner.webhookTick.<anonymous>`: reads 204: call seedRate; writes 206: call drainSyncRequests
- src/runner/runner.ts:251 `Runner.reconcileTick.<anonymous>`: reads 253: call seedRate; writes 255: call reconcileNext
- src/runner/runner.ts:263 `Runner.autopilot`: reads 270: call isEnabled; writes 271: call applyProposals
- src/runner/runner.ts:319 `Runner.usageTick`: reads 324: call recordUsageSamples; writes 331: call tick
- src/runner/runner.ts:368 `Runner.cancels`: reads 370: SELECT cancel_requested_at FROM jobs WHERE id = ?; writes 389: UPDATE jobs SET error = ? WHERE id = ? AND state = 'running'
- src/runner/runner.ts:419 `Runner.startJobs`: reads 421: SELECT id, step, params, requested_by, repo FROM jobs WHERE ; writes 434: UPDATE jobs SET state = 'failed', ended_at = ?, error = ? WH
- src/runner/runner.ts:535 `Runner.serve`: reads 536: call recover; writes 538: call buildDiffFacts
- src/runner/steps.ts:210 `run`: reads 212: call checkApproved; writes 216: call ensureLabels
- src/runner/steps.ts:232 `run`: reads 234: call checkApproved; writes 242: call ensureLabels
- src/runner/steps.ts:314 `run`: reads 318: call checkMergeApproved; writes 321: call runSingles
- src/runner/steps.ts:344 `run`: reads 347: call trackedNames; writes 347: call askMergeDecisions
- src/runner/steps.ts:363 `run`: reads 365: call checkCommentApproved; writes 367: call runAct
- src/runner/steps.ts:390 `run`: reads 392: call checkPushApproved; writes 394: call runFixup
- src/runner/steps.ts:496 `run`: reads 498: call checkFixIssueApproved; writes 500: call runFixIssue
- src/runner/steps.ts:559 `run`: reads 564: call rawFinding; writes 567: call leaseItem
- src/runner/steps.ts:707 `run`: reads 709: call checkCommentApproved; writes 711: call runReviewPost
- src/runner/steps.ts:763 `run`: reads 765: call checkCommentApproved; writes 767: call runPostmergeFile
- src/runner/steps.ts:885 `run`: reads 889: call checkCiApproved; writes 892: call approveRuns
- src/runner/steps.ts:911 `run`: reads 913: call checkPushApproved; writes 915: call runCifix
- src/runner/steps.ts:931 `run`: reads 933: call checkCiApproved; writes 935: call runRerun
- src/runner/steps.ts:949 `run`: reads 951: call checkMainFixApproved; writes 953: call runMainFix
- src/runner/steps.ts:966 `run`: reads 968: call checkNightlyOn; writes 970: call runNightly
- src/runner/worker.ts:14 `on-callback`: reads 16: call detectAutopilot; writes 16: call refreshSummary

### sandbox

- src/sandbox/workspace.ts:34 `setWorkspaceExcluded`: reads 39: call workspaceExcluded; writes 40: INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONF
- src/sandbox/workspace.ts:147 `run`: reads 149: call connect; writes 150: call setWorkspaceExcluded

### security

- src/security/actions.ts:33 `startScanAs`: reads 36: call reconcileScans; writes 39: INSERT INTO security_scans (repo, state, cap_usd, started_by
- src/security/actions.ts:59 `continueScanAs`: reads 60: call scanRow; writes 66: call reconcileScans
- src/security/actions.ts:86 `stopScanAs`: reads 87: call scanRow; writes 92: call requestCancel
- src/security/actions.ts:99 `actOnFindingAs`: reads 102: call startStep; writes 108: call moveFinding
- src/security/actions.ts:120 `autoFixConfirmed`: reads 122: SELECT DISTINCT repo FROM security_findings WHERE state = 'f; writes 123: call reconcileFindings
- src/security/actions.ts:150 `advanceSecurityFixes`: reads 151: SELECT f.repo, f.number, f.decided_by AS by, r.created_at, r; writes 171: call cancelTask
- src/security/actions.ts:185 `startStep`: reads 186: call findingRow; writes 195: call clearRounds
- src/security/cli.ts:56 `open`: reads 57: call connect; writes 58: call scopeToTracked
- src/security/cli.ts:110 `list`: reads 113: call open; writes 114: call reconcileScans
- src/security/cli.ts:123 `show`: reads 127: call open; writes 128: call reconcileFindings
- src/security/fix.ts:68 `defaultFixDeps.ask`: reads 69: SELECT COALESCE(MAX(id), 0) AS n FROM agent_runs; writes 70: call runModelStep
- src/security/fix.ts:97 `giveUp`: reads 98: call clearRounds; writes 99: call advance
- src/security/fix.ts:111 `runFix`: reads 112: call rawFinding; writes 119: UPDATE security_findings SET env_wait_at = COALESCE(env_wait
- src/security/land.ts:64 `runLand`: reads 65: call rawFinding; writes 70: call back
- src/security/land.ts:167 `runAdvisory`: reads 168: call rawFinding; writes 183: call back
- src/security/land.ts:236 `draftAdvisory`: reads 243: call advisoryRange; writes 243: call ghAdvisoryCreate
- src/security/land.ts:252 `runPublish`: reads 253: call rawFinding; writes 259: call runPublish.note
- src/security/land.ts:324 `pollLanding`: reads 326: SELECT repo, number, fix_pr FROM security_findings WHERE sta; writes 329: call advance
- src/security/land.ts:371 `pollLandingIfDue`: reads 372: SELECT 1 FROM security_findings WHERE (state = 'landing' AND; writes 376: INSERT INTO settings (key, value) VALUES ('security_poll_at'
- src/security/real.ts:19 `realDeps.send`: reads 20: SELECT COALESCE(MAX(id), 0) AS n FROM agent_runs; writes 24: call askClaude
- src/security/scan.ts:128 `linkRepeatedFindings`: reads 129: SELECT repo, number, state, fingerprint, title, refs, catego; writes 136: UPDATE security_findings SET state = 'duplicate', duplicate_
- src/security/scan.ts:155 `runScan`: reads 156: call scanRow; writes 198: call runScan.fail
- src/security/scan.ts:170 `runScan.call`: reads 173: call runScan.stopped; writes 175: INSERT INTO security_calls (scan_id, kind, area_idx, finding
- src/security/scantest.ts:48 `writeAndQueue`: reads 63: call createTask; writes 69: INSERT OR REPLACE INTO security_scan_tests (repo, number, te
- src/security/scantest.ts:87 `advanceScanTests`: reads 88: call featureOn; writes 94: call advanceScanTests.end
- src/security/store.ts:35 `reconcileScans`: reads 36: SELECT s.id, j.state AS job_state FROM security_scans s JOIN; writes 41: call finishScan
- src/security/store.ts:94 `clearRounds`: reads 95: SELECT fix_attempts, state FROM security_findings WHERE repo; writes 100: INSERT OR REPLACE INTO security_fix_log (repo, number, attem
- src/security/store.ts:112 `reconcileFindings`: reads 114: SELECT number, state FROM security_findings WHERE repo = ? A; writes 122: call clearRounds
- src/security/store.ts:127 `overview`: reads 128: call reconcileScans; writes 129: call reconcileFindings

### unassign

- src/unassign/index.ts:26 `runUnassign`: reads 32: call planned; writes 42: call setPipelineLogin

### verify

- src/verify/index.ts:104 `runVerify`: reads 107: call selectCandidates; writes 120: call unavailableCandidates
- src/verify/index.ts:131 `runVerify.map-callback.<anonymous>`: reads 148: call maybeScreenshot; writes 151: call runVerify.map-callback.<anonymous>.byCi
- src/verify/index.ts:247 `run`: reads 250: call connect; writes 250: call runCollect
- src/verify/index.ts:255 `run`: reads 260: call connect; writes 260: call runVerify
- src/verify/results.ts:187 `summariseFailure`: reads 188: call getTask; writes 194: call askClaude
- src/verify/results.ts:201 `cancelOpen`: reads 203: call getTask; writes 204: call cancelTask
- src/verify/results.ts:212 `runCollect`: reads 216: SELECT v.*, i.state AS item_state,; writes 309: call collectScreenshots
- src/verify/results.ts:230 `runCollect.one`: reads 246: call cancelOpen; writes 247: call runCollect.one.finish
- src/verify/results.ts:306 `runCollect.map-callback.<anonymous>`: reads 306: call runCollect.one; writes 306: call runCollect.one
- src/verify/results.ts:318 `cancelMovedWarmBuilds`: reads 320: SELECT t.id, t.repo, t.head_sha, r.default_branch FROM build; writes 325: call cancelTask
- src/verify/screenshots.ts:72 `maybeScreenshot`: reads 73: call featureOn; writes 78: call cachedDiff
- src/verify/screenshots.ts:184 `collectScreenshots`: reads 185: SELECT r.*, i.state AS item_state,; writes 192: call leaseItem
- src/verify/screenshots.ts:199 `collectOne`: reads 210: call featureOn; writes 211: call cancelOpen
- src/verify/tasks.ts:43 `queueWarmBuild`: reads 44: SELECT 1 FROM build_tasks WHERE repo = ? AND head_sha = ? AN; writes 48: call createTask
- src/verify/tasks.ts:57 `cloneTask`: reads 58: SELECT * FROM build_tasks WHERE id = ?; writes 60: call createTask
- src/verify/tasks.ts:130 `queueScreenshotTasks`: reads 131: call featureOn; writes 132: call createTask

### worker

- src/worker/index.ts:21 `updateCode`: reads 29: call connect; writes 31: call requestUpdate
- src/worker/index.ts:71 `run`: reads 72: call updateCode; writes 74: call connect

