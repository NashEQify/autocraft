// Errors known to be raised before any request went out (no token, no identity, a command that could not start). The error keeps its
// own type, which callers test; a write that fails with one certainly made nothing.
const unsent = new WeakSet<object>();

/** Marks `e` as raised before any request went out; returns it. */
export function markUnsent<T>(e: T): T {
  if (typeof e === "object" && e !== null) unsent.add(e);
  return e;
}

export const isUnsent = (e: unknown): boolean => typeof e === "object" && e !== null && unsent.has(e);
