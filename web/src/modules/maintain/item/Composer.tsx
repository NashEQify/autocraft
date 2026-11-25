import { useState } from "react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import { useApi } from "../../../api/client";
import type { RepoName } from "../../../api/types";
import { Button } from "../../../ui/atoms/Button";
import { Textarea } from "../../../ui/atoms/Textarea";
import { cn } from "../../../ui/cn";

/**
 * The thread's one input, stuck to the bottom of the page (above the phone tab bar), for those the server lets talk (`talk`:
 * operators, and maintainers with write access whose messages run on their own Task Runner). Someone who lost that right still
 * withdraws their own waiting message.
 */
export function Composer({ repo, number, talk, withdrawable, exists, pending, flush }: {
  /** The parent has no side padding to cancel: the bar spans it. */
  flush?: boolean;
  repo: RepoName;
  number: number;
  talk: boolean;
  /** A maintainer's message waits for Opus and the viewer may withdraw it. */
  withdrawable?: boolean;
  exists: boolean;
  pending: boolean;
}) {
  const api = useApi();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const send = async (ask: boolean) => {
    const text = draft.trim();
    if (!text || busy) return;
    await run(async () => {
      await api.conversations.say(repo, number, text, ask ? undefined : false);
      setDraft("");
    });
  };
  if (!talk && !withdrawable) return null;
  const withdraw = withdrawable && (
    <Button variant="secondary" className="max-md:h-11" disabled={busy} onClick={() => void run(() => api.conversations.withdraw(repo, number))}>
      Withdraw message
    </Button>
  );
  return (
    <div className={cn("sticky bottom-0 z-10 mt-4 border-t border-line bg-panel px-4 py-2.5 md:px-6", !flush && "-mx-4 md:-mx-6")}>
      {talk ? (
        <div className="flex flex-col gap-2">
          {/* The field keeps the bar's full width at every size; the actions wrap under it rather than squeezing it. */}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(true);
            }}
            rows={2}
            placeholder={exists ? "Reply to Opus" : "Ask Opus about this item"}
            aria-label="Message to Opus"
            className="max-h-40 resize-y"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {withdraw}
            <Button variant="secondary" className="max-md:h-11" disabled={!draft.trim() || busy} onClick={() => void send(false)}>
              Post without Opus
            </Button>
            <Button variant="primary" className="max-md:h-11" icon={PaperPlaneRightIcon} loading={busy} disabled={!draft.trim() || pending} onClick={() => void send(true)}>
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">{withdraw}</div>
      )}
      {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
    </div>
  );
}
