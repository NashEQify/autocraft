// The warm caches on the Build environments page: the warm producer's state per repository, what each node holds, where
// the runner placed each key and the crate mirror's git allowlist (GET /api/envs/caches). One tab at a time, kept in the URL.
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowsClockwiseIcon, CheckCircleIcon, CircleDashedIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { CacheFreshness, CacheNode, CachePlaced, CacheReport, CacheRepo, TaskState } from "../../api/types";
import { memSize } from "../../lib/format";
import { useUrlState } from "../../lib/hooks";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { cn } from "../../ui/cn";

const FRESHNESS: Record<CacheFreshness, [string, Tone]> = {
  current: ["Up to date", "ok"],
  behind: ["Behind main", "warn"],
  image: ["Old toolchain image", "warn"],
  never: ["Not built", "neutral"],
};
const COVERAGE: Record<CacheRepo["coverage"], string> = { pipeline: "Pipeline repo", added: "Added by an operator", excluded: "Excluded", none: "Not covered" };
const TASK: Record<TaskState, [string, Tone]> = {
  queued: ["Queued", "neutral"], claimed: ["Starting", "accent"], running: ["Running", "accent"], done: ["Done", "ok"], failed: ["Failed", "bad"], cancelled: ["Cancelled", "neutral"], lost: ["Lost", "bad"],
};

const short = (sha: string) => sha.slice(0, 8);
const size = (bytes: number) => (bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : memSize(bytes));
const name = (x: { key: string; repo: string | null }) => x.repo ?? x.key;

function Sha({ sha }: { sha: string }) {
  return <span className="code whitespace-nowrap" title={sha}>{short(sha)}</span>;
}

/** Key-value facts on one wrapping line, `·` between them. */
function Facts({ children }: { children: ReactNode[] }) {
  const shown = children.filter(Boolean);
  return (
    <p className="num mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-ink/60">
      {shown.map((c, i) => (
        <span key={i} className="whitespace-nowrap">{i > 0 && <span aria-hidden className="mr-1.5 text-ink/35">·</span>}{c}</span>
      ))}
    </p>
  );
}

function RepoRow({ r }: { r: CacheRepo }) {
  const [label, tone] = FRESHNESS[r.freshness];
  return (
    <li className="border-t border-line px-4 py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="code text-sm font-semibold">{r.repo}</span>
        <Badge tone={tone}>{label}</Badge>
        {r.coverage !== "pipeline" && <Badge>{COVERAGE[r.coverage]}</Badge>}
      </div>
      <Facts>
        {[
          r.published ? <>Published <Sha sha={r.published.headSha} />{r.published.endedAt && <> <TimeAgo iso={r.published.endedAt} /></>}</> : "Nothing published",
          r.bytes ? size(r.bytes) : null,
          r.published ? `on ${r.nodes} of ${r.of} nodes` : null,
          <>Warm target <span className="code">{r.warmTarget}</span>{r.warmTargetSource === "operator" ? " (set by an operator)" : ""}</>,
          r.freshness === "behind" && r.head ? <>main <Sha sha={r.head} /></> : null,
        ]}
      </Facts>
      {r.last ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="text-ink/60">Last warm build</span>
          <Badge tone={TASK[r.last.state][1]}>{TASK[r.last.state][0]}</Badge>
          <Link to={`/envs/${r.last.id}${location.search}`} className="num text-accent-ink hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
            Task {r.last.id}
          </Link>
          {r.last.endedAt && <TimeAgo iso={r.last.endedAt} className="num text-ink/60" />}
          {r.last.summary && <span className={cn("min-w-0 basis-full break-words", r.last.state === "failed" ? "code text-bad" : "text-ink/60")}>{r.last.summary}</span>}
        </div>
      ) : (
        <p className="mt-1 text-xs text-ink/55">No warm build yet</p>
      )}
    </li>
  );
}

/** Disk use as a bar with its numbers beside it. */
function DiskBar({ fs }: { fs: NonNullable<CacheNode["fs"]> }) {
  const full = fs.usedPct >= 80;
  return (
    <div className="mt-1 flex items-center gap-2 text-xs">
      <span className="h-2 w-24 shrink-0 overflow-hidden rounded-sm bg-ink/[0.09]" role="img" aria-label={`Disk ${fs.usedPct}% used`}>
        <span className={cn("block h-full", full ? "bg-warn" : "bg-c1")} style={{ width: `${Math.min(100, fs.usedPct)}%` }} />
      </span>
      <span className={cn("num", full ? "text-warn" : "text-ink/60")}>
        Disk {fs.usedPct}% of {size(fs.sizeBytes)}
      </span>
    </div>
  );
}

