/**
 * The id the selection keeps. A requested id stays requested whether its decision is open, answered or not loaded yet, so Undo
 * brings an answered question back to the front and a `#decision-X` link survives until X loads. Only an empty request takes the
 * shown question's id.
 */
export function resolveSelection(requested: string | null, shownId: string | undefined): string | null {
  return requested ?? shownId ?? null;
}
