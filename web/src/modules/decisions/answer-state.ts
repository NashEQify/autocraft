// Private P6 draft/request session for the inline answer workflow. One module session (a pure factory is
// exported for tests). No storage, no shared store writes, no query, no history maps.
import type { Decision } from "../../api/types.ts";

export const NOTE_MAX = 500;
export const DRAFT_CAP = 512;
export const ARM_MS = 4000;

export interface DraftEntry {
  pick: string | null;
  note: string;
  /** Bumped on every explicit pick/note edit; used to clear only the draft an answer was sent from. */
  version: number;
}

export interface Owner {
  readerKey: string;
  readerEpoch: number;
  scopeKey: string;
  id: string;
}

export interface ReaderKey {
  login: string;
  role: string;
}

export const readerKeyOf = (reader: ReaderKey): string => JSON.stringify([reader.login, reader.role]);

export interface AcceptedResult {
  readerEpoch: number;
  readerKey: string;
  scopeKey: string;
  id: string;
  decision: Decision;
  ackSerial: number;
}

export interface RequestLock {
  nonce: number;
  /** The canonical parsed requested identity at dispatch, as a JSON tuple (collision-free). */
  requestedIdentity: string;
  /** The visible material signature at dispatch; a different current material invalidates the lock. */
  materialSignature: string;
  /** The question signature at dispatch: an observed M0→M1 while pending invalidates this completion. */
  questionSignature: string;
  /** The page read serial the dispatch was made against (reconciliation, never a freshness claim). */
  sourceReadSerial: number;
  /** The full live-User capability signature captured at dispatch (independently of the pending row). */
  capabilitySignature?: string;
  readerEpoch: number;
  readerKey: string;
  scopeKey: string;
  id: string;
  answerKey: string;
  draftVersion: number;
}

export interface SessionSnapshot {
  readerKey: string;
  readerEpoch: number;
  drafts: ReadonlyMap<string, DraftEntry>;
  armedKey: string | null;
  armedUntil: number;
  /** The ONLY active error/overlength, owned by {id, readerEpoch, scope}; never leaks to another row. */
  error: { id: string; readerEpoch: number; scopeKey: string; kind: "error" | "overlength"; message: string } | null;
  pending: boolean;
  accepted: AcceptedResult | null;
  /** Opaque watermark: a page is fresh for another binding answer only when serial > watermark. */
  watermark: number;

}

export interface Session {
  subscribe(fn: () => void): () => void;
  get(): SessionSnapshot;
  setReader(reader: ReaderKey): void;
  /** Every private mutation carries the owner it was rendered for; a stale owner is refused. */
  allows(owner: Owner): boolean;
  setPick(id: string, pick: string | null, reader: ReaderKey, owner?: Owner): boolean;
  setNote(id: string, note: string, reader: ReaderKey, owner?: Owner): "ok" | "overlength" | "cap" | "stale";
  clearDraft(id: string, owner?: Owner): void;
  /** The list scope the session currently belongs to; a change drops the full accepted slot. */
  setScope(scopeKey: string): void;
  /** Owner-scoped failure (never a global banner). */
  setError(owner: { id: string; readerEpoch: number; scopeKey: string }, kind: "error" | "overlength", message: string, held?: RequestLock): void;
  clearError(owner?: { id: string; readerEpoch: number; scopeKey: string }): void;
  /** ONE typed held-validity check consumed by ack, the error path and cleanup/refetch. */
  heldValid(held: RequestLock): boolean;
  /** An unknown transport outcome raises the opaque freshness fence: no blind retry until a real read. */
  raiseFence(markBoundary: () => number): number;
  arm(id: string, key: string, now: number, owner?: Owner, material?: string): void;
  disarm(): void;
  isArmed(id: string, key: string, now: number): boolean;
  /** The live material the session currently believes in (set by the getter at read time). */
  setMaterial(material: { requestedIdentity: string; materialSignature: string; sourceReadSerial: number }): void;
  /** The currently observed QUESTION signature of the request id (sticky invalidation lives in the lock). */
  setQuestion(question: string, id?: string): void;
  /** The id of the one in-flight request (undefined when idle). */
  pendingId(): string | undefined;
  /** The FULL live-User capability signature; a meaningful change while pending latches invalidation. */
  setCapability(signature: string): void;
  /** Synchronous lock before await; refuses a stale material, a second request, or a stale owner. */
  beginRequest(lock: Omit<RequestLock, "nonce">): RequestLock | null;
  finishRequest(nonce: number): void;
  /** Record one accepted result (owner-scoped) and raise the watermark; returns the ack serial. */
  ack(id: string, decision: Decision, scopeKey: string, markBoundary: () => number, lock: RequestLock): { ackSerial: number; stored: boolean };
  clearAccepted(): void;
  /** Remove the draft a successful answer was sent from, only when still the same version. */
  clearAnsweredDraft(id: string, expectedVersion: number, expectedEpoch: number, expectedScope: string, reader: ReaderKey): void;
  /** A reader change drops drafts/armed/error/accepted; the watermark stays a single scalar. */
  reader(): ReaderKey;
}

