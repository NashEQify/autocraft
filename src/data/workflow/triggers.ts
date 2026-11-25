// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("queue",
  { table: "merge_holds" },
);

// Started items of the maintainer workflow: entry, approval, weight, plan, blocker, recommendation. Planner input.
registerTriggerSource("workflows",
  { table: "item_workflows" },
);

// What people said to items of the maintainer workflow: an unclear answer lives only here. Lists only; not planner input.
registerTriggerSource("workflow-events",
  { table: "workflow_events" },
);

// Pre-approved merges and the operator fix-ups behind them: the planner works them, so the topic is planner input.
registerTriggerSource("preapprovals",
  { table: "preapprovals" },
  { table: "operator_fixups" },
);

registerTriggerSource("actions",
  { table: "workflow_actions" },
);
