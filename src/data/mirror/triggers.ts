// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("repos",
  { table: "repos" },
);

registerTriggerSource("sync",
  { table: "sync_runs" },
);

registerTriggerSource("items",
  { table: "items" },
  { table: "comments" },
);

registerTriggerSource("checks",
  { table: "pr_checks" },
);

registerTriggerSource("mainci",
  { table: "main_ci" },
);

// diff_facts: what the merge rule reads from a reviewed head's diff (sensitive content, size, extras pending).
registerTriggerSource("reviews",
  { table: "diff_facts" },
);

registerTriggerSource("downloads",
  { table: "release_assets" },
  { table: "release_apps" },
  { table: "download_deltas" },
  { table: "star_samples" },
);