type Listener = () => void;

export function createSession(limit = DRAFT_CAP): Session {
  let reader: ReaderKey = { login: "", role: "" };
  let epoch = 0;
  let drafts = new Map<string, DraftEntry>();
  let armedKey: string | null = null;
  let armedUntil = 0;
  let armedId: string | null = null;
  let error: SessionSnapshot["error"] = null;
  let lock: RequestLock | null = null;
  let nonceSeq = 0;
  let accepted: AcceptedResult | null = null;
  let watermark = 0;
  let scopeKey = "";
  let currentMaterial: { requestedIdentity: string; materialSignature: string; sourceReadSerial: number } | null = null;
  let currentQuestion: string | null = null;
  /** ONE private per-nonce IRREVERSIBLE invalidation: latched at the first observed change, never reset. */
  let invalidation: { nonce: number; reason: "question" | "capability" | "scope" } | null = null;
  const listeners = new Set<Listener>();

  let snap: SessionSnapshot = {
    readerKey: readerKeyOf(reader), readerEpoch: epoch, drafts, armedKey, armedUntil, error, pending: false,
    accepted, watermark,
  };
  const sync = () => {
    snap = {
      readerKey: readerKeyOf(reader), readerEpoch: epoch, drafts, armedKey, armedUntil,
      pending: lock !== null, accepted, watermark, error,
    };
    listeners.forEach((fn) => fn());
  };

  const matchesReader = (r: ReaderKey) => readerKeyOf(r) === readerKeyOf(reader);
  const allows = (owner?: Owner) => !owner || (matchesReader({ login: JSON.parse(owner.readerKey)[0], role: JSON.parse(owner.readerKey)[1] }) && owner.readerEpoch === epoch && (owner.scopeKey === "" || owner.scopeKey === scopeKey));

  return {
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    get: () => snap,
    reader: () => reader,
    setReader(next) {
      if (readerKeyOf(next) === readerKeyOf(reader)) return;
      reader = next;
      epoch += 1;
      drafts = new Map();                 // a genuine reader change DROPS prior drafts
      armedKey = null; armedId = null; armedUntil = 0;
      accepted = null;                    // the accepted slot belongs to its reader/scope
      error = null;
      sync();
    },
    allows,
    setMaterial(material) { currentMaterial = material; },
    setQuestion(question, id) {
      // Only the in-flight request's own id may (re)observe the question; a selection change to B must not.
      if (lock && id !== undefined && id !== lock.id) return;
      if (lock && id === undefined) return;          // no id while pending: never overwrite A's observation
      if (currentQuestion !== null && question !== currentQuestion) {
        // LATCH: the first observed change invalidates this nonce for good (M0→M1→M0 cannot re-validate).
        if (!invalidation) invalidation = { nonce: lock?.nonce ?? 0, reason: "question" };
      }
      currentQuestion = question;
    },
    pendingId() { return lock?.id; },
    setCapability(signature) {
      if (!lock) return;
      if (lock.capabilitySignature !== undefined && signature !== lock.capabilitySignature && !invalidation) {
        invalidation = { nonce: lock.nonce, reason: "capability" };
      }
    },
    setScope(next) {
      if (next === scopeKey) return;                     // an unchanged scope never mutates
      scopeKey = next; accepted = null; error = null; armedKey = null; armedId = null;
      // R6: an ACTUAL scope change while a lock is active latches the SAME per-nonce invalidation
      // (S1→S2→S1 cannot restore). Only a successful new lock resets it.
      if (lock && !invalidation) invalidation = { nonce: lock.nonce, reason: "scope" };
      sync();
    },
    setPick(id, pick, r, owner) {
      if (!matchesReader(r) || !allows(owner)) return false;
      const entry = drafts.get(id) ?? { pick: null, note: "", version: 0 };
      if (pick === null && entry.note === "") { drafts.delete(id); }
      else {
        if (pick !== null && !drafts.has(id) && drafts.size >= limit) { error = { id, readerEpoch: epoch, scopeKey: "", kind: "error", message: "Draft limit reached." }; sync(); return false; }
        drafts.set(id, { ...entry, pick, version: entry.version + 1 });
      }
      armedKey = null; armedId = null;
      if (error && error.id !== id) error = null;
      sync();
      return true;
    },
    setNote(id, note, r, owner) {
      if (!matchesReader(r)) return "cap";
      if (!allows(owner)) return "stale";
      if (note.length > NOTE_MAX) { error = { id, readerEpoch: epoch, scopeKey: "", kind: "overlength", message: `A note is limited to ${NOTE_MAX} characters; the previous draft is kept.` }; sync(); return "overlength"; }
      const entry = drafts.get(id) ?? { pick: null, note: "", version: 0 };
      if (note === "" && entry.pick === null) drafts.delete(id);
      else {
        if (note !== "" && !drafts.has(id) && drafts.size >= limit) { error = { id, readerEpoch: epoch, scopeKey: "", kind: "error", message: "Draft limit reached." }; sync(); return "cap"; }
        drafts.set(id, { ...entry, note, version: entry.version + 1 });
      }
      if (error && error.id !== id) error = null;
      sync();
      return "ok";
    },
    clearDraft(id, owner) { if (!allows(owner)) return; drafts.delete(id); error = null; sync(); },
    setError(owner, kind, message, held) {
      if (owner.readerEpoch !== epoch) return;                   // an old epoch cannot create personal state
      if (scopeKey !== "" && owner.scopeKey !== "" && owner.scopeKey !== scopeKey) return;   // an old scope cannot either
      if (held && !this.heldValid?.(held)) return;
      error = { ...owner, kind, message }; sync();
    },
    clearError(owner) {
      // An old/new-owner clear must never remove the CURRENT owner's error.
      if (owner && error && (owner.readerEpoch !== error.readerEpoch || (owner.scopeKey !== "" && error.scopeKey !== "" && owner.scopeKey !== error.scopeKey))) return;
      error = null; sync();
    },
    raiseFence(markBoundary) { watermark = markBoundary(); sync(); return watermark; },
    arm(id, key, now, owner, material) {
      if (owner && !allows(owner)) return;                       // a stale owner cannot arm
      if (material !== undefined && currentMaterial && material !== currentMaterial.materialSignature) return; // stale material cannot re-arm
      armedId = id; armedKey = key; armedUntil = now + ARM_MS; sync();
    },
    disarm() { armedKey = null; armedId = null; armedUntil = 0; sync(); },
    isArmed(id, key, now) { return armedId === id && armedKey === key && now <= armedUntil; },
    heldValid(held) {
      if (!held) return false;
      // R6: validity requires the ACTIVE lock with the matching nonce — a completed or superseded
      // token (old nonce on a new lock) is never valid.
      // R7: validity requires a LIVE lock with the matching nonce (after any finish there is no lock, so
      // every old token — including the latest finished one — is false).
      if (!lock || held.nonce !== lock.nonce) return false;
      if (held.readerEpoch !== epoch || held.readerKey !== readerKeyOf(reader)) return false;
      if (scopeKey !== "" && held.scopeKey !== scopeKey) return false;
      if (invalidation && invalidation.nonce === held.nonce) return false;   // latched for this nonce
      return true;
    },
    beginRequest(next) {
      if (lock) return null;              // synchronous duplicate guard, survives remount
      // The typed serial is consumed: a non-positive or stale (<= watermark) read cannot take a lock.
      if (!Number.isFinite(next.sourceReadSerial) || next.sourceReadSerial <= 0 || next.sourceReadSerial <= watermark) return null;
      // The typed token is consumed: a stale material/owner at the lock boundary is refused.
      if (next.readerEpoch !== epoch || next.readerKey !== readerKeyOf(reader)) return null;
      if (scopeKey !== "" && next.scopeKey !== scopeKey) return null;
      if (currentMaterial && (next.materialSignature !== currentMaterial.materialSignature || next.requestedIdentity !== currentMaterial.requestedIdentity)) return null;
      if (currentQuestion !== null && next.questionSignature !== currentQuestion) return null;
      nonceSeq += 1;
      lock = { ...next, nonce: nonceSeq };
      invalidation = null;                // initialized ONLY at a successful new lock
      if (currentQuestion !== null && next.questionSignature !== currentQuestion) invalidation = { nonce: nonceSeq, reason: "question" };
      sync();
      return lock;
    },
    finishRequest(nonce) { if (lock && lock.nonce === nonce) { lock = null; sync(); } },
    ack(id, decision, acknowledgedScope, markBoundary, held) {
      if (scopeKey === "") scopeKey = acknowledgedScope;   // adopt the surface scope at the first acknowledgement
      const ackSerial = markBoundary();
      watermark = ackSerial;              // the opaque fence always advances
      // A stale epoch/scope completion stores nothing personal; the session itself rejects it.
      // A/B: an observed question change while pending invalidates this completion; an answer-only
      // transition (same question signature) is a legitimate completion and is stored.
      // The ONE typed held-validity check (latched invalidation + owner/epoch/scope), never a
      // selected-question equality test.
      // ack consumes the SAME shared predicate (never duplicated logic), while the fence always advances.
      const valid = this.heldValid?.(held) && !invalidation
        && held.readerEpoch === epoch && held.readerKey === readerKeyOf(reader)
        && (scopeKey === "" || acknowledgedScope === scopeKey);
      if (!valid) {
        sync();
        return { ackSerial, stored: false };   // rejected: nothing personal was stored
      }
      accepted = { readerEpoch: epoch, readerKey: readerKeyOf(reader), scopeKey: acknowledgedScope, id, decision, ackSerial };
      sync();
      return { ackSerial, stored: true };    // accepted: the matching receipt was stored
    },
    clearAccepted() { accepted = null; sync(); },
    clearAnsweredDraft(id, expectedVersion, expectedEpoch, expectedScope, r) {
      if (!matchesReader(r)) return;
      // A completion from another reader epoch or scope must never clear a draft retained in this one (R2).
      if (expectedEpoch !== epoch) return;
      if (scopeKey !== "" && expectedScope !== scopeKey) return;
      const entry = drafts.get(id);
      if (!entry || entry.version !== expectedVersion) return;
      drafts.delete(id);
      sync();
    },
  };
}

