/**
 * Longest a Discord model call waits in the queue for a helper (or an account slot) to take it. Past it the call is
 * withdrawn, so no helper can take it later, and the caller uses its fallback at once. A call that was taken is not
 * limited by this; it keeps the answer timeout of its prompt.
 */
export const DISCORD_TAKE_WAIT_MS = 8_000;
