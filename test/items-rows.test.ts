// Items rows: the approved compact row, the open=repo#number selection and every fact the inline
// expansion may show. These pin the mapping from the real DTOs, including what it must not invent.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Classification, Item, ItemListRow, ItemStatusRow, Settled, TimelineEntry } from "../web/src/api/types.ts";
import {
  aliasToOpenHref, classificationDetail, classificationToken, decisionReceipt, detailFacts, factsFromListRow, factsFromStatusRow,
  absoluteEventTime, answerFacts, answerQueueText, conflictNote, effectiveSettled, eventDateTime, lastEvents, parseRef, parseSelection, pipelineRead, receipt, refKey,
  rowWord, scopedPayload, selectionPatch, selectionProblem, statusWord,
} from "../web/src/modules/items/rows.ts";

const settled = (over: Partial<Settled> = {}): Settled => ({ status: "settled", label: "bugfix", source: "jev", confidence: 0.62, jevLabel: "bugfix", haikuLabel: null, flags: [], referee: null, ...over });

function listRow(over: Partial<ItemListRow> = {}): ItemListRow {
  return {
    repo: "photocraft", number: 4127, kind: "pr", state: "open", title: "Add Wave", author: "pixel-wrangler",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z", comments: 2, discord: 3, settled: settled(), stage: "needs-decision", snippet: null, queue: { stage: "Review", tab: "review", place: 2 }, mergedHow: null, mergedAt: null, ...over,
  };
}
const statusRow = (over: Partial<ItemStatusRow> = {}): ItemStatusRow => ({ repo: "wordcraft", number: 2231, kind: "pr", state: "open", title: "Keep the hyperlink", author: null, status: { phase: "Fixing", waiting: "waiting for fix-up round 2", next: "review of the new head", since: "2026-01-05T00:00:00Z" }, updatedAt: "2026-01-05T01:00:00Z", ...over });

test("a selection parses open=repo#number and reports what it cannot use", () => {
  assert.deepEqual(parseRef("photocraft#4127"), { repo: "photocraft", number: 4127 });
  assert.equal(parseRef("photocraft#0"), null);
  assert.equal(parseRef("nope"), null);
  assert.equal(refKey({ repo: "a", number: 2 }), "a#2");
  const open = parseSelection("open=photocraft%234127&state=open");
  assert.deepEqual(open.open, { repo: "photocraft", number: 4127 });
  assert.equal(open.aliasPeek, undefined);
  assert.equal(parseSelection("open=nope").openRaw, "nope");
  assert.equal(parseSelection("open=nope").open, null);
});

test("a legacy peek link is the same selection under its old name", () => {
  const alias = parseSelection("peek=photocraft%234127&q=wave");
  assert.deepEqual(alias.open, null);
  assert.deepEqual(alias.aliasPeek, { repo: "photocraft", number: 4127 });
  // Both keys, same row: still just an alias.
  assert.deepEqual(parseSelection("open=photocraft%234127&peek=photocraft%234127").aliasPeek, { repo: "photocraft", number: 4127 });
  // Both keys, different rows: open wins and the ignored peek is kept for the note.
  const conflict = parseSelection("open=photocraft%234127&peek=deckcraft%23360");
  assert.deepEqual(conflict.open, { repo: "photocraft", number: 4127 });
  assert.equal(conflict.ignoredPeek, "deckcraft#360");
  assert.equal(parseSelection("peek=nope").malformedPeek, "nope");
  assert.equal(aliasToOpenHref("?peek=photocraft%234127&q=wave", { repo: "photocraft", number: 4127 }), "/items?q=wave&open=photocraft%234127");
});

test("toggling the row writes or clears only the selection keys", () => {
  assert.deepEqual(selectionPatch({ repo: "a", number: 1 }), { open: "a#1", peek: null });
  assert.deepEqual(selectionPatch(null), { open: null, peek: null });
});

