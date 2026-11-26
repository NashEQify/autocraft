// Mock-only page that shows the conversation organism on the fake stories, until the item page assembles it.
import { useEffect, useMemo, useState } from "react";
import { useUser } from "../../../../shell/UserContext";
import { createChatMock } from "../../../../api/mock/chatMock";
import type { ItemChat } from "../../../../api/chat-types";
import type { ViewProps } from "../../../../registry/types";
import { ItemConversation } from "./ItemConversation";

export function ChatPreview({ params }: ViewProps) {
  const user = useUser();
  const repo = params.repo ?? "";
  const number = Number(params.number);
  const api = useMemo(() => createChatMock(user, () => {}).itemChat, [user]);
  const [chat, setChat] = useState<ItemChat | null>(null);
  useEffect(() => void api.get(repo, number).then(setChat), [api, repo, number]);
  const c = chat?.conversations[0];
  if (!chat || !c) return null;
  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-0 flex-col">
      <h1 className="px-4 pt-3 text-lg font-semibold md:px-8">
        {repo}#{number} · {chat.status}
      </h1>
      <ItemConversation c={c} onSend={async (text) => setChat(await api.send(repo, number, c.id, text))} onEvent={() => {}} onGithub={() => {}} />
    </div>
  );
}
