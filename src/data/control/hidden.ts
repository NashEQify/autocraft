// Pure helpers of the viewer's repo filter (M05 control-a); they move from `src/hidden-sql.ts` and `src/dash/api/visible.ts`.
import type { Db } from "../../db/index.ts";
import type { HiddenRepos } from "./types.ts";

/** Whether the viewer may not see the repo. */
export function isHiddenRepo(h: HiddenRepos, repo: string): boolean {
  throw new Error("not built: control.isHiddenRepo");
}

/** Whether any filter applies. */
export function filtered(h: HiddenRepos): boolean {
  throw new Error("not built: control.filtered");
}

/** Free text that quotes a hidden repo's item is left out whole. */
export function blankIfHidden<T extends string | null | undefined>(text: T, hidden: HiddenRepos): T | "" {
  throw new Error("not built: control.blankIfHidden");
}

/** Matches a hidden repo name only as a whole name. */
export function hiddenPattern(hidden: string[]): RegExp | null {
  throw new Error("not built: control.hiddenPattern");
}
