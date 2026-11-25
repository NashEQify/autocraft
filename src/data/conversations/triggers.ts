// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("conversations",
  { table: "conversations" },
  { table: "conversation_turns" },
  { table: "conversation_cards" },
);
