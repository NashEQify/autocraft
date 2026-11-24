// Work queue: running now, waiting with the reason, the merge queue (batches, next merges, hold and release), the model call
// queue and recently merged. Every list updates in place from the live topics.
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { t } from "../../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../../api/client";
import { usePageProject } from "../../../api/scope";
import type { ItemKind, ItemState, ModelQueue, NextMerge, QueueBatch } from "../../../api/types";
import { batchPath } from "../../../lib/links";
import { nowMs } from "../../../lib/format";
import { useNow } from "../../../lib/useNow";
import { useWrite } from "../../../lib/hooks";
import { canRun } from "../../../registry/permissions";
import type { ViewProps } from "../../../registry/types";
import { useUser } from "../../../shell/UserContext";
import { Button } from "../../../ui/atoms/Button";
import { ErrorLine } from "../../../ui/atoms/ErrorLine";
import { Pending } from "../../../ui/atoms/Pending";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { QueueRow as ModelCallRow } from "../../agents/queue";
import { ConfirmButton } from "../../admin/parts";
import { RecentlyMerged } from "../../queue/RecentlyMerged";
import { usePage } from "../../queue/usePage";

function Part({ title, count, empty, children, aside }: { title: string; count: number; empty: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="mt-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink/70">
          {title} <span className="num font-normal">({count})</span>
        </h2>
        {aside}
      </div>
      {count ? <ul className="divide-y divide-line rounded-lg border border-line bg-panel">{children}</ul> : <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink/70">{empty}</p>}
    </section>
  );
}

function Row({ item, line, action }: { item: { repo: string; number: number; kind?: ItemKind | null; state?: ItemState | null; title: string | null }; line: ReactNode; action?: ReactNode }) {
  return (
    <li className="relative flex items-start gap-3 px-3 py-2.5 hover:bg-ink/[0.025]">
      <div className="min-w-0 flex-1">
        <ItemRef repo={item.repo} number={item.number} kind={item.kind} state={item.state} title={item.title} stretch />
        <p className="mt-0.5 text-sm text-ink/80">{line}</p>
      </div>
      {action && <div className="relative z-10 shrink-0">{action}</div>}
    </li>
  );
}

function HoldButton({ m, held }: { m: Pick<NextMerge, "repo" | "number">; held: boolean }) {
  const api = useApi();
  const write = useWrite();
  if (!canRun(useUser(), m.repo)) return null;
  const control = held ? "release-merge" : "hold-merge";
  return (
    <span className="flex flex-col items-end gap-1">
      <Button className="h-11" loading={write.busy === control} onClick={() => void write.run(control, () => api.controls.run({ control, item: { repo: m.repo, number: m.number } }).then((r) => { if (!r.ok) throw new Error(r.line); }))}>
        {held ? t("Release") : t("Hold")}
      </Button>
      <ErrorLine error={write.error} className="text-2xs" />
    </span>
  );
}

function StopBatch({ b }: { b: QueueBatch }) {
  const api = useApi();
  const write = useWrite();
  if (!canRun(useUser(), b.repo)) return null;
  return (
    <span className="flex flex-col items-end gap-1">
      <ConfirmButton idle="secondary" label={t("Stop batch")} confirmLabel={t("Confirm stop batch")} loading={write.busy === "stop"} onConfirm={() => void write.run("stop", () => api.queueControl.stopBatch(b.id))} />
      <ErrorLine error={write.error} className="text-2xs" />
    </span>
  );
}

const key = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

function MergeQueue({ project }: { project: string | null }) {
  const { pages, error } = usePage("merge", project ?? "pipeline", undefined);
  const first = pages?.[0];
  const held = useMemo(() => new Set((pages?.flatMap((p) => p.mergeRows) ?? []).filter((r) => r.held).map(key).concat((first?.batches ?? []).flatMap((b) => b.prs).filter((r) => (r as { held?: boolean }).held).map(key))), [pages, first]);
  if (!first) return <Pending error={error} />;
  const next = first.nextMerges;
  const batchKeys = new Set(first.batches.flatMap((b) => b.prs.map(key)));
  const inLine = next.filter((m) => !batchKeys.has(key(m)));
  const queued = first.pending ?? [];
  return (
    <section aria-label={t("Merge queue")} className="flex flex-col gap-1">
      <h2 className="mt-2 text-sm font-semibold text-ink/70">{t("Merge queue")}</h2>
      <div className="divide-y divide-line rounded-lg border border-line bg-panel">
        {first.batches.map((b) => (
          <div key={b.id}>
            <div className="flex items-start gap-3 px-3 py-2.5 text-sm">
              <p className="min-w-0 flex-1">
                <Link to={batchPath(b.id)} className="font-semibold text-accent-ink hover:underline">
                  {t("Batch {id}", { id: `#${b.id}` })}
                </Link>{" "}
                <span className="text-ink/70">
                  {b.repo} · {b.size === 1 ? t("1 PR") : t("{n} PRs", { n: b.size })}
                </span>
              </p>
              <StopBatch b={b} />
            </div>
            <ul className="divide-y divide-line border-t border-line">
              {b.prs.map((r) => (
                <Row key={key(r)} item={{ ...r, kind: "pr" as const, state: "open" as const }} line={held.has(key(r)) ? t("Held out of the merge") : t("Merges with the batch when CI is green")} action={<HoldButton m={r} held={held.has(key(r))} />} />
              ))}
            </ul>
          </div>
        ))}
        <p className="px-3 pt-2 text-sm font-semibold">
          {t("Next merges")} <span className="num font-normal text-ink/70">({inLine.length})</span>
        </p>
        {inLine.length ? (
          <ul className="divide-y divide-line">
            {inLine.map((m, i) => (
              <Row key={key(m)} item={{ ...m, kind: "pr" as const, state: "open" as const }} line={<><span className="num mr-1.5 text-ink/60">{i + 1}.</span>{m.label}</>} action={<HoldButton m={m} held={m.waitsFor === "held" || held.has(key(m))} />} />
            ))}
          </ul>
        ) : (
          <p className="px-3 pb-2 text-sm text-ink/70">{t("Nothing in line.")}</p>
        )}
        {queued.length > 0 && (
          <>
            <p className="px-3 pt-2 text-sm font-semibold">
              {t("Queued, not reviewed yet")} <span className="num font-normal text-ink/70">({queued.length})</span>
            </p>
            <ul className="divide-y divide-line">
              {queued.map((r) => (
                <Row key={key(r)} item={{ ...r, kind: r.kind, state: "open" as const }} line={r.implement ? `${r.implement.text}${r.implement.wait ? ` · ${r.implement.wait}` : ""}` : r.next ?? r.step} action={r.kind === "pr" ? <HoldButton m={r} held={r.held} /> : undefined} />
              ))}
            </ul>
          </>
        )}
        <details className="px-3 py-1 text-sm">
          <summary className="flex h-11 cursor-pointer items-center font-semibold">{t("Merged recently")}</summary>
          <RecentlyMerged repo={project} />
        </details>
      </div>
      <ErrorLine error={error?.message} />
    </section>
  );
}

function ModelCalls({ user }: { user: ViewProps["user"] }) {
  const q = useQuery<ModelQueue>("model-queue", (a) => a.modelQueue.get());
  const write = useWrite();
  const base = useMemo(() => nowMs(), [q.data]);
  const now = useNow(q.data?.calls.length ? 30_000 : undefined);
  const calls = q.data?.calls ?? [];
  return (
    <section aria-label={t("Model calls waiting")} className="flex flex-col gap-1">
      <h2 className="mt-2 text-sm font-semibold text-ink/70">
        {t("Model calls waiting")} <span className="num font-normal">({calls.length})</span>
      </h2>
      <ErrorLine error={q.error?.message ?? write.error} />
      {calls.length ? (
        <ul className="rounded-lg border border-line bg-panel">
          {calls.map((c) => (
            <ModelCallRow key={c.id} c={c} user={user} waited={c.waitedMs + Math.max(0, now - base)} write={write} />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink/70">{t("No model call is waiting.")}</p>
      )}
    </section>
  );
}

export function QueueView({ user }: ViewProps) {
  const project = usePageProject();
  const { data, error } = useQuery("next-page", (a) => a.next());
  if (!data) return <Pending error={error} />;
  const running = data.steps.flatMap((s) => s.items.filter((i) => i.inFlight).map((i) => ({ i, step: s.title })));
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[768px] flex-col gap-3 px-4 pb-10 pt-5 md:px-6">
        <h1 className="text-xl font-semibold">{t("Work queue")}</h1>
        <Part title={t("Running now")} count={running.length} empty={t("Nothing runs right now.")}>
          {running.map(({ i, step }) => (
            <Row key={`${key(i)}:${step}`} item={i} line={step} />
          ))}
        </Part>
        <Part title={t("Waiting")} count={data.waitingTotal} empty={t("Nothing waits.")}>
          {data.waiting.map((w) => (
            <Row key={key(w)} item={w} line={<>{w.wait}{w.why ? <span className="text-ink/70"> · {w.why}</span> : null}</>} />
          ))}
        </Part>
        <MergeQueue project={project} />
        <ModelCalls user={user} />
      </div>
    </div>
  );
}
