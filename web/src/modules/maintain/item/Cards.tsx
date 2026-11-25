import { useApi } from "../../../api/client";
import type { ConversationTurn } from "../../../api/types";
import { useUser } from "../../../shell/UserContext";
import { ConversationCard } from "../../../ui/organisms/ConversationCard";

/** The actions the model proposed in a turn. */
export function TurnCards({ cards }: { cards: ConversationTurn["actions"] }) {
  const api = useApi();
  const user = useUser();
  if (!cards.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {cards.map((a) => (
        <ConversationCard
          key={a.id}
          card={a}
          viewer={user}
          operator={user.role === "operator"}
          onRun={async (text) => {
            // The press runs the card as shown, with the presser's own edit when there is one.
            const shown = text === undefined ? a : await api.conversations.editCard(a.id, { text });
            await api.conversations.doCard(a.id, shown.digest);
          }}
          onDismiss={() => api.conversations.dismissCard(a.id)}
        />
      ))}
    </div>
  );
}
