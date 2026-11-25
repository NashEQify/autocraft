import { useState } from "react";
import { CheckIcon, HourglassIcon, SpinnerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import type { ConversationCard as Card } from "../../api/types";
import { Button } from "../atoms/Button";
import { Textarea } from "../atoms/Textarea";
import { TimeAgo } from "../atoms/TimeAgo";
import { QueuedPress } from "../molecules/QueuedPress";
import { cn } from "../cn";
import { safeHref } from "../safeHref";

const STATE: Partial<Record<Card["state"], [label: () => string, tone: string]>> = {
  done: [() => t("Done"), "text-ok"],
  failed: [() => t("Failed"), "text-bad"],
  queued: [() => t("Queued"), "text-ink/70"],
  running: [() => t("Running…"), "text-ink/70"],
  dismissed: [() => t("Dismissed"), "text-ink/70"],
};

/**
 * An action the model proposed: a command of the registry with what it runs, a comment, or a label. A press runs the card as shown.
 * Props only: the caller runs the calls.
 */
export function ConversationCard({ card: a, operator, viewer, onRun, onDismiss, className }: {
  card: Card;
  operator: boolean;
  viewer: { login: string };
  /** Runs the card; `text` is the comment as edited, when it differs from the proposed one. */
  onRun: (text?: string) => Promise<unknown>;
  onDismiss: () => Promise<unknown>;
  className?: string;
}) {
  // The comment being edited; null shows the card's own text.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A card that writes to GitHub needs a second press.
  const [armed, setArmed] = useState(false);
  const proposed = a.state === "proposed";
  const gone = a.state === "dismissed" || a.state === "replaced";

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const run = () => {
    if (a.writes && !armed) return setArmed(true);
    setArmed(false);
    return act(() => onRun(draft !== null && draft !== a.text ? draft : undefined));
  };
  const btn = "max-md:h-11";
  const state = STATE[a.state];

  return (
    <div className={cn("rounded-md border border-line px-3 py-2.5", gone ? "bg-transparent" : "bg-raised", className)}>
      <div className="flex items-start gap-1.5 text-sm font-medium">
        {a.state === "done" && <CheckIcon aria-hidden className="mt-1 shrink-0 text-ok" />}
        {a.state === "failed" && <WarningCircleIcon aria-hidden className="mt-1 shrink-0 text-bad" />}
        {a.state === "queued" && <HourglassIcon aria-hidden className="mt-1 shrink-0 text-ink/60" />}
        {a.state === "running" && <SpinnerIcon aria-hidden className="mt-1 shrink-0 animate-spin text-ink/60" />}
        <span className={cn("min-w-0 flex-1 break-words", gone && "font-normal text-ink/60 line-through")}>{a.headline || a.title}</span>
        {state && <span className={cn("shrink-0 text-xs font-normal", state[1])}>{state[0]()}</span>}
      </div>
      {!gone && a.command && <p className="code mt-1.5 w-fit rounded bg-ink/[0.06] px-1.5 py-0.5 text-sm">{a.command}</p>}
      {proposed && a.kind === "command" && a.steps.length > 0 && (
        <ol aria-label={t("What runs")} className="mt-2 list-decimal space-y-0.5 pl-5 text-sm leading-5 text-ink/80 marker:text-ink/60">
          {a.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {a.text !== undefined && !gone &&
        (draft !== null ? (
          <div className="mt-2">
            <div className="mb-1 text-2xs font-medium text-ink/70">{t("Comment")}</div>
            <Textarea value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} rows={5} aria-label={t("Comment text")} className="max-h-[60vh] min-h-24 resize-none [field-sizing:content]" />
          </div>
        ) : (
          <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-line-strong pl-3 text-sm leading-5 text-ink/80">{a.text}</blockquote>
        ))}
      {a.editedBy && !gone && <p className="mt-1 text-xs text-ink/70">{t("Edited by {login}", { login: a.editedBy })}</p>}
      {proposed && a.stale === "pr-changed" && <p className="mt-2 text-xs text-warn">{t("The pull request changed since this was proposed, so it no longer runs.")}</p>}
      {proposed && a.stale === "new-comments" && <p className="mt-2 text-xs text-warn">{t("There are new comments on GitHub since this was proposed.")}</p>}
      {proposed && a.refusal && <p className="mt-2 text-xs text-ink/70">{a.refusal}</p>}
      {a.state === "failed" && a.error && <p className="mt-2 text-xs text-bad">{a.error}</p>}
      {a.state === "done" && a.done && (
        <p className="mt-2 text-xs text-ink/70">
          {a.done.link ? (
            <a href={safeHref(a.done.link)} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
              {a.done.label}
            </a>
          ) : (
            a.done.label
          )}{" "}
          · <TimeAgo iso={a.done.at} />
          {a.by ? ` · ${a.by}` : ""}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
      {a.state === "queued" && a.queued && <QueuedPress by={a.by ?? ""} reason={a.queued.reason} viewer={{ login: viewer.login, operator }} onDismiss={onDismiss} />}
      {proposed && a.canSettle && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {!a.refusal && (
            <Button size="sm" variant="primary" className={cn(btn, armed && "border-bad bg-bad text-white hover:bg-bad/90")} disabled={busy || draft?.trim() === ""} onClick={() => void run()}>
              {armed ? t("Confirm: {effect}", { effect: a.writes! }) : a.label}
            </Button>
          )}
          {armed && (
            <Button size="sm" variant="ghost" className={btn} disabled={busy} onClick={() => setArmed(false)}>
              {t("Cancel")}
            </Button>
          )}
          {a.text !== undefined && (
            <Button size="sm" variant={draft !== null ? "ghost" : "secondary"} className={btn} disabled={busy} onClick={() => setDraft(draft !== null ? null : a.text!)}>
              {draft !== null ? t("Cancel editing") : t("Edit")}
            </Button>
          )}
          <Button size="sm" variant="ghost" className={btn} disabled={busy} onClick={() => void act(onDismiss)}>
            {t("Dismiss")}
          </Button>
        </div>
      )}
    </div>
  );
}
