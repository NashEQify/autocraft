// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("mainci",
  { table: "main_fixes" },
);

// Implementations and the Implement switches are planner input: a queued issue's next step reads them.
registerTriggerSource("fixes",
  { table: "patch_checks" },
);

registerTriggerSource("verify",
  { table: "fixups" },
  { table: "ci_fixes" },
);