/** The module session the private UI subscribes to. */
export const answerSession = createSession();

export const useAnswerSession = () => answerSession;

/** The page containing this id among the current scope's receipts (bounded), or its read serial. */
export function pageSerialFor(receipts: readonly { page: { decisions: { id: string }[] }; readSerial?: number }[] | undefined, id: string): number {
  if (!receipts) return 0;
  for (const receipt of receipts) if (receipt.page.decisions.some((d) => d.id === id)) return receipt.readSerial ?? 0;
  return 0;
}

/** The QUESTION signature: everything that makes re-asking meaningful, EXCLUDING the answer's own fields. */
export function questionSignature(d: Decision, user: { login: string; role: string; writeRepos?: string[]; maintainerWrites?: boolean }, overrides: Record<string, string>): string {
  return JSON.stringify([
    d.id, d.canSettle, !!d.preparing, !!d.queued, !!d.settling,
    d.options.map((o) => [o.key, o.label, o.writes ?? null]),
    (d.optionTexts ?? []).map((t) => [t.option, t.hash, t.texts.map((x) => [x.number, x.step, x.text])]),
    [user.login, user.role, user.writeRepos ?? [], !!user.maintainerWrites],
    Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)),
    ((d as unknown as { exceptions?: unknown[] }).exceptions ?? []).length,
  ]);
}

/** Collision-free material signature: a change invalidates an arm; identical data replacement does not. */
export function materialSignature(d: Decision, user: { login: string; role: string; writeRepos?: string[]; maintainerWrites?: boolean }, overrides: Record<string, string>): string {
  return JSON.stringify([
    d.id, d.answer, d.canSettle, !!d.preparing, !!d.queued, !!d.settling,
    d.options.map((o) => [o.key, o.label, o.writes ?? null]),
    (d.optionTexts ?? []).map((t) => [t.option, t.hash, t.texts.map((x) => [x.number, x.step, x.text])]),
    [user.login, user.role, user.writeRepos ?? [], !!user.maintainerWrites],
    Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