test("an unusable selection is described, never turned into a row", () => {
  const keys = ["photocraft#4127"];
  assert.equal(selectionProblem(parseSelection("open=photocraft%234127"), keys), null);
  const outside = selectionProblem(parseSelection("open=deckcraft%23360"), keys);
  assert.equal(outside?.title, "That item is not in these results");
  assert.equal(outside?.href, "/items/deckcraft/360");
  assert.equal(selectionProblem(parseSelection("open=nope"), keys)?.title, "This item link is invalid");
  assert.equal(selectionProblem(parseSelection("peek=nope"), keys)?.title, "The old preview link is invalid");
  assert.equal(selectionProblem(parseSelection(""), keys), null);
});

test("row facts come from the payload that carries them, and phase rows say what they lack", () => {
  const normal = factsFromListRow(listRow());
  assert.equal(normal.phaseScoped, false);
  assert.equal(normal.key, "photocraft#4127");
  assert.deepEqual(normal.flags, []);
  assert.equal(normal.queue?.place, 2);
  assert.equal(normal.author, "pixel-wrangler");
  assert.equal(normal.discord, 3);
  const phase = factsFromStatusRow(statusRow());
  assert.equal(phase.phaseScoped, true);
  assert.equal(phase.settled, undefined);
  assert.equal(phase.queue, null);
  assert.equal(phase.status?.phase, "Fixing");
  assert.equal(phase.author, undefined);
});

test("the row token is the real classification, or the phase, never an invented label", () => {
  // The approved reference's tones: settled neutral, every unsettled state warn (F3).
  assert.deepEqual(classificationToken(settled()), { text: "bugfix", tone: "neutral" });
  assert.deepEqual(classificationToken(settled({ status: "waiting", label: null })), { text: "Waiting for a second opinion", tone: "warn" });
  assert.deepEqual(classificationToken(settled({ status: "disagree", label: null })), { text: "Classifiers disagree", tone: "warn" });
  assert.deepEqual(classificationToken(settled({ status: "unclassified", label: null })), { text: "Not classified", tone: "warn" });
  assert.equal(statusWord(factsFromListRow(listRow())), "Waiting for a decision");
  // A row with no stage, queue or phase shows no placeholder word at all; the expansion says it once.
  assert.equal(rowWord(factsFromListRow(listRow({ stage: null, queue: null }))), null);
  assert.equal(rowWord(factsFromListRow(listRow())), "Waiting for a decision");
  assert.equal(statusWord(factsFromStatusRow(statusRow())), "waiting for fix-up round 2");
  assert.equal(statusWord(factsFromStatusRow(statusRow({ status: { phase: "Review", waiting: null, next: "merge", since: "x" } }))), "merge");
});

test("classification provenance names the classifiers and their confidence", () => {
  assert.equal(classificationDetail(settled({ source: "jev", confidence: 0.62 })), "Jev 0.62");
  assert.equal(classificationDetail(settled({ source: "haiku", confidence: null })), "Jev unsure, Haiku agrees");
  const waiting = classificationDetail(settled({ status: "waiting", label: null, confidence: 0.51, jevLabel: "bugfix", haikuLabel: "performance" }));
  assert.match(waiting, /^Waiting for a second opinion\. Jev bugfix 0\.51 · Haiku performance$/);
  const disagree = classificationDetail(settled({ status: "disagree", label: null, jevLabel: "bugfix", haikuLabel: "small extra", referee: { label: "bugfix", sure: false, reason: "the diff touches only the toolbar" } }));
  assert.match(disagree, /Classifiers disagree\. Jev bugfix.*Haiku small extra.*Sonnet bugfix, unsure: the diff touches only the toolbar/);
  assert.match(classificationDetail(settled({ status: "unclassified", label: null })), /No classifier has run/);
  // With earlier records present, the copy must not claim that no classifier ran.
  assert.match(classificationDetail(settled({ status: "unclassified", label: null }), 2), /latest classification run settled nothing/i);
});

test("last events are the newest three of the selected item's real timeline", () => {
  const at = (iso: string, text: string): TimelineEntry => ({ id: text, at: iso, kind: "harness", actor: "AutoCraft", icon: "job", text, tone: "neutral", costUsd: null, major: true, jobId: null, reviewId: null, githubId: null, commit: null, preapproval: null, calls: [], body: null, markdown: false, lines: [], feedback: null });
  const timeline = [at("2026-01-01T00:00:00Z", "oldest"), at("2026-01-03T00:00:00Z", "newest"), at("2026-01-02T00:00:00Z", "middle"), at("2026-01-04T00:00:00Z", "latest")];
  assert.deepEqual(lastEvents(timeline).map((entry) => entry.text), ["latest", "newest", "middle"]);
  assert.deepEqual(lastEvents(timeline, 2).map((entry) => entry.text), ["latest", "newest"]);
  assert.deepEqual(lastEvents(undefined), []);
});

