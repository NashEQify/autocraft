// An issue's implementation attempt: its state, plan, questions, model calls, AutoCraft's checks, the change, screenshots and PR.
import type { ReactNode } from "react";
import type { ImplementationCall, ImplementationCheckPart, ImplementationCheckRound, ImplementationQuestion, ItemImplementation } from "../../../api/types";
import { IMPLEMENTATION_STATE } from "../../../lib/status";
import { formatCost } from "../../../lib/trace";
import { useUser } from "../../../shell/UserContext";
import { Badge, type Tone } from "../../../ui/atoms/Badge";
import { TextLink } from "../../../ui/atoms/TextLink";
import { TimeAgo } from "../../../ui/atoms/TimeAgo";
import { DisclosurePanel } from "../../../ui/molecules/DisclosurePanel";
import { Facts } from "../../../ui/molecules/Facts";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { ExpandableText } from "../../../ui/molecules/ExpandableText";
import { RemoteVia } from "../../../ui/molecules/RemoteVia";

const PURPOSE: Record<string, string> = {
  plan: "Plan", start: "Session", retry: "Session, tried again", fresh: "Session, started fresh", findings: "Follow-up on findings", report: "Follow-up for the report", lint: "Follow-up on wording",
};
const OUTCOME: Record<string, [string, Tone]> = {
  queued: ["Waiting for the Task Runner", "neutral"], done: ["Done", "ok"], failed: ["Failed", "bad"], unclaimed: ["Not taken", "warn"], withdrawn: ["Withdrawn", "warn"],
};
const KIND = { bugfix: "Bug fix", feature: "Feature", change: "Change" } as const;
const CHECK = { fmt: "Format", clippy: "Clippy", tests: "Tests" } as const;

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2 px-4 py-4 md:px-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function CheckBadge({ name, p }: { name: string; p: ImplementationCheckPart }) {
  const [text, tone]: [string, Tone] = !p.ran ? ["not run", "neutral"] : p.noVerdict ? ["no verdict", "warn"] : p.findings > 0 ? [`${p.findings} ${p.findings === 1 ? "finding" : "findings"}`, "bad"] : p.exit === 0 || p.exit === null ? ["pass", "ok"] : [`exit ${p.exit}`, "bad"];
  return <Badge tone={tone}>{name}: {text}</Badge>;
}

function CheckRoundRow({ c }: { c: ImplementationCheckRound }) {
  return (
    <li className="space-y-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">Round {c.round}</span>
        <span className="code text-xs text-ink/60">{c.diffStat}</span>
        <TimeAgo iso={c.at} className="text-xs text-ink/50" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CHECK) as (keyof typeof CHECK)[]).map((k) => <CheckBadge key={k} name={CHECK[k]} p={c[k]} />)}
        {c.clean && <Badge tone="ok">Clean</Badge>}
      </div>
      {c.crates.length > 0 && <p className="text-xs text-ink/60">Crates: <span className="code">{c.crates.join(", ")}</span></p>}
      {c.findings.length > 0 && (
        <ul className="space-y-1 text-xs">
          {c.findings.map((f, i) => <li key={i} className="break-words [overflow-wrap:anywhere]"><span className="code text-ink/60">{f.check} {f.file}:{f.line}</span> {f.message}</li>)}
        </ul>
      )}
      {c.notes.map((n, i) => <p key={i} className="text-xs text-ink/60">{n}</p>)}
    </li>
  );
}

function CallRow({ c, staff }: { c: ImplementationCall; staff: boolean }) {
  const [outcome, tone] = c.status === "blocked" ? ["Blocked", "bad" as Tone] : OUTCOME[c.outcome] ?? [c.outcome, "neutral" as Tone];
  const facts = [c.turns !== null && `${c.turns} turns`, c.toolCalls > 0 && `${c.toolCalls} tool calls`, c.shellMs > 0 && `${minutes(c.shellMs)} in the shell`, staff && c.costUsd !== null && formatCost(c.costUsd)].filter(Boolean);
  return (
    <li className="space-y-1 border-t border-line py-2.5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{PURPOSE[c.purpose] ?? c.purpose}</span>
        <Badge tone={tone}>{outcome}</Badge>
        <TimeAgo iso={c.at} className="text-xs text-ink/50" />
        {c.runId !== null && <TextLink to={`/agents/${c.runId}`} className="num text-xs">Run {c.runId}</TextLink>}
      </div>
      {facts.length > 0 && <p className="num text-xs text-ink/60">{facts.join(" · ")}</p>}
      {c.via && <RemoteVia via={c.via} />}
      {c.summary && <p className="break-words text-sm text-ink/80">{c.summary}</p>}
      {c.error && <p className="break-words text-sm text-bad">{c.error}</p>}
    </li>
  );
}

