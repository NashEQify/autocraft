// The Live board at the top of Home: every running and queued unit of the pipeline's work on one time axis. A lane is a job (or a call or
// build task of its own); its thin bar is the job, the tall bars are its model calls and build steps. Solid: done, pulsing: running now,
// dashed: the expected rest (median of earlier runs), red line: 90% of earlier runs were done by then. Under the lanes, the latest few
// finished events of the feed (merges, GitHub writes, answered questions). Above the lanes, who provides the tokens: one card per account
// with its share of the last hour's tokens; operators press one to pick out its model calls on the lanes.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "../../api/client";
import type { LiveAccount, LiveEstimate, LiveLane, LiveOp, LiveOpKind } from "../../api/types";
import { compact } from "../../ui/molecules/BarList";
import { nowMs } from "../../lib/format";
import { itemPath } from "../../lib/links";
import { useNow } from "../../lib/useNow";
import { cn } from "../../ui/cn";
import { ItemIcon } from "../../ui/atoms/ItemIcon";
import { TipLines, Tooltip } from "../../ui/atoms/Tooltip";
import { EntryRow } from "../../ui/molecules/EntryRow";
import { ItemPeek } from "../../ui/molecules/ItemPeek";
import { Section } from "../../ui/molecules/Section";
import { ErrorLine } from "../admin/parts";

const KIND: Record<LiveOpKind | "job", { label: string; bg: string; border: string }> = {
  model: { label: "Model call", bg: "bg-accent", border: "border-accent" },
  setup: { label: "Setup", bg: "bg-c4", border: "border-c4" },
  build: { label: "Build", bg: "bg-warn", border: "border-warn" },
  tests: { label: "Tests", bg: "bg-ok", border: "border-ok" },
  lint: { label: "Lint", bg: "bg-c3", border: "border-c3" },
  other: { label: "Other step", bg: "bg-c5", border: "border-c5" },
  job: { label: "Job", bg: "bg-ink/30", border: "border-ink/40" },
};
const LEGEND: (LiveOpKind | "job")[] = ["model", "setup", "build", "tests", "lint", "other", "job"];

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Where running work is against its estimate. */
function eta(start: number, e: LiveEstimate | null, now: number): { text: string; late: boolean } {
  const elapsed = now - start;
  if (!e) return { text: fmtDur(elapsed), late: false };
  const left = e.median - elapsed;
  if (left > 0) return { text: `${fmtDur(elapsed)} · ~${fmtDur(left)} left`, late: false };
  return elapsed > e.p90 ? { text: `${fmtDur(elapsed)} · longer than 90% of earlier runs`, late: true } : { text: `${fmtDur(elapsed)} · should be done any moment`, late: false };
}

/** The tip on a bar: what it is, when, and against what it usually takes. */
function BarTip({ detail, start, end, estimate, now, failed }: { detail?: string | null; start: number; end: number | null; estimate: LiveEstimate | null; now: number; failed?: boolean }) {
  const running = end === null;
  const r = running ? eta(start, estimate, now) : null;
  return (
    <TipLines
      lines={[
        detail,
        `${clock(start)} – ${running ? "now" : clock(end)} · ${fmtDur((end ?? now) - start)}${failed ? " · failed" : ""}`,
        r && <span className={r.late ? "text-bad" : undefined}>{r.text}</span>,
        estimate && `Usually ${fmtDur(estimate.median)}, 90% within ${fmtDur(estimate.p90)} (${estimate.samples} runs)`,
      ]}
    />
  );
}

