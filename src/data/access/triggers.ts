// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("items",
  { table: "whitelist_overrides" },
);

registerTriggerSource("discord-links",
  { table: "discord_links" },
);

// Sessions change on every request (last_seen); only sign-ins and revocations matter.
registerTriggerSource("access",
  { table: "access" },
  { table: "sessions", ops: ["INSERT","DELETE"] },
);
