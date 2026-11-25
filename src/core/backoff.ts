// The registered failure backoffs (src/stages/registry.ts GLOBAL_WAITS) of failed jobs and of the runner's own failed checks.

/** Failed jobs of a step are retried after 1, 2, 4, 8, 16 minutes, then every 30. */
export const FAIL_BACKOFF_MS = 60_000;
export const FAIL_BACKOFF_MAX_MS = 30 * 60_000;

/** Minutes-long wait after `failures` failed jobs in a row: 1, 2, 4, 8, 16 minutes, then 30. */
export const failureDelayMs = (failures: number): number => Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));

/** The longest wait of the runner's own checks: they cost a few reads, and a merge leg stands still meanwhile. */
export const RECHECK_MAX_MS = 2 * 60_000;

/** The wait after `failures` failed runs in a row of a check the runner makes itself: none after the first, then 1 minute, then 2. */
export const recheckDelayMs = (failures: number): number => (failures < 2 ? 0 : Math.min(RECHECK_MAX_MS, failureDelayMs(failures - 1)));