/** One lane's track: the job as a thin bar, its calls and steps as tall ones, and the expected rest of what runs. */
function Track({ lane, from, to, now, picked }: { lane: LiveLane; from: number; to: number; now: number; picked: string | null }) {
  const x = (t: number) => `${((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100}%`;
  const w = (a: number, b: number) => `${(Math.max(0, Math.min(b, to) - Math.max(a, from)) / (to - from)) * 100}%`;
  const start = Date.parse(lane.start);
  const end = lane.end ? Date.parse(lane.end) : now;
  const ghost = (s: number, e: LiveEstimate | null, kind: LiveOpKind | "job", thin: boolean) => {
    if (!e) return null;
    const due = s + e.median;
    const late = s + e.p90;
    return (
      <>
        {due > now && <div aria-hidden className={cn("absolute rounded-sm border border-dashed", KIND[kind].border, thin ? "top-[18px] h-1.5" : "top-1 h-3.5")} style={{ left: x(now), width: w(now, due) }} />}
        {late > now && <div aria-hidden className="absolute top-0 h-6 w-px bg-bad/60" style={{ left: x(late) }} />}
      </>
    );
  };
  const running = lane.state === "running";
  return (
    <div className="relative h-6 rounded bg-ink/[0.04]">
      {lane.state !== "queued" && (
        <Tooltip title={lane.title} content={<BarTip detail={lane.line} start={start} end={lane.end ? end : null} estimate={lane.estimate} now={now} failed={lane.state === "failed"} />}>
          <div className={cn("absolute top-[18px] h-1.5 rounded-sm", lane.state === "failed" ? "bg-bad/70" : KIND.job.bg)} style={{ left: x(start), width: w(start, end), minWidth: 2 }} />
        </Tooltip>
      )}
      {running && ghost(start, lane.estimate, "job", true)}
      {lane.ops.map((o: LiveOp, i) => {
        const s = Date.parse(o.start);
        const e = o.end ? Date.parse(o.end) : now;
        if (e < from) return null;
        // With an account picked, its calls stand out and everything else steps back.
        const mine = picked !== null && o.kind === "model" && o.account === picked;
        return (
          <span key={i}>
            <Tooltip title={`${KIND[o.kind].label}: ${o.label}`} content={<BarTip detail={o.detail} start={s} end={o.end ? e : null} estimate={o.estimate} now={now} failed={o.failed} />}>
              <div
                className={cn(
                  "absolute top-1 h-3.5 rounded-sm",
                  o.failed ? "bg-bad" : KIND[o.kind].bg,
                  picked !== null && !mine ? "opacity-20" : o.end === null ? "animate-pulse" : "opacity-70",
                  mine && "opacity-100 ring-2 ring-ink",
                )}
                style={{ left: x(s), width: w(s, e), minWidth: 3 }}
              />
            </Tooltip>
            {o.end === null && ghost(s, o.estimate, o.kind, false)}
          </span>
        );
      })}
      <div aria-hidden className="pointer-events-none absolute -top-1 h-8 w-px bg-ink/70" style={{ left: x(now) }} />
    </div>
  );
}

const DOT: Record<LiveLane["state"], string> = { running: "animate-pulse bg-ok", queued: "bg-warn", done: "bg-ink/30", failed: "bg-bad" };

function LaneInfo({ lane, now }: { lane: LiveLane; now: number }) {
  const r = lane.state === "running" ? eta(Date.parse(lane.start), lane.estimate, now) : null;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[lane.state])} aria-hidden />
        <Link to={lane.detail} className="truncate text-sm font-medium hover:underline">
          {lane.title}
        </Link>
        {r && <span className={cn("num ml-auto shrink-0 text-2xs", r.late ? "text-bad" : "text-ink/50")}>{r.text}</span>}
        {lane.state === "queued" && <span className="ml-auto shrink-0 text-2xs text-ink/50">queued</span>}
        {(lane.state === "done" || lane.state === "failed") && lane.end && <span className="ml-auto shrink-0 text-2xs text-ink/45">ended {fmtDur(now - Date.parse(lane.end))} ago</span>}
      </div>
      {lane.item && (
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-4 text-xs text-ink/60">
          <ItemIcon kind={lane.item.kind} state={lane.item.state} />
          <ItemPeek repo={lane.item.repo} number={lane.item.number}>
            <Link to={itemPath(lane.item.repo, lane.item.number)} className="code shrink-0 text-accent-ink hover:underline">
              #{lane.item.number}
            </Link>
          </ItemPeek>
          <span className="truncate">{lane.item.title}</span>
          {lane.itemCount > 1 && <span className="shrink-0 text-ink/45">+{lane.itemCount - 1}</span>}
        </div>
      )}
      {lane.line && <div className={cn("mt-0.5 truncate pl-4 text-2xs", lane.state === "failed" ? "text-bad" : "text-ink/50")}>{lane.line}</div>}
    </div>
  );
}

/** Ended lanes the server no longer sends that stay on the board at most; past this the oldest go. */
const GONE_MAX = 12;

/**
 * The lanes in the order they first arrived, so a lane never changes place when its job starts or ends. A lane the server stops sending
 * (an ended job that touched no item, or one past the board's time window) stays in its place as ended until the reader comes back to the
 * tab or the page loads again.
 */