test("old row metadata stays readable in the expansion, not in the row strip", () => {
  const normal = detailFacts(factsFromListRow(listRow({ snippet: { field: "comment", author: "ana", text: "matched \u0002wave\u0003 text" } })));
  const labels = normal.map((fact) => fact.label);
  for (const label of ["Author", "Kind", "Discord", "Matched", "Stage", "Queue"]) assert.ok(labels.includes(label), label);
  assert.equal(normal.find((fact) => fact.label === "Matched")?.value, "matched wave text");
  assert.equal(normal.find((fact) => fact.label === "Queue")?.value, "Review · place 2");
  const phase = detailFacts(factsFromStatusRow(statusRow()));
  const phaseLabels = phase.map((fact) => fact.label);
  assert.ok(phaseLabels.includes("Phase") && phaseLabels.includes("Waiting for") && phaseLabels.includes("Next"));
  for (const label of ["Author", "Discord", "Matched", "Queue"]) assert.equal(phaseLabels.includes(label), false, label);
});

const cls = (classifier: Classification["classifier"], at: string, reason: string, typeLabel: Classification["typeLabel"] = "bugfix"): Classification => ({ classifier, at, typeLabel, want: "yes", reference: null, reason, dupOf: null });
const itemWith = (classifications: Classification[], over: Partial<Item> = {}): Item => ({ classifications, ...over } as Item);

test("the pipeline-read paragraph is the classifier's own reason, attributed", () => {
  const settledNow = settled({ source: "jev" });
  const read = pipelineRead(itemWith([cls("jev", "2026-01-05T10:00:00Z", "Feature request phrased as an extension of an existing tool.")]), settledNow);
  assert.deepEqual(read, { text: "Feature request phrased as an extension of an existing tool.", classifier: "Jev", at: "2026-01-05T10:00:00Z", matchedSource: true });
  assert.equal(pipelineRead(null, settledNow), null);
  assert.equal(pipelineRead(itemWith([]), settledNow), null);
});

test("the record that settled the label wins; otherwise the newest is named as the latest available", () => {
  const records = [cls("jev", "2026-01-01T00:00:00Z", "older jev"), cls("haiku", "2026-01-04T00:00:00Z", "newer haiku")];
  const matched = pipelineRead(itemWith(records), settled({ source: "jev" }));
  assert.equal(matched?.text, "older jev");
  assert.equal(matched?.matchedSource, true);
  // The settling source has no record (a sonnet settlement with none recorded): the newest record is
  // used and labelled as such, never as consensus.
  const fallback = pipelineRead(itemWith(records), settled({ source: "sonnet" }));
  assert.equal(fallback?.text, "newer haiku");
  assert.equal(fallback?.classifier, "Haiku");
  assert.equal(fallback?.matchedSource, false);
});

test("a redacted or missing reason is an explicit empty state, not a substitute", () => {
  const redacted = pipelineRead(itemWith([cls("jev", "2026-01-05T10:00:00Z", "")]), settled({ source: "jev" }));
  assert.equal(redacted?.text, "");
  assert.equal(redacted?.classifier, "Jev");
});

test("a phase row's expanded classification comes from the selected item; its collapsed row stays phase-only", () => {
  const phase = factsFromStatusRow(statusRow());
  assert.equal(effectiveSettled(phase, null), undefined);
  assert.deepEqual(effectiveSettled(phase, itemWith([], { settled: settled() })), settled());
  // A list row may be historical: the expansion's verdict and reason use the fetched snapshot together.
  const listed = factsFromListRow(listRow());
  const historical = listed.settled;
  const current = settled({ label: "performance", source: "haiku" });
  const fetched = itemWith([
    cls("jev", "2026-01-05T10:00:00Z", "previous source's current reason"),
    cls("haiku", "2026-01-06T10:00:00Z", "reason for the fetched verdict"),
  ], { settled: current });
  const expanded = effectiveSettled(listed, fetched);
  assert.deepEqual(expanded, current);
  assert.equal(pipelineRead(fetched, expanded)?.text, "reason for the fetched verdict");
  assert.deepEqual(listed.settled, historical);
  assert.notDeepEqual(listed.settled, expanded);
  assert.equal(effectiveSettled(listed, itemWith([], { settled: undefined })), undefined);
  assert.equal(effectiveSettled(listed, null), undefined);
});

