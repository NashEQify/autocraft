// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// diff_facts: what the merge rule reads from a reviewed head's diff (sensitive content, size, extras pending).
registerTriggerSource("reviews",
  { table: "opus_reviews" },
  { table: "review_posts" },
);

registerTriggerSource("postmerge",
  { table: "postmerge_reviews" },
  { table: "postmerge_followups" },
  { table: "premerge_reviews" },
);
