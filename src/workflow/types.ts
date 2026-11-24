// Shared shapes of the maintainer workflow: one live row per started item records where it entered,
// whether it is approved for merge, its weight, its numbered parts, any blocker and the open recommendation. The parser,
// the store, the command core and the status builder all use these; nothing here touches the database.

export type ItemKind = "pr" | "issue";
export type Entry = "review" | "fixup" | "implement" | "merge";
export type WorkflowState = "running" | "waiting" | "blocked" | "recommending" | "done" | "stopped" | "closed" | "backlog";
export type Surface = "github" | "discord" | "agent" | "dashboard" | "cli";

/** The six blockers that bring an approved item back to a person. */
export type Blocker = "major-finding" | "author-commits" | "failed-twice" | "beyond-agreed" | "large-fix" | "outside-purpose";

export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 10;
export const WEIGHT_NORMAL = 5;
export const WEIGHT_WORDS = { urgent: 10, high: 8, low: 2 } as const;
export type WeightWord = keyof typeof WEIGHT_WORDS;

/** A finding or a separate change, numbered from 1 in the order the review listed it. */
export type PlanPart = {
  n: number;
  title: string;
  source: "review" | "change" | "implement";
  file?: string;
  major?: boolean;
  state: "planned" | "dropped" | "fixed";
};

export type Recommendation = {
  /** One plain sentence; either written by the model step that produced it or built from a rule key. */
  text: string;
  /** What a yes runs. */
  parts: { fix: number[]; drop: number[] };
  merges: boolean;
};

export type ItemWorkflow = {
  id: number;
  repo: string;
  number: number;
  kind: ItemKind;
  entry: Entry;
  weight: number;
  state: WorkflowState;
  startedBy: string;
  startedAt: string;
  startedVia: Surface;
  baseHead: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedVia: Surface | null;
  stoppedBy: string | null;
  stoppedAt: string | null;
  blocker: Blocker | null;
  blockerParams: Record<string, unknown> | null;
  rec: Recommendation | null;
  recAt: string | null;
  recHead: string | null;
  plan: PlanPart[];
  legacyPreapprovalId: number | null;
  updatedAt: string;
};

/** An item as written in a command: `repo` is `owner/name` or a bare name, resolved against the tracked repos by the caller. */
export type ItemRef = { repo: string; number: number };

/** One command word with its arguments, as the parser understood it. */
export type CommandPart =
  | { word: "review" | "fix-up" | "implement" | "merge" | "backlog" | "close" | "stop" | "autorepin"; args?: string }
  | { word: "drop" | "fix"; part: number | string }
  | { word: "weight"; weight: number };

/**
 * `items` is the list after a colon; empty means the item the text was written on. `understood` is the canonical text of what was
 * read (`fix-up, merge, urgent`) and `rest` the words that were not, as written.
 */
export type Parsed =
  | { kind: "yes"; items?: ItemRef[]; weight?: number }
  | { kind: "commands"; items: ItemRef[]; parts: CommandPart[] }
  | { kind: "ambiguous"; understood: string; rest: string };

/** A registered control: a state change a panel needs that is not one of the command words. */
export type Control = "hold-merge" | "release-merge" | "resume-breaker" | "release-outside" | "set-automatic" | "runner-settings";

export type WorkflowEventKind = "started" | "approved" | "answered" | "ambiguous" | "blocked" | "stopped" | "weighted" | "closed" | "backlog" | "set";
