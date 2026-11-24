// The lines every surface shows for a started item: its steps, the state line, the open recommendation, who started, approved,
// answered or stopped it, its place in line, and the one-line confirmation and reply to each command. GitHub, Discord, the
// agent and the dashboard all build their text here, so the same words appear everywhere. All text goes through t().
import { t, tk } from "../i18n/index.ts";
import type { Ambiguity, Refusal, Resolved, Run } from "./resolve.ts";
import type { Blocker, Entry, ItemWorkflow, Recommendation } from "./types.ts";
import { ENTRY_LABEL, weightWord } from "./vocab.ts";

export type StepName = "implement" | "review" | "fix-up" | "review again" | "update from main" | "fix CI and conflicts" | "batch" | "merge" | "recommend";
export type StepState = "done" | "running" | "waiting" | "stopped" | "next";
export type Step = {
  name: StepName;
  /** What the step does or did, in a few words: "1 and 2", "no findings". */
  note?: string;
  state: StepState;
};

/** Formats a stored ISO time; the default is `hh:mm UTC`, the dashboard passes the viewer's local time. */
export type Clock = (iso: string) => string;
export const utcClock: Clock = (iso) => (iso.length >= 16 ? `${iso.slice(11, 16)} UTC` : iso);

const ENTRY_STEPS: Record<Entry, StepName[]> = {
  review: ["review"],
  fixup: ["review", "fix-up", "review again"],
  implement: ["implement", "review", "fix-up", "review again"],
  merge: ["update from main", "fix CI and conflicts", "batch", "merge"],
};

/** The steps an entry runs, ending in a merge when approved and in one recommendation when not; the merge queue implies approval. */
export const stepsFor = (entry: Entry, approved: boolean): StepName[] =>
  entry === "merge" ? ENTRY_STEPS.merge : [...ENTRY_STEPS[entry], approved ? "merge" : "recommend"];

/** Steps with states: those before `at` done, `at` in state `now`, the rest next. */
export const stepsAt = (names: StepName[], at: number, now: StepState = "running", notes: Record<number, string> = {}): Step[] =>
  names.map((name, i) => ({ name, ...(notes[i] ? { note: notes[i] } : {}), state: i < at ? "done" : i === at ? now : "next" }));

const STEP_LABEL: Record<StepName, string> = {
  implement: tk("implement"),
  review: tk("review"),
  "fix-up": tk("fix-up"),
  "review again": tk("review again"),
  "update from main": tk("update from main"),
  "fix CI and conflicts": tk("fix CI and conflicts"),
  batch: tk("batch"),
  merge: tk("merge"),
  recommend: tk("come back with a recommendation"),
};
const STATE_LABEL: Record<StepState, string> = { done: tk("done"), running: tk("running"), waiting: tk("waiting"), stopped: tk("stopped"), next: tk("next") };

export const stepLabel = (s: Step): string => (s.note ? t("{step}: {note}", { step: t(STEP_LABEL[s.name]), note: s.note }) : t(STEP_LABEL[s.name]));

/** One line per step: `2. fix-up: 1 and 2 (running)`. */
export const stepLines = (steps: readonly Step[]): string[] =>
  steps.map((s, i) => t("{n}. {step} ({state})", { n: i + 1, step: stepLabel(s), state: t(STATE_LABEL[s.state]) }));

/** The step that runs, waits or stopped now. */
export const currentStep = (steps: readonly Step[]): Step | undefined => steps.find((s) => s.state === "running" || s.state === "waiting" || s.state === "stopped");

const BLOCKER_LABEL: Record<Blocker, string> = {
  "major-finding": tk("a major finding in the review"),
  "author-commits": tk("new commits from the author"),
  "failed-twice": tk("a step failed twice"),
  "beyond-agreed": tk("work beyond what was agreed"),
  "large-fix": tk("a large fix"),
  "outside-purpose": tk("a change outside the pull request's purpose"),
};
export const blockerLabel = (b: Blocker): string => t(BLOCKER_LABEL[b]);

