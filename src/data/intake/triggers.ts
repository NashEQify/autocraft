// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// An operator released an outside-author item from its hold: the planner plans for it at once.
registerTriggerSource("outside",
  { table: "outside_released" },
);

// The planner's Plan cache; its own output, so the planner does not plan again for it.
registerTriggerSource("plans",
  { table: "outside_holds" },
);
