import { CircleNotchIcon, DiscordLogoIcon, GithubLogoIcon, MonitorIcon, RobotIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { t } from "../../../../../src/i18n/index.ts";
import type { ChatEntry, ChatVia } from "../../../api/types";
import { Avatar } from "../../atoms/Avatar";
import { MessageTime } from "../../atoms/MessageTime";
import { safeHref } from "../../safeHref";

type Said = Extract<ChatEntry, { t: "said" }>;

const VIA: Record<ChatVia, [string, typeof GithubLogoIcon]> = {
  dashboard: [t("Dashboard"), MonitorIcon],
  github: [t("GitHub comment"), GithubLogoIcon],
  discord: [t("Discord"), DiscordLogoIcon],
  agent: [t("Agent"), RobotIcon],
  cli: [t("Command line"), TerminalWindowIcon],
};

/** A person's message to AutoCraft, on the right: who, when and where they wrote it, then the text. */
export function ChatBubble({ e }: { e: Said }) {
  const [where, Icon] = VIA[e.via];
  const label = (
    <span className="inline-flex items-center gap-1">
      <Icon aria-hidden /> {where}
    </span>
  );
  return (
    <li className="flex flex-col items-end gap-1.5 pl-10 md:pl-28">
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-xs text-ink/70">
        <Avatar login={e.login} size={18} />
        <span className="font-semibold text-ink">@{e.login}</span>
        <MessageTime iso={e.at} />
        {e.url ? (
          <a href={safeHref(e.url)} target="_blank" rel="noopener noreferrer" className="rounded hover:text-ink hover:underline">
            {label}
          </a>
        ) : (
          label
        )}
      </div>
      <div className="max-w-full whitespace-pre-wrap rounded-bubble rounded-tr-md bg-bubble px-4 py-2.5 text-md leading-6 text-ink [overflow-wrap:anywhere]">{e.body}</div>
      {e.pending && (
        <p className="inline-flex items-center gap-1.5 text-xs text-ink/70">
          <CircleNotchIcon aria-hidden className="animate-spin" />
          {t("Waiting for the answer")}
        </p>
      )}
      {e.refusal && <p className="text-xs text-bad">{e.refusal}</p>}
    </li>
  );
}