function useSteadyLanes(lanes: LiveLane[] | undefined): LiveLane[] {
  const kept = useRef(new Map<string, LiveLane>());
  const latest = useRef(new Set<string>());
  const [pruned, prune] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== "visible") return;
      for (const k of kept.current.keys()) if (!latest.current.has(k)) kept.current.delete(k);
      prune();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  return useMemo(() => {
    const map = kept.current;
    if (lanes) {
      const seen = new Set(lanes.map((l) => l.key));
      latest.current = seen;
      const at = new Date(nowMs()).toISOString();
      for (const [k, l] of map) {
        if (seen.has(k) || (l.state !== "running" && l.state !== "queued")) continue;
        map.set(k, { ...l, state: "done", start: l.state === "queued" ? at : l.start, end: at, estimate: null, ops: l.ops.map((o) => (o.end ? o : { ...o, end: at, estimate: null })) });
      }
      // Map.set keeps an existing key's place; new lanes go to the end.
      for (const l of lanes) map.set(l.key, l);
      const gone = [...map.keys()].filter((k) => !seen.has(k));
      for (const k of gone.slice(0, Math.max(0, gone.length - GONE_MAX))) map.delete(k);
    }
    return [...map.values()];
    // `pruned` re-reads the map after a prune.
  }, [lanes, pruned]);
}

/** One account's card: label, slots in use, its share of the last hour's tokens, calls and 5-hour use. A button for operators. */
function AccountCard({ a, share, picked, onPick }: { a: LiveAccount; share: number; picked: boolean; onPick: (() => void) | null }) {
  const busy = a.running > 0;
  const name = `${a.label}: ${compact(a.tokens)} tokens in ${a.calls} ${a.calls === 1 ? "call" : "calls"}, ${a.running}${a.maxConcurrent !== null ? ` of ${a.maxConcurrent}` : ""} running${a.fiveHourPct !== null ? `, 5-hour use ${Math.round(a.fiveHourPct)}%` : ""}${a.pausedReason ? `, paused: ${a.pausedReason}` : ""}`;
  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <span className={cn("size-2 shrink-0 rounded-full", busy ? "animate-pulse bg-ok" : "bg-ink/30")} aria-hidden />
        <span className="truncate text-xs font-medium">{a.label}</span>
        {a.pausedReason && <span className="shrink-0 rounded bg-warn/15 px-1 text-2xs text-warn">paused</span>}
        <span className="num ml-auto shrink-0 text-2xs text-ink/55">
          {a.running}
          {a.maxConcurrent !== null && `/${a.maxConcurrent}`} running
        </span>
      </span>
      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-ink/[0.08]" aria-hidden>
        <span className={cn("block h-full rounded-full", a.provider === "jev" ? "bg-c2" : "bg-accent")} style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="num mt-1 flex gap-2 text-2xs text-ink/55">
        <span className="font-medium text-ink/80">{compact(a.tokens)} tokens</span>
        <span>{a.calls} {a.calls === 1 ? "call" : "calls"}</span>
        {a.fiveHourPct !== null && <span className={cn("ml-auto", a.pausedReason && "text-warn")}>5h {Math.round(a.fiveHourPct)}%</span>}
      </span>
    </>
  );
  const cls = "block min-w-[11rem] flex-1 rounded-md border px-2.5 py-1.5 text-left";
  const tip = a.pausedReason ?? undefined;
  if (!onPick) return <div className={cn(cls, "border-line")} title={tip} role="group" aria-label={name}>{body}</div>;
  return (
    <button type="button" onClick={onPick} aria-pressed={picked} aria-label={name} title={tip}
      className={cn(cls, "transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-accent-ink", picked ? "border-ink bg-ink/[0.06]" : "border-line")}>
      {body}
    </button>
  );
}

/** Who provides the tokens: the accounts, busiest first, each with its share of the last hour's tokens. */
function Accounts({ accounts, picked, onPick }: { accounts: LiveAccount[]; picked: string | null; onPick: ((key: string) => void) | null }) {
  const total = accounts.reduce((s, a) => s + a.tokens, 0);
  const shown = [...accounts].sort((x, y) => y.running - x.running || y.tokens - x.tokens);
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="mb-1.5 flex items-baseline gap-2 text-2xs text-ink/55">
        <span className="font-medium text-ink/75">Tokens from</span>
        <span className="num">{compact(total)} in the last hour</span>
        {onPick && <span className="ml-auto max-sm:hidden">{picked ? "Showing that account's model calls; press it again to show all" : "Press an account to pick out its model calls"}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {shown.map((a) => (
          <AccountCard key={a.key} a={a} share={total ? a.tokens / total : 0} picked={picked === a.key} onPick={onPick && (() => onPick(a.key))} />
        ))}
      </div>
    </div>
  );
}

const FEED_SHOWN = 5;

/** The latest finished events of the feed; what runs is on the lanes above. */
function LatestEvents() {
  const { data, error } = useQuery("now", (a) => a.now());
  const done = (data?.entries ?? []).filter((e) => e.state !== "running" && e.state !== "queued").slice(0, FEED_SHOWN);
  return (
    <>
      <ErrorLine error={error?.message} />
      {done.length > 0 && (
        <ul className="mt-3 rounded-md border border-line">
          {done.map((e) => (
            <EntryRow key={e.key} entry={e} />
          ))}
        </ul>
      )}
    </>
  );
}