/** "1", "1 and 2", "1, 2 and 3". */
export function listText(ns: readonly (number | string)[]): string {
  if (ns.length < 2) return String(ns[0] ?? "");
  return t("{list} and {last}", { list: ns.slice(0, -1).join(", "), last: String(ns[ns.length - 1]) });
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Where the item stands, in one line. */
export function stateLine(wf: ItemWorkflow, current?: Step, clock: Clock = utcClock): string {
  switch (wf.state) {
    case "running": return current ? t("Running: {step}", { step: stepLabel(current) }) : t("Running");
    case "waiting": return current ? t("Waiting: {step}", { step: stepLabel(current) }) : t("Waiting");
    case "blocked": return wf.blocker ? t("Stopped at a blocker: {blocker}", { blocker: blockerLabel(wf.blocker) }) : t("Stopped at a blocker");
    case "recommending": return t("Waiting for an answer");
    case "done": return t("Done");
    case "stopped": return wf.stoppedBy ? t("Stopped by {login}, {time}", { login: wf.stoppedBy, time: clock(wf.stoppedAt ?? "") }) : t("Stopped");
    case "closed": return t("Closed");
    case "backlog": return t("In the backlog");
  }
}

/** The open recommendation and how to answer it, or null when none is open. */
export const recommendationLine = (rec: Recommendation | null): string | null =>
  rec ? t("Recommendation: {text} Reply yes, or write what to do instead.", { text: rec.text }) : null;

/** Who started, approved, answered and stopped the item; `answered` is the latest answer, from the item's events. */
export function attributionLines(wf: ItemWorkflow, answered?: { by: string; at: string } | null, clock: Clock = utcClock): string[] {
  const out = [t("{entry}, started by {login}, {time}", { entry: t(ENTRY_LABEL[wf.entry]), login: wf.startedBy, time: clock(wf.startedAt) })];
  if (wf.approvedBy) out.push(t("Approved for merge by {login}, {time}", { login: wf.approvedBy, time: clock(wf.approvedAt ?? "") }));
  if (answered) out.push(t("Answered by {login}, {time}", { login: answered.by, time: clock(answered.at) }));
  if (wf.stoppedBy) out.push(t("Stopped by {login}, {time}", { login: wf.stoppedBy, time: clock(wf.stoppedAt ?? "") }));
  return out;
}

/** The item's place in a queue, counted from 1. */
export const queueLine = (position: number): string => t("#{n} in line", { n: position });

/** The weight as items show it; the normal weight shows nothing. */
export const weightLabel = (w: number | null | undefined): string | null => {
  const word = weightWord(w);
  return word === null ? null : word.startsWith("weight ") ? t("weight {n}", { n: w! }) : t(word);
};

/** "(approved by mira, 09:31 UTC)" */
function byText(how: Run["how"], login: string, time: string): string {
  const p = { login, time };
  switch (how) {
    case "started": return t("(started by {login}, {time})", p);
    case "approved": return t("(approved by {login}, {time})", p);
    case "answered": return t("(answered by {login}, {time})", p);
    case "stopped": return t("(stopped by {login}, {time})", p);
    case "set": return t("(set by {login}, {time})", p);
    default: return t("(by {login}, {time})", p);
  }
}

/**
 * The one-line confirmation of an accepted command, the same on every surface:
 * "Fixing 1 and 2, then merging when CI is green (approved by mira, 09:31 UTC). Reply stop to halt."
 */
export function confirmLine(r: Run, by: string, at: string, clock: Clock = utcClock): string {
  const who = byText(r.how, by, clock(at));
  if (r.end === "stop") return t("Stopped {by}. Nothing more runs.", { by: who });
  if (r.end === "close") return t("Closing {by}.", { by: who });
  if (r.end === "backlog") return t("In the backlog: open, no work planned {by}. Any command starts it again.", { by: who });
  if (r.autorepin !== null) {
    return r.autorepin.toLowerCase() === "off"
      ? t("No Cargo repin after this merges {by}.", { by: who })
      : t("Repinning the Cargo dependencies of {target} when this merges {by}.", { target: r.autorepin, by: who });
  }
  const did: string[] = [];
  if (r.drop.length) did.push(t("dropping {parts}", { parts: listText(r.drop) }));
  if (r.start === "review") did.push(t("reviewing"));
  else if (r.start === "fixup") did.push(t("reviewing, fixing what the review finds, reviewing again"));
  else if (r.start === "implement") did.push(t("implementing, reviewing, fixing what the review finds, reviewing again"));
  else if (r.again === "review") did.push(t("reviewing again"));
  else if (r.again === "fixup") did.push(r.fix.length ? t("fixing {parts}", { parts: listText(r.fix) }) : t("fixing what the review found"));
  const weight = weightLabel(r.weight);
  if (!did.length && !r.start && !r.approve && !r.answers) {
    // A weight alone.
    const shown = r.weight === null ? null : weightWord(r.weight)?.startsWith("weight ") ? String(r.weight) : weight;
    return t("Weight {weight} {by}.", { weight: shown ?? t("normal"), by: who });
  }
  const end = r.start === "merge"
    ? t("updating from main, then merging in the next batch when CI is green")
    : r.merges
      ? did.length || r.answers ? t("merging when CI is green") : t("merging when the steps are done and CI is green")
      : t("coming back with a recommendation");
  const what = cap(did.length ? t("{done}, then {end}", { done: did.join(", "), end }) : end);
  return t("{what}{weight} {by}. Reply stop to halt.", { what, weight: weight ? `, ${weight}` : "", by: who });
}

/** The reply when nothing ran: what was understood, and why it waits. */
export function replyLine(r: Exclude<Resolved, { kind: "run" }>, clock: Clock = utcClock): string {
  return r.kind === "ambiguous" ? ambiguityText(r.understood, r.ambiguity) : refusalText(r.refusal, clock);
}

function ambiguityText(understood: string, a: Ambiguity): string {
  switch (a.why) {
    case "unreadable":
      if (understood && a.rest) return t("I understood “{understood}” but not “{rest}”. Nothing runs until the instruction is clear.", { understood, rest: a.rest });
      if (a.rest) return t("I couldn't read “{rest}” as a command. Nothing runs until the instruction is clear.", { rest: a.rest });
      if (understood) return t("I understood “{understood}” but not which items. Nothing runs until the instruction is clear.", { understood });
      return t("There was no command. Nothing runs.");
    case "nothing-to-answer": return t("There is no open recommendation to say yes to. Nothing runs.");
    case "no-plan": return t("“{understood}” names parts of a plan, but this item has no plan yet. Nothing runs.", { understood });
    case "no-such-part": return t("There is no part {n}. Nothing runs until you name one, by number or words.", { n: a.part });
    case "part-matches-none": return t("“{words}” matches no part. Nothing runs until you name one, by number or words.", { words: a.words });
    case "part-matches-several": return t("“{words}” matches parts {parts}. Nothing runs until you name one, by number or words.", { words: a.words, parts: listText(a.parts) });
    case "weight-unstarted": return t("Nothing runs on this item yet. Give the weight with a command, such as “review, {weight}”.", { weight: weightLabel(a.weight) ?? "urgent" });
    case "conflict": return t("“{words}” can't run together. Nothing runs.", { words: a.words.join(", ") });
    case "merge-skips-fixes": return t("“merge” could mean merging without fixing {parts}, or the recommendation. Nothing runs: reply yes for the recommendation, or “drop {parts}, merge” to merge without them.", { parts: listText(a.parts) });
  }
}

function refusalText(r: Refusal, clock: Clock): string {
  switch (r.why) {
    case "implement-not-issue": return t("implement is for issues.");
    case "not-issue-step": return t("{word} is for pull requests. Use implement for an issue.", { word: r.word });
    case "issue-merge-queue": return t("An issue can't go in the merge queue. Use implement and merge.");
    case "autorepin-not-pr": return t("autorepin is for pull requests.");
    case "nothing-running": return t("Nothing is running on this item.");
    case "already-started": return t("Already started: {entry}, by {login}, {time}.", { entry: t(ENTRY_LABEL[r.entry]), login: r.by, time: clock(r.at) });
    case "already-approved": return t("Already approved for merge by {login}, {time}.", { login: r.by, time: clock(r.at) });
  }
}
