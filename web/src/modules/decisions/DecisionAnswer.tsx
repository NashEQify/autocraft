// The queue is a read-only decision desk. Answering stays in the native item form so prepared
// cores, extra actions, public text, confirmation and the existing Undo path cannot be bypassed.
import type { Decision, User } from "../../api/types.ts";
import { Button } from "../../ui/atoms/Button.tsx";
import { canActOn } from "./access.ts";
import type { ReaderKey } from "./answer-state.ts";

export interface AnswerFacts {
  reader: ReaderKey;
  readerEpoch: number;
  user: User;
  scopeKey: string;
  requested: "none" | "requested" | "unavailable";
  selectedId: string | undefined;
  row: Decision | undefined;
  loading: boolean;
  error: string | undefined;
  receipts: readonly { page: { decisions: { id: string }[] }; readSerial?: number }[] | undefined;
  overrides: Record<string, string>;
  onAccepted: () => void;
  /** The named live-facts getter (REPAIR2): every handler re-reads it before mutating or acknowledging. */
  readCurrentFacts: () => {
    owner: { readerKey: string; readerEpoch: number; scopeKey: string; requestedIdentity: unknown; selectedId: string | undefined };
    user: User; row: Decision | undefined; loading: boolean; error: string | undefined;
    sourceReadSerial: number; overrides: Record<string, string>; coherent: boolean;
    materialSignature: string; questionSignature: string; requestedIdentity: string; watermark: number; refetch: () => void;
  /** The parsed identity rendered into this form (bound into the edit guard). */
  requestedIdentityAtRender: string;
  };
  /** The ONE shared authority predicate (defined in the frame); every mutation/completion calls it. */
  authorize: (view: { readerKey: string; readerEpoch: number; scopeKey: string; id: string; materialSignature?: string; requestedIdentity?: string }, intent?: { answerKey?: string }) =>
    { ok: boolean; live: ReturnType<AnswerFacts["readCurrentFacts"]> };
  /** The frame-level key handler asks the controller to select by index (1–M from the focused title). */
  registerChoose?: (choose: ((index: number) => void) | null) => void;
  registerFocusNote?: (focus: (() => void) | null) => void;
}

export function DecisionAnswer({ facts, onReview }: { facts: AnswerFacts; onReview: () => void }) {
  const { row, user } = facts;
  if (!row || row.answer) return null;
  const canReview = canActOn(user, [row]);
  const settling = !!row.preparing || !!row.queued || !!row.settling;
  const unavailable = facts.loading || !!facts.error || settling;
  const review = () => {
    // This only opens the existing form. A stale queue must not claim or open a different reader's item.
    const live = facts.readCurrentFacts();
    if (!live.coherent || live.row?.id !== row.id || live.user.login !== user.login || live.user.role !== user.role) return;
    onReview();
  };
  return <section aria-label="Answer" className="mt-6 rounded-md border border-line-strong bg-raised px-4 py-3">
    <h3 className="text-sm font-semibold">Answer</h3>
    <p className="mt-1 text-sm text-ink/65">Review the complete prepared choices, extra actions and public text in the item’s answer form.</p>
    {canReview
      ? <Button variant="primary" className="mt-3 max-[860px]:min-h-11" disabled={unavailable} onClick={review}>Review and answer</Button>
      : <p className="mt-2 text-sm text-ink/55">Only an operator, or a maintainer with write access on every repo involved, can answer.</p>}
    {settling && <p className="mt-2 text-sm text-ink/55">This decision is being prepared or settled; answering is not available yet.</p>}
  </section>;
}