function NodeRow({ n }: { n: CacheNode }) {
  return (
    <li className="border-t border-line px-4 py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="code text-sm font-semibold">{n.node}</span>
        {n.fresh ? <Badge tone="ok">Reporting</Badge> : <Badge tone="warn" icon={<WarningIcon aria-hidden />}>Stale</Badge>}
        {n.error && <Badge tone="bad">Agent error</Badge>}
        <span className="num text-xs text-ink/60">updated <TimeAgo iso={n.updated} /></span>
      </div>
      {n.error && <p className="code mt-0.5 break-words text-xs text-bad">{n.error}</p>}
      {n.fs && <DiskBar fs={n.fs} />}
      {n.warmBytes && (
        <p className="num mt-0.5 text-xs text-ink/60">
          Warm {size(n.warmBytes.current)}{n.warmBytes.grace > 0 && ` + ${size(n.warmBytes.grace)} replaced`}
        </p>
      )}
      {n.keys.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-xs" aria-label={`Held on ${n.node}`}>
          {n.keys.map((k) => (
            <li key={k.key} className="flex flex-wrap items-center gap-x-1.5">
              <span className="code">{name(k)}</span>
              <span className="num text-ink/60"><Sha sha={k.commit} /> · {size(k.bytes)} · synced <TimeAgo iso={k.synced} /></span>
              {!k.newest && <Badge tone="warn">Older version</Badge>}
              {k.placed === false && <Badge>Not placed here</Badge>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-ink/55">Holds no warm version</p>
      )}
      {n.pending.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs" aria-label={`Pending on ${n.node}`}>
          {n.pending.map((p) => (
            <li key={p.key} className="break-words">
              <span className="font-medium text-warn">Pending</span> <span className="code">{name(p)}</span>: <span className="text-ink/70">{p.why}</span>
            </li>
          ))}
        </ul>
      )}
      {n.badBlobs.map((b) => (
        <p key={b.key} className="mt-0.5 text-xs">
          <span className="font-medium text-bad">Bad blobs</span> <span className="code">{name(b)}</span>: <span className="num">{b.count}</span>
        </p>
      ))}
    </li>
  );
}

const HOLDS = {
  newest: { icon: CheckCircleIcon, text: "holds it", cls: "text-ok" },
  older: { icon: ArrowsClockwiseIcon, text: "older version", cls: "text-warn" },
  none: { icon: CircleDashedIcon, text: "not yet", cls: "text-ink/55" },
} as const;

function PlacedRow({ p }: { p: CachePlaced }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 first:border-t-0">
      <span className="code min-w-32 text-sm font-semibold">{name(p)}</span>
      {p.nodes.length === 0 && <span className="text-xs text-warn">No node has room</span>}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label={`Nodes for ${name(p)}`}>
        {p.nodes.map((n) => {
          const h = HOLDS[n.holds];
          return (
            <li key={n.node} className="inline-flex items-center gap-1">
              <h.icon aria-hidden className={h.cls} />
              <span className="code">{n.node}</span>
              <span className={h.cls}>{h.text}</span>
              {!n.fresh && <span className="text-warn">(stale)</span>}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

type Tab = "repos" | "nodes" | "placement" | "mirror";

function Tabs({ tabs, value, onChange }: { tabs: { id: Tab; label: string; count: number; attention: boolean }[]; value: Tab; onChange: (t: Tab) => void }) {
  const refs = useRef(new Map<Tab, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : undefined;
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };
  return (
    <div role="tablist" aria-label="Caches" className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-2" onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => void (el ? refs.current.set(t.id, el) : refs.current.delete(t.id))}
          id={`caches-tab-${t.id}`}
          role="tab"
          aria-selected={value === t.id}
          aria-controls="caches-panel"
          tabIndex={value === t.id ? 0 : -1}
          data-active={value === t.id}
          className="chip max-md:h-11"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          <span className="num opacity-60">{t.count}</span>
          {t.attention && <WarningIcon className="text-warn" aria-label="needs attention" />}
        </button>
      ))}
    </div>
  );
}

function Body({ r, tab }: { r: CacheReport; tab: Tab }) {
  if (tab === "repos") {
    return (
      <>
        {r.writer ? (
          <p className="num px-4 pt-2 text-xs text-ink/60">Warm builds run on {r.writer.env} with <span className="code break-all">{r.writer.image ?? "no toolchain image"}</span></p>
        ) : (
          <p className="px-4 pt-2 text-xs text-warn">No enabled environment builds warm versions</p>
        )}
        {r.repos.length ? <ul aria-label="Warm state by repository">{r.repos.map((x) => <RepoRow key={x.repo} r={x} />)}</ul> : <p className="p-4 text-sm text-ink/55">No repository has warm builds.</p>}
      </>
    );
  }
  if (tab === "nodes") return r.nodes.length ? <ul aria-label="Warm caches by node">{r.nodes.map((n) => <NodeRow key={n.node} n={n} />)}</ul> : <p className="p-4 text-sm text-ink/55">No node reports a warm status.</p>;
  if (tab === "placement") {
    return (
      <>
        {r.placementNote && <ErrorLine error={r.placementNote} className="px-4 pt-2" />}
        {r.placement ? (
          r.placement.length ? <ul aria-label="Placement by key">{r.placement.map((p) => <PlacedRow key={p.key} p={p} />)}</ul> : <p className="p-4 text-sm text-ink/55">No key is placed.</p>
        ) : (
          <p className="p-4 text-sm text-ink/60">{r.readAt ? "No placement: every node keeps every key warm-assign lists." : "No node status has been read."}</p>
        )}
      </>
    );
  }
  const m = r.mirror!;
  return (
    <div className="px-4 py-2.5">
      <Facts>
        {[<>Read <TimeAgo iso={m.readAt} /></>, m.envs.length ? `Used by ${m.envs.join(", ")}` : "No environment uses it"]}
      </Facts>
      <ErrorLine error={m.error} className="mt-1" />
      {m.allowlist && (
        <>
          <h3 className="mt-2 text-xs font-semibold">Git repositories served</h3>
          {m.allowlist.length ? (
            <ul className="mt-1 space-y-0.5 text-xs">{m.allowlist.map((x) => <li key={x} className="code">{x}</li>)}</ul>
          ) : (
            <p className="mt-1 text-xs text-ink/55">None</p>
          )}
        </>
      )}
    </div>
  );
}

export function Caches() {
  const q = useQuery<CacheReport>("envs-caches", (a) => a.envs.caches(), { pollMs: 60_000 });
  const { state, update } = useUrlState();
  const r = q.data;
  const tabs = r
    ? ([
        { id: "repos", label: "Repositories", count: r.repos.length, attention: r.repos.some((x) => x.last?.state === "failed" || x.freshness === "behind" || x.freshness === "image") },
        { id: "nodes", label: "Nodes", count: r.nodes.length, attention: r.nodes.some((n) => !n.fresh || n.error || n.badBlobs.length) },
        { id: "placement", label: "Placement", count: r.placement?.length ?? 0, attention: !!r.placementNote || !!r.placement?.some((p) => !p.nodes.length || p.nodes.some((n) => !n.fresh)) },
        ...(r.mirror ? [{ id: "mirror" as const, label: "Crate mirror", count: r.mirror.allowlist?.length ?? 0, attention: !!r.mirror.error }] : []),
      ] satisfies { id: Tab; label: string; count: number; attention: boolean }[])
    : [];
  const asked = state.caches as Tab | undefined;
  const tab: Tab = tabs.some((t) => t.id === asked) ? asked! : "repos";
  // Without a cluster and warm builds there is nothing to show.
  if (r && !r.readAt && !r.repos.length && !r.mirror) return null;
  return (
    <Block flush title="Caches" aside={r?.readAt ? <span className="num">nodes read <TimeAgo iso={r.readAt} /></span> : undefined}>
      <ErrorLine error={q.error?.message} className="p-4" />
      {r && (
        <>
          <Tabs tabs={tabs} value={tab} onChange={(t) => update({ caches: t === "repos" ? null : t })} />
          <div id="caches-panel" role="tabpanel" aria-labelledby={`caches-tab-${tab}`}>
            <Body r={r} tab={tab} />
          </div>
        </>
      )}
    </Block>
  );
}