/** The Live board: lanes of running, queued and lately ended work over the last hour and what is expected next, then the latest events. */
export function LiveBoard({ to }: { to: string }) {
  const { data, error } = useQuery("live", (a) => a.live());
  useNow(1000);
  const now = nowMs();
  const lanes = useSteadyLanes(data?.lanes);
  const accounts = data?.accounts ?? [];
  // Only operators get calls tagged with their account, so only they can pick one out.
  const canPick = lanes.some((l) => l.ops.some((o) => o.account));
  const [picked, setPicked] = useState<string | null>(null);
  const pick = canPick ? (key: string) => setPicked((p) => (p === key ? null : key)) : null;
  const pickedLabel = accounts.find((a) => a.key === picked)?.label;
  const running = lanes.filter((l) => l.state === "running");
  // Axis: the last hour (less when nothing is that old), up to the latest expected end.
  const starts = lanes.filter((l) => l.state !== "queued").map((l) => Date.parse(l.start));
  const from = Math.max(now - 60 * 60_000, Math.min(now - 10 * 60_000, ...starts));
  const lateBy = (start: string, e: LiveEstimate | null) => (e ? Date.parse(start) + e.p90 : now);
  const ends = running.flatMap((l) => [lateBy(l.start, l.estimate), ...l.ops.filter((o) => !o.end).map((o) => lateBy(o.start, o.estimate))]);
  const to2 = Math.min(now + 60 * 60_000, Math.max(now + 5 * 60_000, ...ends) + 60_000);
  const step = to2 - from > 50 * 60_000 ? 15 * 60_000 : 5 * 60_000;
  const ticks: number[] = [];
  // A tick too close to "now" would sit under its label.
  for (let t = Math.ceil(from / step) * step; t < to2; t += step) if (Math.abs(t - now) > (to2 - from) * 0.04) ticks.push(t);
  const pct = (t: number) => `${((t - from) / (to2 - from)) * 100}%`;
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <span className="relative flex size-2" aria-hidden>
            {running.length > 0 && <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60" />}
            <span className={cn("relative inline-flex size-2 rounded-full", running.length > 0 ? "bg-ok" : "bg-ink/30")} />
          </span>
          Live
          {running.length > 0 && <span className="text-xs font-normal text-ink/55">{running.length} running</span>}
        </span>
      }
      to={to}
      linkLabel="Full feed"
    >
      <ErrorLine error={error?.message} />
      <span className="sr-only" aria-live="polite">
        {picked && pickedLabel ? `Showing the model calls of ${pickedLabel}` : ""}
      </span>
      {data && lanes.length === 0 && accounts.length > 0 && (
        <div className="overflow-hidden rounded-md border border-line">
          <Accounts accounts={accounts} picked={null} onPick={null} />
        </div>
      )}
      {data && lanes.length === 0 && <p className="border-t border-line py-3 text-sm text-ink/55">Nothing is running or queued.</p>}
      {lanes.length > 0 && (
        <div className="overflow-hidden rounded-md border border-line">
          {accounts.length > 0 && <Accounts accounts={accounts} picked={canPick ? picked : null} onPick={pick} />}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-ink/[0.03] px-3 py-1.5 text-2xs text-ink/55">
            {LEGEND.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={cn("rounded-sm", KIND[k].bg, k === "job" ? "h-1.5 w-3" : "h-2 w-3")} aria-hidden />
                {KIND[k].label}
              </span>
            ))}
          </div>
          <div className="grid md:grid-cols-[minmax(15rem,22rem)_1fr]">
            <div className="border-b border-line max-md:hidden" />
            <div className="relative h-6 border-b border-line max-md:hidden">
              {ticks.map((t) => (
                <span key={t} className="num absolute top-1 -translate-x-1/2 text-2xs text-ink/45" style={{ left: pct(t) }}>
                  {clock(t)}
                </span>
              ))}
              <span className="absolute top-1 -translate-x-1/2 text-2xs font-semibold text-ink" style={{ left: pct(now) }}>
                now
              </span>
            </div>
            {lanes.map((l) => (
              <div key={l.key} className={cn("contents", l.state !== "running" && l.state !== "queued" && "[&>*]:opacity-60")}>
                <div className="px-3 py-2 md:border-b md:border-line">
                  <LaneInfo lane={l} now={now} />
                </div>
                <div className="flex flex-col justify-center border-b border-line px-3 py-2 max-md:pt-0">
                  <Track lane={l} from={from} to={to2} now={now} picked={canPick ? picked : null} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <LatestEvents />
    </Section>
  );
}
