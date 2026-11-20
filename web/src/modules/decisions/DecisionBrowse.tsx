// The Decisions surface of Needs you: the queue card, the selected-decision frame, ONE surface keyboard
// controller and the native preview. One list observer; the frame is list-backed and passive. The surface is the
// single bookmark owner (capture producer behind the child's handle, one restore per READY) and owns the FOCUS
// clock, which is independent of bookmark captures.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { ViewProps } from "../../registry/types";
import { useMedia } from "../../shell/useMedia";
import { useUser } from "../../shell/UserContext";
import type { Decision } from "../../api/types";
import { BrowseLayout } from "../../ui/organisms/BrowseLayout";
import { DecisionDetail } from "./DecisionDetail";
import { DecisionAnswer } from "./DecisionAnswer";
import { getScope, projectOf, usePageProject } from "../../api/scope";
import { canActOn } from "./access.ts";
import { reviewDecision } from "./review.ts";
import { useApi } from "../../api/client.ts";
import { answerSession, materialSignature, questionSignature, readerKeyOf } from "./answer-state";
import { DecisionPreview } from "./DecisionPreview";
import { InboxList, type ControlledQueue } from "./InboxList";
import { NeedsControls } from "./Toolbar";
import { localActions, useDecisionFilter, useDecisionList, useLocal, useUndo } from "./state";
import { MultiAnswer } from "./MultiAnswer";
import {
  acceptCapture, captureSnapshot, clearSnapshotFor, commitChangesId, focusAllows, liveDecisionId, liveScopeOf, readDecisionParam, resolveActive, scopeOf,
  snapshotFor, type FocusIntent, type QueueHandle, type Snapshot,
} from "./selection";
import { useNeedsQueueKeys } from "./useNeedsQueueKeys";

const supportsCqh = () => typeof CSS !== "undefined" && !!CSS.supports && CSS.supports("container-type", "size") && CSS.supports("height", "100cqh");

type FocusTarget = { kind: "row"; id: string; reveal: boolean } | { kind: "title"; whenHidden: boolean } | { kind: "nativeView" };