test("the item GET adds the metadata a phase row lacks, without inventing any", () => {
  const phase = factsFromStatusRow(statusRow());
  const bare = detailFacts(phase).map((fact) => fact.label);
  assert.equal(bare.includes("Author"), false);
  const enriched = detailFacts(phase, itemWith([], { author: "moth-and-lamp", labels: ["bugfix"], discord: { count: 2, links: [] }, queue: { stage: "Review", tab: "review", place: 1 } } as Partial<Item>));
  const byLabel = new Map(enriched.map((fact) => [fact.label, fact.value]));
  assert.equal(byLabel.get("Author"), "moth-and-lamp");
  assert.equal(byLabel.get("Discord"), "2 messages");
  assert.equal(byLabel.get("Labels"), "bugfix");
  assert.equal(byLabel.get("Queue"), "Review · place 1");
  // A row with no item GET still shows no author: absence is not filled in.
  assert.equal(detailFacts(phase).some((fact) => fact.label === "Author"), false);
});

test("F4: a canonical open wins by presence, including when it is empty or malformed", () => {
  const validPeek = "peek=vectorcraft%234464";
  // Absent open: the legacy peek is the alias.
  assert.deepEqual(parseSelection(validPeek).aliasPeek, { repo: "vectorcraft", number: 4464 });
  // Present but malformed open: it stays primary, the peek is not used and no alias is scheduled.
  const malformed = parseSelection("open=not-a-ref&" + validPeek);
  assert.equal(malformed.open, null);
  assert.equal(malformed.aliasPeek, undefined);
  assert.equal(malformed.ignoredPeek, undefined);
  assert.equal(selectionProblem(malformed, ["vectorcraft#4464"])?.title, "This item link is invalid");
  // Present but empty open: same rule.
  const empty = parseSelection("open=&" + validPeek);
  assert.equal(empty.openRaw, "");
  assert.equal(empty.aliasPeek, undefined);
  assert.equal(selectionProblem(empty, [])?.title, "This item link is invalid");
  // Same row in both keys still normalises; a different valid pair keeps open and names the peek.
  assert.deepEqual(parseSelection("open=vectorcraft%234464&" + validPeek).aliasPeek, { repo: "vectorcraft", number: 4464 });
  assert.equal(parseSelection("open=vectorcraft%234464&peek=deckcraft%23360").ignoredPeek, "deckcraft#360");
});

test("F5: an out-of-cohort selection is explicit even when the cohort is empty", () => {
  const problem = selectionProblem(parseSelection("open=vectorcraft%234464"), []);
  assert.equal(problem?.title, "That item is not in these results");
  assert.equal(problem?.href, "/items/vectorcraft/4464");
  assert.equal(selectionProblem(parseSelection(""), []), null);
});

test("F7: a receipt is only usable when it is settled, un-failed and for this row", () => {
  const ref = { repo: "photocraft", number: 4127 };
  const good = { repo: "photocraft", number: 4127, title: "x" };
  assert.deepEqual(receipt(good, { loading: false }, ref), good);
  // Previous-key data kept by keepPreviousData is not a receipt while the new key loads or fails.
  assert.equal(receipt(good, { loading: true }, ref), null);
  assert.equal(receipt(good, { loading: false, error: "boom" }, ref), null);
  assert.equal(receipt({ repo: "photocraft", number: 1 }, { loading: false }, ref), null);
  assert.equal(receipt(undefined, { loading: false }, ref), null);
  // Decisions: the row's own, or a batch decision (number null) the endpoint resolved by membership.
  assert.deepEqual(decisionReceipt({ repo: "photocraft", number: 4127 }, { loading: false }, ref), { repo: "photocraft", number: 4127 });
  assert.deepEqual(decisionReceipt({ repo: "photocraft", number: null }, { loading: false }, ref), { repo: "photocraft", number: null });
  assert.equal(decisionReceipt({ repo: "other", number: 2 }, { loading: false }, ref), null);
  assert.equal(decisionReceipt({ repo: "photocraft", number: 4127 }, { loading: true }, ref), null);
  assert.equal(decisionReceipt({ repo: "photocraft", number: 4127 }, { loading: false, error: "x" }, ref), null);
  assert.equal(decisionReceipt(null, { loading: false }, ref), null);
});

