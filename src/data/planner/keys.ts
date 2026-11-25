// Key-source constructors of the planner; feature code holds and passes the descriptors.
import type { PassKeys, Ref } from "../keys.ts";

/** Every item the planner decides. */
export function fullPass(): PassKeys { return { mode: "full" }; }
/** The logged changes plus refs whose kept facts are due; `seen` is the number of log rows the cursor already read. */
export function changedPass(due: Ref[], seen: number): PassKeys { return { mode: "changed", due, seen }; }
