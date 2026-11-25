// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// Operator and maintainer pages only; not planner input.
registerTriggerSource("security",
  { table: "security_scans" },
  { table: "security_areas" },
  { table: "security_findings" },
  { table: "security_calls" },
  { table: "security_fix_rounds" },
  { table: "security_fix_log" },
  { table: "security_scan_tests" },
);