test("F8: Last events print absolute times, with honest recent/old/future/invalid cases", () => {
  // The formatter groups LOCAL calendar days. Construct those days locally rather than assuming UTC.
  const local = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(year, month - 1, day, hour, minute).toISOString();
  const now = new Date(2026, 10, 16, 12).getTime();
  assert.equal(absoluteEventTime(local(2026, 11, 16, 3, 5), now), "Today 03:05");
  assert.equal(absoluteEventTime(local(2026, 11, 15, 14, 5), now), "Yesterday 14:05");
  assert.equal(absoluteEventTime(local(2026, 3, 3, 9, 7), now), "Mar 3 09:07");
  assert.equal(absoluteEventTime(local(2024, 3, 3, 9, 7), now), "Mar 3 2024 09:07");
  // A future event keeps its own local date and clock, not the current instant.
  assert.equal(absoluteEventTime(local(2026, 11, 17, 8, 30), now), "Nov 17 08:30");
  assert.notEqual(absoluteEventTime(local(2026, 11, 17, 8, 30), now), absoluteEventTime(local(2026, 11, 16, 12, 0), now));
  assert.equal(absoluteEventTime("not-a-date", now), "Time unknown");
  assert.equal(eventDateTime("2026-11-16T03:05:29.784Z"), "2026-11-16T03:05:29.784Z");
  assert.equal(eventDateTime("not-a-date"), undefined);
});

test("an answered decision gives execution facts separate from classification, from real fields", () => {
  const base = { id: "d", answer: "fix", exec: null, appliedAt: null } as const;
  assert.equal(answerFacts(null), null);
  assert.equal(answerFacts({ ...base, answer: null }), null);
  assert.deepEqual(answerFacts({ ...base, appliedAt: "2026-11-16T03:05:00Z" }), { state: "Answer applied", tone: "ok", reason: null, appliedAt: "2026-11-16T03:05:00Z", disputed: false });
  assert.deepEqual(answerFacts({ ...base, exec: { state: "done", reason: null } }), { state: "Answer applied", tone: "ok", reason: null, appliedAt: null, disputed: false });
  assert.deepEqual(answerFacts({ ...base, exec: { state: "failed", reason: "the push was refused" } }), { state: "Answer failed", tone: "bad", reason: "the push was refused", appliedAt: null, disputed: false });
  assert.deepEqual(answerFacts({ ...base, exec: { state: "pending", reason: null } }), { state: "Answer pending", tone: "warn", reason: null, appliedAt: null, disputed: false });
  assert.deepEqual(answerFacts({ ...base, exec: { state: "waiting-token", reason: "sign in again" } }), { state: "Answer waiting for sign-in", tone: "warn", reason: "sign in again", appliedAt: null, disputed: false });
  assert.deepEqual(answerFacts({ ...base, exec: { state: "waiting-permission", reason: null } }), { state: "Answer waiting for permission", tone: "warn", reason: null, appliedAt: null, disputed: false });
  // Answered with no execution record: recorded but not applied.
  assert.deepEqual(answerFacts(base), { state: "Answer recorded, not applied yet", tone: "neutral", reason: null, appliedAt: null, disputed: false });
});

test("F7: a list payload renders only for the reader it was fetched for", () => {
  const payload = { rows: [], total: 0 };
  // Same reader (including a filter change): the payload is usable, so previous rows stay visible.
  assert.deepEqual(scopedPayload({ scope: "ana:viewer", payload }, "ana:viewer"), payload);
  // A changed login or role discards the previous receipt, even for the same filter key.
  assert.equal(scopedPayload({ scope: "ana:operator", payload }, "ana:viewer"), undefined);
  assert.equal(scopedPayload({ scope: "ana:viewer", payload }, "bob:viewer"), undefined);
  assert.equal(scopedPayload(undefined, "ana:viewer"), undefined);
});