function QuestionRow({ q }: { q: ImplementationQuestion }) {
  return (
    <li className="space-y-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone="warn">{q.audience === "author" ? "Asked the author" : "Asked a maintainer"}</Badge>
        <TimeAgo iso={q.at} className="text-xs text-ink/50" />
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{q.text}</p>
      {q.answer
        ? <p className="whitespace-pre-wrap break-words border-l-2 border-line-strong pl-3 text-sm text-ink/80"><span className="font-medium">{q.answer.by}:</span> {q.answer.text}</p>
        : <p className="text-sm text-ink/55">No answer yet.</p>}
    </li>
  );
}

const shotSrc = (url: string, n: number, what: string): string => {
  if (import.meta.env.VITE_MOCK !== "1") return url;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4f1ea"/><rect x="30" y="30" width="580" height="340" rx="8" fill="#fff" stroke="#c9c2b4"/><text x="50" y="70" font-family="sans-serif" font-size="20" fill="#333">${n}. ${what.replace(/[<&]/g, "")}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

export function ImplementationPanel({ m }: { m: ItemImplementation }) {
  const staff = useUser().role !== "viewer";
  const state = IMPLEMENTATION_STATE[m.state];
  const summary = `${state.label}${m.attempts > 1 ? `, attempt ${m.attempt} of ${m.attempts}` : ""}`;
  return (
    <DisclosurePanel title="Implementation" summary={summary} defaultOpen>
      <div className="divide-y divide-line">
        <Section title="Status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={state.tone}>{state.label}</Badge>
            {m.plan && <Badge>{KIND[m.plan.kind] ?? m.plan.kind}</Badge>}
            {m.plan && <Badge>Size {m.plan.size}</Badge>}
          </div>
          {m.reason && <p className="break-words text-sm text-ink/80">{m.reason}</p>}
          <Facts rows={[
            ["Queued by", m.queuedBy],
            ["Started", <TimeAgo key="s" iso={m.createdAt} />],
            ["Change", m.diffStat && <span key="d" className="code">{m.diffStat}</span>],
            ["Pull request", m.pr && <ItemRef key="p" repo={m.pr.repo} number={m.pr.number} kind="pr" state={m.pr.state} title={m.pr.title} />],
            ["Files", m.pr?.url && <TextLink key="f" href={`${m.pr.url}/files`}>Changed files on GitHub</TextLink>],
            ["Cost", staff && m.costUsd > 0 && <span key="c" className="num">{formatCost(m.costUsd)}</span>],
          ]} />
        </Section>
        {m.plan && (
          <Section title="Plan">
            <p className="break-words text-sm">{m.plan.summary}</p>
            {m.plan.acceptance.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-ink/70">Acceptance</h4>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{m.plan.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}
            {(m.plan.tests.length > 0 || m.plan.app) && (
              <div>
                <h4 className="text-xs font-semibold text-ink/70">Verification</h4>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                  {m.plan.tests.map((t, i) => <li key={i}>{t}</li>)}
                  {m.plan.app && <li>In the app: {m.plan.app}</li>}
                </ul>
              </div>
            )}
            {m.plan.risks.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-ink/70">Risks</h4>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{m.plan.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            {m.plan.markdown && (
              <div>
                <h4 className="text-xs font-semibold text-ink/70">Steps</h4>
                <div className="mt-1 text-sm"><ExpandableText text={m.plan.markdown} markdown limit={400} /></div>
              </div>
            )}
          </Section>
        )}
        {m.questions.length > 0 && <Section title="Questions"><ul>{m.questions.map((q, i) => <QuestionRow key={i} q={q} />)}</ul></Section>}
        {m.calls.length > 0 && <Section title="Model calls"><ul>{m.calls.map((c, i) => <CallRow key={i} c={c} staff={staff} />)}</ul></Section>}
        {m.checks.length > 0 && <Section title="AutoCraft's checks"><ul>{m.checks.map((c, i) => <CheckRoundRow key={i} c={c} />)}</ul></Section>}
        {m.shots.length > 0 && (
          <Section title="Screenshots">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {m.shots.map((s) => (
                <figure key={s.url} className="min-w-0">
                  <a href={shotSrc(s.url, s.n, s.what)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-line bg-sunken hover:border-line-strong">
                    <img src={shotSrc(s.url, s.n, s.what)} alt={`Screenshot ${s.n}: ${s.what}`} width={s.width} height={s.height} loading="lazy" className="block h-auto w-full" />
                  </a>
                  <figcaption className="mt-1 break-words text-xs text-ink/60">{s.n}. {s.what}</figcaption>
                </figure>
              ))}
            </div>
          </Section>
        )}
      </div>
    </DisclosurePanel>
  );
}
