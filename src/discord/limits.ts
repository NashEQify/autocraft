/**
 * Longest a Discord model call waits in the queue for a helper (or an account slot) to take it. Past it the call is
 * withdrawn, so no helper can take it later, and the caller uses its fallback at once. A call that was taken is not
 * limited by this; it keeps the answer timeout of its prompt.
 */
export const DISCORD_TAKE_WAIT_MS = 8_000;
/** A message that names more tracked items than this records none of them. */
export const MENTION_MAX_ITEMS = 20;
/** Newly recorded mention rows per author (keyed hash) within the window. */
export const MENTION_AUTHOR_ROWS = 40;
/** Newly recorded mention rows per channel (keyed hash) within the window. */
export const MENTION_CHANNEL_ROWS = 150;
/** Sliding window of the two row limits above. */
export const MENTION_WINDOW_MS = 10 * 60_000;