test("N2: a disputed, unapplied answer is held ahead of any exec write state", () => {
  const dispute = { by: "kiri-n", reason: "this touches the release notes", at: "2026-11-16T02:30:00Z" };
  const answered = { id: "d", answer: "merge", exec: null, appliedAt: null } as const;
  // No execution record + dispute: held, with the dispute's own reason.
  assert.deepEqual(answerFacts({ ...answered, dispute }), { state: "Answer held", tone: "warn", reason: "this touches the release notes", appliedAt: null, disputed: true });
  assert.equal(answerQueueText(answerFacts({ ...answered, dispute })!), "Held — disputed");
  // A pending write the pipeline is ignoring is still held, not pending.
  assert.deepEqual(answerFacts({ ...answered, exec: { state: "pending", reason: null }, dispute }), { state: "Answer held", tone: "warn", reason: "this touches the release notes", appliedAt: null, disputed: true });
  assert.equal(answerQueueText(answerFacts({ ...answered, exec: { state: "pending", reason: null }, dispute })!), "Held — disputed");
  // A redacted or empty dispute reason stays honest.
  assert.equal(answerFacts({ ...answered, dispute: { ...dispute, reason: "" } })?.reason, null);
  // Applied stays authoritative even with a later dispute.
  assert.equal(answerFacts({ ...answered, appliedAt: "2026-11-16T03:05:00Z", dispute })?.state, "Answer applied");
  // No answer is never turned into an answer just because dispute metadata exists.
  assert.equal(answerFacts({ ...answered, answer: null, dispute }), null);
  // A queued-card dispute is a different field and does not make the answer held.
  assert.equal(answerFacts(answered)?.state, "Answer recorded, not applied yet");
  assert.equal(answerQueueText(answerFacts(answered)!), "Answer recorded, not applied yet");
});

test("N1: the ignored-peek note is built once, naming the peek exactly once", () => {
  const note = conflictNote("designcraft#378");
  assert.equal(note, "The link's old peek (designcraft#378) was ignored; open wins.");
  assert.equal((note.match(/old peek/g) ?? []).length, 1);
  assert.equal((note.match(/designcraft#378/g) ?? []).length, 1);
  assert.equal((note.match(/was ignored/g) ?? []).length, 1);
});


test("phase rows retain upstream author, closing issues and native merge checks", () => {
  const checks: NonNullable<ItemStatusRow["checks"]> = {
    verdict: "take-fix", ci: "pending", mergeable: "clean", size: "M",
    verify: { state: "running", kind: "build", summary: "Tests are running", note: "Not a pass" }, prBuild: null,
  };
  const phase = factsFromStatusRow(statusRow({ author: "pixel-wrangler", closes: [5, 8], checks }));
  assert.equal(phase.author, "pixel-wrangler");
  assert.equal(phase.checks, checks); // The native checks, not a new lossy projection.
  assert.deepEqual(phase.closes, [5, 8]);
  assert.equal(phase.settled, undefined);
  assert.equal(phase.queue, null);
  assert.ok(detailFacts(phase).some((fact) => fact.label === "Author" && fact.value === "pixel-wrangler"));
  const absent = factsFromStatusRow(statusRow({ author: null, checks: null }));
  assert.equal(absent.author, undefined);
  assert.equal(absent.checks, null);
  assert.equal(absent.closes, undefined);
});

test("Items reader receipts reject prior project rows while the new project has no receipt", () => {
  const a = JSON.stringify(["anna", "operator", "deckcraft"]);
  const b = JSON.stringify(["anna", "operator", "photocraft"]);
  const old = { scope: a, payload: [listRow()] };
  assert.equal(scopedPayload(old, b), undefined);
  assert.equal(scopedPayload(undefined, b), undefined);
  const own = { scope: b, payload: [] };
  assert.deepEqual(scopedPayload(own, b), []); // A real empty receipt is different from loading.
});