export function DecisionBrowse({ phone, ...props }: ViewProps & { phone?: boolean }) {
  const user = useUser();
  const api = useApi();
  const navigate = useNavigate();
  const undo = useUndo();
  const { peek, setPeek, decision, setDecision, clearPeek, update, filter, search } = useDecisionFilter();
  const query = useDecisionList();
  const loc = useLocal();
  const rows = query.data?.decisions ?? [];
  const requested = decision;
  const project = usePageProject();
  const scopeKey = scopeOf({ login: user.login, role: user.role, search, project });
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  // The CURRENT reader (login/role) as a live ref: intent arming and execution must both read it, so a genuine
  // reader change never leaves a mount-time reader in a pending intent.
  const readerRef = useRef({ login: user.login, role: user.role });
  // FULL live facts for the answer getter: the user object, receipt, cursor and the currently rendered scope.
  const fullUserRef = useRef(user); fullUserRef.current = user;
  const receiptRef = useRef({ rows, receipts: query.readReceipts, loading: query.loading, error: query.error?.message as string | undefined });
  receiptRef.current = { rows, receipts: query.readReceipts, loading: query.loading, error: query.error?.message as string | undefined };
  const cursorRef = useRef<string | undefined>(undefined);
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  // A reader or scope change drops the accepted slot (it belongs to its owner only).

  readerRef.current = { login: user.login, role: user.role };
  // Mutation-time facts: the LIVE canonical scope (projected with the CURRENT reader) and primary id, plus receipt.
  const liveFacts = () => {
    const reader = readerRef.current;
    return {
      scope: liveScopeOf(window.location.search, reader.login, reader.role, projectOf(window.location.pathname, window.location.search, getScope())),
      id: liveDecisionId(window.location.search),
    };
  };
  const receipt = useRef({ rows, loading: query.loading });
  receipt.current = { rows, loading: query.loading };

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const activeId = resolveActive(requested, rows, cursor);
  cursorRef.current = cursor;
  // Resolve the readable row (including an owned accepted answer) before choosing the compact layout.
  const explicitRow = requested.kind === "requested" ? rows.find((r) => r.id === requested.id) : undefined;
  const receiptsFor = query.readReceipts;
  const pageSerialOf = (id: string) => {
    if (!receiptsFor) return 0;
    for (const receipt of receiptsFor) if (receipt.page.decisions.some((d) => d.id === id)) return receipt.readSerial ?? 0;
    return 0;
  };
  // Precedence (contract §5/§8.D): the accepted API truth wins only when its page is not freshly re-read.
  // R4: ONE accepted authority, the private session's (survives phone remount; no component-local copy).
  useEffect(() => { answerSession.setScope(scopeKey); }, [scopeKey]);
  // Reader/session ownership belongs to the mounted FRAME: a genuine reader change drops drafts even when the
  // conditional answer form is unmounted (the phone-closed detail).
  useEffect(() => { answerSession.setReader({ login: user.login, role: user.role }); }, [user.login, user.role]);
  // Minimal subscription: only the accepted pointer (not every Note keystroke) re-renders the queue.
  // The stored accepted object already carries readerEpoch; return it unchanged so the selector snapshot is cached.
  const sessionAccepted = useSyncExternalStore(answerSession.subscribe, () => answerSession.get().accepted);
  // No lossy duplicate projection: the predicate reads the ONE typed session object with its own readerEpoch.
  const acceptedHere = sessionAccepted && requested.kind === "requested" && sessionAccepted.id === requested.id
    && sessionAccepted.readerKey === readerKeyOf(readerRef.current)
    && sessionAccepted.readerEpoch === answerSession.get().readerEpoch
    && sessionAccepted.scopeKey === scopeKey ? sessionAccepted : null;
  const acceptedWins = !!acceptedHere && (!explicitRow || (!explicitRow.answer && pageSerialOf(explicitRow.id) <= acceptedHere.ackSerial));
  useEffect(() => {
    // A genuine fresh row (answered, or read after the ack) retires the receipt.
    if (!acceptedHere) return;
    if (explicitRow && (explicitRow.answer || pageSerialOf(explicitRow.id) > acceptedHere.ackSerial)) answerSession.clearAccepted();
  }, [acceptedHere, explicitRow?.id, explicitRow?.answer, receiptsFor]);
  const selected = acceptedWins ? acceptedHere!.decision
    : requested.kind === "requested" ? rows.find((r) => r.id === requested.id) : rows.find((r) => r.id === activeId);
  const narrow = useMedia("(max-width: 860px)");
  // An unloaded bookmark must leave pagination reachable; it becomes a detail once its page arrives.
  const queueHidden = narrow && !peek && (requested.kind === "unavailable" || (requested.kind === "requested" && !!selected));
  const queueHiddenRef = useRef(false);
  queueHiddenRef.current = queueHidden;

  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (page.current) ownedOuterRoot.current = page.current.closest("[data-browse-layout]") ?? ownedOuterRoot.current; }, []);
  const queueHandle = useRef<QueueHandle | null>(null);
  const restoredFor = useRef<string | null>(null);
  const [readyTick, setReadyTick] = useState(0);
  /** ONE bounded accepted answer result, owner-scoped; shown only for its explicit id/reader/scope. */
  const answerChooser = useRef<((index: number) => void) | null>(null);
  // null registration = "no chooser"; digits then do nothing instead of invoking a noop.
  const answerNoteFocus = useRef<(() => void) | null>(null);

  const [titleTick, setTitleTick] = useState(0);
  /** The single pending restoration (armed only when a commit unmounts the queue). */
  const pendingRestore = useRef<Snapshot | null>(null);
  /** The layout epoch the surface last saw from READY; captures compare against it. */
  const layoutEpoch = useRef(0);
  /** A viewport transition (resize) is event-driven: resize starts it, the owner's ResizeObserver settles it. */
  const resizing = useRef(false);

  // FOCUS clock: monotonic and entirely separate from the bookmark's captureVersion.
  const focusVersion = useRef(0);
  const intent = useRef<(FocusIntent & { target: FocusTarget }) | null>(null);
  const ownedOuterRoot = useRef<Element | null>(null);
  // Owned identity is the EXACT cached element captured at mount: an ancestor that merely contains the private
  // page is not it, and the event target is never passed as its own "owned" root.
  const isOwnedRoot = (target: Element | null): target is Element => !!target && target === ownedOuterRoot.current;

  /** The named live-facts getter (contract REPAIR2): read at every mutation/completion boundary. */
  const readCurrentFacts = useCallback(() => {
    const u = fullUserRef.current;
    const liveSearch = window.location.search;
    const liveScope = liveScopeOf(liveSearch, u.login, u.role, projectOf(window.location.pathname, liveSearch, getScope()));
    const parsed = readDecisionParam(liveSearch);
    const liveId = liveDecisionId(liveSearch);
    const state = receiptRef.current;
    const coherent = liveScope === scopeRef.current;
    const rowsNow = coherent ? state.rows : [];
    const row = parsed.kind === "requested" && liveId ? rowsNow.find((r) => r.id === liveId) : undefined;
    const selectedId = parsed.kind === "requested" ? row?.id : parsed.kind === "none" ? (cursorRef.current && rowsNow.some((r) => r.id === cursorRef.current) ? cursorRef.current : rowsNow[0]?.id) : undefined;
    // The live read serial of the page that carries the selected id (independent of whether the row object is still
    // present in a fresh receipt): dispatch freshness is about the READ, not row presence.
    const serial = selectedId ? (() => { for (const rc of state.receipts ?? []) if (rc.page.decisions.some((d) => d.id === selectedId)) return rc.readSerial ?? 0; return 0; })() : 0;
    // The default (URI none) resolves to a REAL current row, not an undefined placeholder.
    const defaultRow = parsed.kind === "none" ? (state.rows.find((r) => r.id === (cursorRef.current ?? state.rows[0]?.id)) ?? state.rows[0]) : undefined;
    const resolvedRow = parsed.kind === "requested" ? (liveId === selectedId ? row : undefined) : defaultRow;
    const material = resolvedRow ? materialSignature(resolvedRow, u, resolvedRow ? (loc.overrides[resolvedRow.id] ?? {}) : {}) : "";
    const question = resolvedRow ? questionSignature(resolvedRow, u, resolvedRow ? (loc.overrides[resolvedRow.id] ?? {}) : {}) : "";
    const identity = JSON.stringify(parsed.kind === "none" ? ["none"] : parsed.kind === "requested" ? ["requested", parsed.id] : ["unavailable", parsed.raw]);
    return {
      owner: { readerKey: readerKeyOf({ login: u.login, role: u.role }), readerEpoch: answerSession.get().readerEpoch, scopeKey: liveScope, requestedIdentity: parsed, selectedId },
      user: u, row: resolvedRow,
      loading: state.loading, error: state.error, sourceReadSerial: serial,
      overrides: resolvedRow ? (loc.overrides[resolvedRow.id] ?? {}) : {},
      materialSignature: material, questionSignature: question, requestedIdentity: identity, watermark: answerSession.get().watermark,
      refetch: () => { if (receiptRef.current === state) queryRef.current?.refetch(); },
      requestedIdentityAtRender: identity,
      coherent,
    };
  }, [loc]);
  const queryRef = useRef<{ refetch: () => void } | null>(null);
  queryRef.current = { refetch: query.refetch };
  /** THE single UI-used authority predicate: every mutating handler and completion effect calls it. */
  // Mirror the live material into the session so the synchronous lock boundary can refuse a stale token.
  useEffect(() => {
    const live = readCurrentFacts();
    answerSession.setMaterial({ requestedIdentity: live.requestedIdentity, materialSignature: live.materialSignature, sourceReadSerial: live.sourceReadSerial });
    // Sticky QUESTION observation: while a request is in flight only ITS id (A) is observed, resolved from the
    // current guarded rows independently of the selected B; absence never overwrites the last observation.
    // Capability observation from the FULL live User — independent of whether A is still in the rows.
    const capability = JSON.stringify([live.user.login, live.user.role, live.user.writeRepos ?? [], !!live.user.maintainerWrites]);
    answerSession.setCapability(capability);
    const pendingId = answerSession.pendingId();
    const requestId = pendingId ?? (live.requestedIdentity.startsWith('["requested"') ? JSON.parse(live.requestedIdentity)[1] : undefined);
    const requestRow = requestId ? receiptRef.current.rows.find((r) => r.id === requestId) : undefined;
    if (requestId && requestRow) answerSession.setQuestion(questionSignature(requestRow, live.user, receiptRef.current.rows.length ? (loc.overrides[requestId] ?? {}) : live.overrides), requestId);
  });
  const authorize = useCallback((view: { readerKey: string; readerEpoch: number; scopeKey: string; id: string; materialSignature?: string; requestedIdentity?: string }, intent?: { answerKey?: string }) => {
    const live = readCurrentFacts();
    if (!live.coherent || !live.row) return { ok: false as const, live };
    if (live.owner.readerKey !== view.readerKey || live.owner.readerEpoch !== view.readerEpoch) return { ok: false as const, live };
    if (live.owner.scopeKey !== view.scopeKey || live.owner.selectedId !== view.id || live.row.id !== view.id) return { ok: false as const, live };
    // The rendered intent must still match the CURRENT material (a stale callback cannot rebind).
    if (view.materialSignature !== undefined && view.materialSignature !== live.materialSignature) return { ok: false as const, live };
    // The RENDERED parsed identity must still be the live one (default → explicit same-id is a change).
    if (view.requestedIdentity !== undefined && view.requestedIdentity !== live.requestedIdentity) return { ok: false as const, live };
    if (live.loading || live.error) return { ok: false as const, live };
    if (!canActOn(live.user, [live.row])) return { ok: false as const, live };
    if (live.row.answer || live.row.preparing || live.row.queued || live.row.settling) return { ok: false as const, live };
    const exceptions = (live.row as unknown as { exceptions?: unknown[] }).exceptions?.length ?? 0;
    if (Object.keys(live.overrides).length > 0 || exceptions > 0) return { ok: false as const, live };
    if (intent?.answerKey && !live.row.options.some((o) => o.key === intent.answerKey)) return { ok: false as const, live };
    if (live.sourceReadSerial <= live.watermark) return { ok: false as const, live };
    return { ok: true as const, live };
  }, [readCurrentFacts]);
  const focusTitle = useCallback(() => {
    const owner = page.current;
    const title = owner?.querySelector<HTMLElement>("#detail-title") ?? owner?.querySelector<HTMLElement>("[data-detail-title]") ?? null;
    title?.focus({ preventScroll: true });
  }, []);
  const openItem = useCallback((d: Decision | undefined) => {
    if (!d) return;
    reviewDecision(d, user, (id) => api.decisions.claim(id), navigate);
  }, [api, navigate, user]);

  const cancelIntent = useCallback(() => {
    focusVersion.current += 1;
    intent.current = null;
  }, []);

  const armIntent = useCallback((target: FocusTarget) => {
    focusVersion.current += 1;
    intent.current = {
      target,
      focusIntentVersion: focusVersion.current,
      intentScope: liveFacts().scope,
      intentUriId: liveDecisionId(window.location.search),
      targetOwnerId: "needs-decisions",
    };
  }, []);

  // A reader/filter change clears a bookmark and intents from another scope (local state only; the raw URI stays).
  useEffect(() => { clearSnapshotFor(scopeKey); cancelIntent(); }, [scopeKey, cancelIntent]);

  /** The primary commit. */
  const commit = useCallback((id: string, reason: "activate" | "arrow") => {
    const snapshot = queueHandle.current?.capture();
    if (snapshot) {
      // The anchor and its identity are captured together; only the chosen id is ours to set.
      const chosen: Snapshot = { ...snapshot, chosenId: id };
      captureSnapshot({ scope: chosen.scope, chosenId: id, captureEpoch: chosen.captureEpoch, anchor: chosen.anchor });
      // A compact commit unmounts the queue: that is the only case that arms a restoration.
      pendingRestore.current = narrow ? chosen : null;
    }
    const uriId = liveDecisionId(window.location.search);
    if (commitChangesId(uriId, id)) setDecision(id, { clearPeek: true });
    else if (peek) clearPeek();
    setCursor(id);
    if (reason === "activate" || narrow) { armIntent({ kind: "title", whenHidden: false }); setTitleTick((n) => n + 1); }
    else armIntent({ kind: "row", id, reveal: true });
  }, [narrow, peek, clearPeek, setDecision, armIntent]);

  /** Close: a known row returns to it; an unavailable selection falls back to the native Decision view. */
  const closeSelection = useCallback(() => {
    const id = activeId;
    const live = queueHandle.current?.capture();
    const known = live ?? snapshotFor(scopeKey);
    if (known) {
      pendingRestore.current = queueHidden ? known : null;
      captureSnapshot({ scope: known.scope, chosenId: known.chosenId, captureEpoch: known.captureEpoch, anchor: known.anchor });
    }
    if (requested.kind !== "none") setDecision(null);
    armIntent(id ? { kind: "row", id, reveal: true } : { kind: "nativeView" });
  }, [activeId, requested, queueHidden, setDecision, armIntent, scopeKey]);

  const closePeek = useCallback(() => {
    // Arm BEFORE the native dialog unmounts: its return-focus event can be delivered during that unmount,
    // before a passive effect would run. The guard then validates the owned root, the live URI and the
    // focus clock before touching focus.
    if (narrow && requested.kind !== "none") {
      armIntent({ kind: "title", whenHidden: true });
      setTitleTick((n) => n + 1);
    }
    setPeek(null);
  }, [narrow, requested, armIntent, setPeek]);
  // After an explicit peek close the native dialog returns focus to the owned outer root; the guard redirects
  // exactly that event to the title, while the intent is still current.
  const prevPeek = useRef<string | null>(peek);
  useEffect(() => {
    const was = prevPeek.current;
    prevPeek.current = peek;
    if (!was || peek) return;
    if (!narrow || requested.kind === "none") return;
    // Fallback for a close that did not go through closePeek (e.g. a route-driven close).
    if (!intent.current) armIntent({ kind: "title", whenHidden: true });
    setTitleTick((n) => n + 1);
  }, [peek, narrow, requested, armIntent]);

  const controller = useNeedsQueueKeys({
    rows,
    activeId,
    cursorId: cursor ?? activeId,
    active: true,
    previewOpen: !!peek,
    onCursor: setCursor,
    onCommit: commit,
    previewAt: (id) => setPeek(id),
    onOpenItem: (id) => openItem(rows.find((r) => r.id === id)),
    onToggleCheck: () => { if (activeId) localActions.toggle(activeId); },
    onUndo: () => { void undo(); },
    onViewAnswered: () => update({ tab: filter.status === "answered" ? null : "answered", peek: null }),
    onEscape: () => {
      if (peek) { closePeek(); return; }                            // the native preview owns Escape first (REPLACE)
      if (requested.kind !== "none") { closeSelection(); return; }    // then the decision (PUSH)
      localActions.clearChecked();                                   // only then the batch checks
    },
  });

  // The SINGLE restore owner, once per mount/scope, on a READY naming the CURRENT scope.
  const onReady = useCallback((handle: QueueHandle, readyScope: string) => {
    queueHandle.current = handle;
    ownedOuterRoot.current = page.current?.closest("[data-browse-layout]") ?? ownedOuterRoot.current;
    layoutEpoch.current += 1;
    setReadyTick((n) => n + 1);
    if (readyScope !== scopeKey) return;
    if (restoredFor.current === scopeKey) return;
    restoredFor.current = scopeKey;
    // Restore ignores epochs: a same-scope bookmark stays valid across a layoutEpoch change.
    const snapshot = pendingRestore.current?.scope === scopeKey ? pendingRestore.current : snapshotFor(scopeKey);
    pendingRestore.current = null;
    if (!snapshot) { setCursor(activeId); return; }
    handle.restore(snapshot);
    const id = snapshot.chosenId && rows.some((r) => r.id === snapshot.chosenId) ? snapshot.chosenId : activeId;
    setCursor(id);
  }, [scopeKey, activeId, rows]);

  // The single focus runner, driven by explicit intents and READY/title changes (no timing loops).
  const runIntent = useCallback(() => {
    const pending = intent.current;
    if (!pending) return;
    const live = liveFacts();
    if (pending.intentScope !== live.scope) { intent.current = null; return; }
    if (pending.intentUriId !== live.id) { intent.current = null; return; }
    const target = pending.target;
    if (target.kind === "title") {
      if (target.whenHidden && !queueHidden) return;
      // The title belongs to the current readable receipt; an unavailable close has no title target.
      if (!pending.intentUriId || !receipt.current.rows.some((r) => r.id === pending.intentUriId)) { intent.current = null; return; }
      const title = page.current?.querySelector<HTMLElement>("#detail-title");
      if (!title) return;
      // Only take focus from the owned surface itself (or nothing): never from an unrelated user target.
      const active = document.activeElement as Element | null;
      const fromOwnSurface = !active || active === document.body || isOwnedRoot(active) || active === title ||
        !!page.current?.contains(active);
      if (!fromOwnSurface) return;   // an unrelated user target keeps its focus; the intent simply waits
      title.focus({ preventScroll: true });
      // The intent stays armed: the native dialog may return focus to the owned root right after this frame.
      return;
    }
    if (target.kind === "nativeView") {
      const native = page.current?.querySelector<HTMLElement>('select[aria-label="Decision view"]') ?? null;
      if (native && !queueHidden) { native.focus({ preventScroll: true }); intent.current = null; }
      return;
    }
    if (queueHidden) return;
    if (queueHandle.current?.focusRow(target.id, target.reveal)) intent.current = null;
  }, [queueHidden]);
  useEffect(() => {
    const raf = requestAnimationFrame(runIntent);
    return () => cancelAnimationFrame(raf);
  }, [runIntent, activeId, cursor, readyTick, titleTick]);

  // Owned-root focus guard: only the OUTER element identity, only while the intent is current, live URI matches.
  useEffect(() => {
    const root = ownedOuterRoot.current;
    if (!root) return;
    const onFocusIn = (event: Event) => {
      const pending = intent.current;
      if (!pending) return;
      const target = event.target as Element | null;
      if (!isOwnedRoot(target)) return;
      const live = liveFacts();
      const inReceipt = !!pending.intentUriId && receipt.current.rows.some((r) => r.id === pending.intentUriId);
      const allowed = focusAllows(pending, {
        eventTarget: target,
        ownedOuterRoot: root,                       // the cached element, never the event target
        ownedInnerPage: page.current,
        liveScope: live.scope,                      // the LIVE projected URL scope
        liveUriId: live.id,
        currentFocusVersion: focusVersion.current,
        targetInsideOwner: !!page.current?.querySelector("#detail-title") && inReceipt,
        targetOwnerId: "needs-decisions",
      });
      if (!allowed) return;
      focusTitle();
      if (focusVersion.current === pending.focusIntentVersion) intent.current = null;
    };
    // An OWNED-ROOT listener (the exact cached element), not a document-global focus interception.
    root.addEventListener("focusin", onFocusIn as EventListener);
    return () => root.removeEventListener("focusin", onFocusIn as EventListener);
  }, [focusTitle, readyTick, user.login, user.role]);
  // Any real input disarms a pending focus intent (read-only observation; no global redirection).
  useEffect(() => {
    const disarm = () => { focusVersion.current += 1; intent.current = null; };
    document.addEventListener("keydown", disarm, true);
    document.addEventListener("pointerdown", disarm, true);
    return () => { document.removeEventListener("keydown", disarm, true); document.removeEventListener("pointerdown", disarm, true); };
  }, [scopeKey]);

  // The page owner: cqh mechanism when supported; otherwise an actual-height fallback (ResizeObserver).
  const [fallbackHeight, setFallbackHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (supportsCqh()) { setFallbackHeight(null); return; }
    const owner = page.current;
    if (!owner) return;
    const measure = () => setFallbackHeight(owner.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(owner);
    return () => ro.disconnect();
  }, [rows.length]);
  // Resize transition: starts on resize, ends when the owner's own size settles (event-driven, no timers).
  useEffect(() => {
    const onResize = () => { resizing.current = true; };
    window.addEventListener("resize", onResize);
    const owner = page.current;
    let ro: ResizeObserver | undefined;
    if (owner) { ro = new ResizeObserver(() => { resizing.current = false; }); ro.observe(owner); }
    return () => { window.removeEventListener("resize", onResize); ro?.disconnect(); };
  }, []);

  const controlled: ControlledQueue = {
    scope: scopeKey,
    layoutEpoch: layoutEpoch.current,
    cursorId: cursor ?? activeId ?? (requested.kind !== "none" ? rows[0]?.id : undefined),
    activeId,
    explicitSelection: requested.kind !== "none",
    onCursor: setCursor,
    onActivate: (id) => commit(id, "activate"),
    // Continuous capture while the queue is visible (wide detail included). Validity is state, not the offset
    // value: a genuine settled zero replaces the bookmark; a transition or a pending restoration does not.
    onVisibleListScroll: (snapshot: Omit<Snapshot, "captureVersion">) => {
      if (resizing.current || pendingRestore.current) return;
      if (!acceptCapture({ ready: !query.loading, currentScope: true, visible: true, laidOut: true, transition: false, captureEpoch: snapshot.captureEpoch, layoutEpoch: layoutEpoch.current })) return;
      captureSnapshot({ scope: snapshot.scope, chosenId: snapshot.chosenId, captureEpoch: snapshot.captureEpoch, anchor: snapshot.anchor });
    },
    onReady,
    onDetach: (snapshot) => {
      if (snapshot && !pendingRestore.current && !resizing.current) {
        captureSnapshot({ scope: snapshot.scope, chosenId: snapshot.chosenId, captureEpoch: snapshot.captureEpoch, anchor: snapshot.anchor });
      }
      restoredFor.current = null;
    },
    onQueueKeyDown: controller.onQueueKeyDown,
    onOpenItem: (id) => openItem(rows.find((r) => r.id === id)),
  };

  const checkedHere = rows.filter((r) => loc.checked.has(r.id));
  const answerFacts = (selected || (requested.kind === "requested" && user.role === "viewer")) ? {
    reader: { login: user.login, role: user.role }, readerEpoch: answerSession.get().readerEpoch, user, scopeKey,
    requested: requested.kind, selectedId: requested.kind === "requested" ? requested.id : activeId,
    row: selected, loading: query.loading, error: query.error?.message, receipts: query.readReceipts,
    overrides: selected ? (loc.overrides[selected.id] ?? {}) : {},
    registerChoose: (fn: ((index: number) => void) | null) => { answerChooser.current = fn; },
    registerFocusNote: (fn: (() => void) | null) => { answerNoteFocus.current = fn; },
    readCurrentFacts,
    authorize,
    onAccepted: () => {
      // Reconciliation uses the CURRENT owner/query binding only (never a captured old refetch).
      if (readCurrentFacts().coherent) query.refetch();
    },
  } : undefined;
  const detail = <DecisionDetail
    decision={selected}
    requested={requested.kind}
    reason={requested.kind === "unavailable" ? requested.reason : selected ? undefined : "not-loaded"}
    raw={requested.kind === "unavailable" ? requested.raw : undefined}
    loading={query.loading}
    error={query.error?.message}
    hasRows={rows.length > 0}
    compact={narrow}
    onClose={closeSelection}
    onOpenItem={() => openItem(selected)}
    onFrameKeyDown={(event) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.key === "n" && answerNoteFocus.current) { event.preventDefault(); answerNoteFocus.current(); return; }
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1) { answerChooser.current?.(n - 1); if (answerChooser.current) event.preventDefault(); }
    }}
    answer={answerFacts ? <DecisionAnswer facts={answerFacts} onReview={() => openItem(selected)} /> : undefined}
  />;

  return <BrowseLayout
    fill
    preview={peek ? <DecisionPreview peek={peek} query={query} onClose={closePeek} /> : undefined}
    onClosePreview={closePeek}
  >
    <div className="flex h-full min-h-0 flex-col">
      <div ref={page} className="min-h-0 flex-1 overflow-y-auto [container-type:size]">
        <div className="grid min-h-full items-start gap-x-5 min-[861px]:grid-cols-[auto_minmax(0,1fr)]">
          {!queueHidden && (
            <div className="min-w-0 w-full [height:100cqh] min-[861px]:w-[300px] min-[1101px]:w-[340px] min-[861px]:sticky min-[861px]:top-0"
              style={fallbackHeight !== null ? ({ height: fallbackHeight } as CSSProperties) : undefined}>
              <InboxList {...props} phone={phone} query={query} header={<NeedsControls />} controlled={controlled} />
            </div>
          )}
          {!peek && (!narrow || queueHidden) && <div className="min-w-0">{detail}</div>}
        </div>
      </div>
      {!phone && checkedHere.length > 1 && (
        <div className="max-h-[60%] min-h-0 shrink-0 overflow-y-auto border-t border-line-strong bg-panel">
          <MultiAnswer ds={checkedHere} user={user} />
        </div>
      )}
    </div>
  </BrowseLayout>;
}
