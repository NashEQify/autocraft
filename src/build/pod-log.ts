// Following a container's output into the task log across reads and runner restarts (src/build/launcher.ts podLog).
//
// The pod log API has no byte offset, so a read starts at a time: `sinceTime` (whole seconds) returns, in log order, the
// lines stamped at or after it, each with its nanosecond time (`timestamps`). A position names that window and how many of
// its lines are already in the task log, so the next read skips exactly those and appends the rest, whatever the times of
// lines at the boundary. The window starts a second before the last appended line: stdout and stderr are stamped apart and
// written in one file, so a line written later can carry a slightly earlier time, and it stays in the window.

/** How far a container's output reached the task log. */
export type LogPos = {
  /** The window's start (RFC 3339, whole seconds): the read's `sinceTime`. */
  since: string;
  /** Lines of the window already appended, and their bytes as read (with their timestamps and newlines). */
  lines: number;
  bytes: number;
  /** The timestamp of the last of them, which checks that the window still starts where it did. */
  last: string;
};

export type Taken = {
  /** The output to append, timestamps removed. */
  text: string;
  /** The position after it; unchanged when nothing new was complete. */
  pos: LogPos | undefined;
  /** New lines taken. */
  taken: number;
};

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const stampOf = (line: string): string | null => {
  const at = line.indexOf(" ");
  return at > 0 && STAMP.test(line.slice(0, at)) && Number.isFinite(Date.parse(line.slice(0, at))) ? line.slice(0, at) : null;
};
const contentOf = (line: string): string => (stampOf(line) === null ? line : line.slice(line.indexOf(" ") + 1));

/** A timestamp in nanoseconds since the epoch: Date.parse keeps milliseconds, the fraction's further digits add the rest. */
const nanosOf = (stamp: string): bigint => BigInt(Date.parse(stamp)) * 1_000_000n + BigInt(`${/\.(\d+)/.exec(stamp)?.[1] ?? ""}000000000`.slice(3, 9));

const wholeSecond = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * What a read (`text`, with timestamps, from `pos.since` or the start when there is no position) adds to the task log.
 * Only complete lines are taken unless `end` says the read reached the end of a container that stopped, when the last
 * line without a newline is taken too.
 */
export function takeLog(text: string, pos: LogPos | undefined, end: boolean): Taken {
  const lines = text.split("\n");
  const rest = lines.pop()!;
  if (end && rest) lines.push(rest);
  let skip = 0;
  if (pos) {
    if (lines.length >= pos.lines && stampOf(lines[pos.lines - 1] ?? "") === pos.last) skip = pos.lines;
    else {
      // The window no longer starts with what was read before (the kubelet rotated the log file): skip by time instead.
      const last = nanosOf(pos.last);
      while (skip < lines.length && (stampOf(lines[skip]!) === null || nanosOf(stampOf(lines[skip]!)!) <= last)) skip++;
    }
  }
  const fresh = lines.slice(skip);
  if (!fresh.length) return { text: "", pos, taken: 0 };
  const consumed = lines.slice(0, skip + fresh.length);
  const lastStamp = consumed.map(stampOf).findLast((s) => s !== null);
  const complete = !(end && rest);
  const out = fresh.map(contentOf).join("\n") + (complete ? "\n" : "");
  if (!lastStamp) return { text: out, pos, taken: fresh.length };
  const start = wholeSecond(Date.parse(lastStamp) - 1000);
  const since = pos && pos.since > start ? pos.since : start;
  const sinceNs = nanosOf(since);
  let n = 0, bytes = 0;
  consumed.forEach((line, i) => {
    const s = stampOf(line);
    if (s === null || nanosOf(s) < sinceNs) return;
    n++;
    bytes += Buffer.byteLength(line) + (i < consumed.length - 1 || complete ? 1 : 0);
  });
  return { text: out, pos: { since, lines: n, bytes, last: lastStamp }, taken: fresh.length };
}
