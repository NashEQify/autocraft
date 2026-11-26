// One conversation between the maintainers and AutoCraft, oldest first: people's messages as bubbles on the right, AutoCraft's
// replies in the main flow with its work as compact rows that open to their detail, GitHub and Discord activity as single lines.
// The view follows new entries only while the reader is at the bottom; otherwise it offers "New messages".
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { t } from "../../../../../../src/i18n/index.ts";
import type { ChatEntry, ItemConversation as Conversation } from "../../../../api/chat-types";
import { AutoCraftMessage, AutoCraftTurn } from "../../../../ui/molecules/chat/AutoCraftMessage";
import { ChatBubble } from "../../../../ui/molecules/chat/ChatBubble";
import { ChatComposer } from "../../../../ui/molecules/chat/ChatComposer";
import { DiscordLine } from "../../../../ui/molecules/chat/DiscordLine";
import { GithubLine } from "../../../../ui/molecules/chat/GithubLine";
import { WorkRow } from "../../../../ui/molecules/chat/WorkRow";
import { WorkingLine } from "../../../../ui/molecules/chat/WorkingLine";

type Said = Extract<ChatEntry, { t: "said" }>;
type Reply = Extract<ChatEntry, { t: "reply" }>;
type Work = Extract<ChatEntry, { t: "work" }>;
type Github = Extract<ChatEntry, { t: "github" }>;
type Discord = Extract<ChatEntry, { t: "discord" }>;

type Block = { k: "said"; e: Said } | { k: "github"; e: Github } | { k: "discord"; e: Discord } | { k: "turn"; at: string; items: (Reply | Work)[] };

function blocks(entries: ChatEntry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    if (e.t === "said") out.push({ k: "said", e });
    else if (e.t === "github") out.push({ k: "github", e });
    else if (e.t === "discord") out.push({ k: "discord", e });
    else {
      const last = out[out.length - 1];
      if (last?.k === "turn") last.items.push(e);
      else out.push({ k: "turn", at: e.at, items: [e] });
    }
  }
  return out;
}

const NEAR_BOTTOM = 48;
const plain = (s: string) => s.replace(/[*_`]/g, "");

interface Props {
  c: Conversation;
  /** Posts the reader's text to the conversation; rejects with the reason it failed. */
  onSend: (text: string) => Promise<void>;
  onEvent: (id: string) => void;
  onGithub: () => void;
  /** Why the reader cannot reply, shown in the disabled box; used when `c.canReply` is false. */
  blockedReason?: string;
  /** Rows with their own controls (holds, paused steps), right above the composer. */
  notice?: ReactNode;
}

export function ItemConversation({ c, onSend, onEvent, onGithub, blockedReason, notice }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const listEl = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const seen = useRef<Set<string> | null>(null);
  const [newBelow, setNewBelow] = useState(false);
  const [announce, setAnnounce] = useState("");
  const last = c.entries[c.entries.length - 1];
  const openReply = c.open ? [...c.entries].reverse().find((e): e is Reply => e.t === "reply" && !!e.ask) : undefined;

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNewBelow(false);
  }, []);

  // The first render starts at the end; later entries move the view only when the reader is already there.
  useLayoutEffect(() => {
    if (seen.current === null) toBottom();
    else if (atBottom.current) toBottom();
    else setNewBelow(true);
  }, [c.entries.length, last?.id, c.working, toBottom]);

  // Fonts and Markdown settle after the first paint; keep the end in view for that moment only, so expanding a row does not move the view.
  useEffect(() => {
    const list = listEl.current;
    if (!list) return;
    const until = Date.now() + 600;
    const ro = new ResizeObserver(() => {
      if (Date.now() < until && atBottom.current) toBottom();
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, [toBottom]);

  // New AutoCraft replies go to the live region; the first read is not announced.
  useEffect(() => {
    const ids = new Set(c.entries.map((e) => e.id));
    const before = seen.current;
    seen.current = ids;
    if (!before) return;
    const fresh = c.entries.filter((e): e is Reply => e.t === "reply" && !before.has(e.id));
    const latest = fresh[fresh.length - 1];
    if (latest) setAnnounce(`AutoCraft: ${plain(latest.body)}${latest.ask ? ` ${latest.ask.question}` : ""}`);
  }, [c.entries]);

  const send = async (text: string) => {
    await onSend(text);
    atBottom.current = true;
    setAnnounce(t("Message sent"));
  };

  const running = last?.t === "work" && last.state === "running";
  const bs = blocks(c.entries);
  const lastBlock = bs[bs.length - 1];
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
          if (atBottom.current) setNewBelow(false);
        }}
        className="h-full overflow-y-auto"
      >
        <ol ref={listEl} role="log" aria-live="off" aria-label={t("Conversation with AutoCraft, oldest first")} className="mx-auto flex w-full max-w-[784px] flex-col gap-6 px-4 pb-6 pt-6 md:px-8">
          {bs.map((b) =>
            b.k === "said" ? (
              <ChatBubble key={b.e.id} e={b.e} />
            ) : b.k === "github" ? (
              <GithubLine key={b.e.id} e={b.e} onGithub={onGithub} />
            ) : b.k === "discord" ? (
              <DiscordLine key={b.e.id} e={b.e} />
            ) : (
              <AutoCraftTurn key={b.items[0]!.id} at={b.at}>
                {b.items.map((e) => (e.t === "reply" ? <AutoCraftMessage key={e.id} e={e} open={e === openReply} /> : <WorkRow key={e.id} e={e} onEvent={onEvent} />))}
                {b === lastBlock && c.working && !running && <WorkingLine line={c.working} />}
              </AutoCraftTurn>
            ),
          )}
          {c.working && !running && lastBlock?.k !== "turn" && (
            <AutoCraftTurn at={last?.at ?? new Date().toISOString()}>
              <WorkingLine line={c.working} />
            </AutoCraftTurn>
          )}
        </ol>
      </div>
      {newBelow && (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-3.5 py-1.5 text-sm font-medium shadow-md hover:bg-ink/[0.05] max-md:min-h-11"
        >
          <ArrowDownIcon aria-hidden />
          {t("New messages")}
        </button>
      )}
      </div>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      {notice}
      <ChatComposer open={!!c.open} blocked={c.canReply ? null : (blockedReason ?? t("You can reply when you have write access to this repository"))} onSend={send} />
    </div>
  );
}
