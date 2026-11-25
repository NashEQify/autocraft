// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

registerTriggerSource("ranks",
  { table: "item_rank" },
  { table: "item_priority" },
);

registerTriggerSource("classify",
  { table: "classifications" },
  { table: "item_areas" },
  { table: "area_lists" },
  { table: "area_proposals" },
);

registerTriggerSource("dupes",
  { table: "duplicate_pairs" },
  { table: "duplicate_scans" },
  { table: "dupe_comparisons" },
  { table: "dupe_groups" },
  { table: "dupe_group_items" },
);
