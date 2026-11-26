// Model calls and rates on fake data: twelve runs in flight and a few hundred finished ones.
import { traceRunDetail } from "./traceMock";
import type { Api } from "../client";
import type { AgentRun, AgentRunDetail, Rates, RefusalBreakdown, RefusalGroup, RefusalWindow } from "../types";
import { NOW, REPOS } from "./fixtures";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

let seedN = 7;
const rnd = () => ((seedN = (seedN * 48271) % 2147483647) / 2147483647);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

const STEPS = [
  { step: "fixup", stage: 6, title: "Fix-up pull requests", promptId: "fixup.patch", provider: "claude" as const, model: "opus" },
  { step: "opus-review", stage: 5, title: "Review pull requests", promptId: "review.opus", provider: "claude" as const, model: "opus" },
  { step: "classify-new", stage: 2, title: "Classify new and changed items", promptId: "classify.haiku", provider: "claude" as const, model: "haiku" },
  { step: "classify-new", stage: 2, title: "Classify new and changed items", promptId: "classify.jev", provider: "jev" as const, model: "jev" },
];

const OUTPUT = `{"verdicts":[{"repo":"photocraft","number":2214,"verdict":"take","reason":"Small, tested fix."},{"repo":"photocraft","number":2230,"verdict":"hold","reason":"Needs a rebase; touches the export path."}]}`;
const PROMPT = (r: AgentRun) =>
  `You are reviewing ${r.itemCount} item${r.itemCount === 1 ? "" : "s"} for the ${r.step} step.\n\n${r.items.map((i) => `## ${i.repo}#${i.number}\nTitle: example title for ${i.repo}#${i.number}\nBody: (trimmed) ...`).join("\n\n")}\n\nAnswer with JSON only.`;

const shown = (i: { repo: string; number: number }): AgentRun["items"][number] => ({
  ...i, kind: i.number % 3 === 0 ? "issue" : "pr", state: i.number % 5 === 0 ? "closed" : "open", title: `Example title for ${i.repo}#${i.number}`,
});

function makeRun(id: number, startedMsAgo: number, running: boolean): AgentRun {
  const s = pick(STEPS);
  const n = s.step === "classify-new" ? 1 + Math.floor(rnd() * 30) : s.step === "opus-review" ? 1 + Math.floor(rnd() * 4) : 1 + Math.floor(rnd() * 8);
  const repo = pick(REPOS);
  const items = Array.from({ length: Math.min(n, 50) }, (_, i) => ({ repo: i % 3 === 2 ? pick(REPOS) : repo, number: 1000 + Math.floor(rnd() * 1400) })).map(shown);
  const failed = !running && rnd() < 0.08;
  const dur = (20 + rnd() * 240) * 1000;
  const tokens = Math.round(n * (1500 + rnd() * 3000));
  return {
    id, jobId: 40 + Math.floor(id / 40) % 9, step: s.step, stage: s.stage, promptId: s.promptId, promptVersion: `v${1 + (id % 3)}-${(id * 2654435761 % 0xffffff).toString(16).padStart(6, "0")}`,
    provider: s.provider, model: s.model, costUsd: running ? null : Math.round(tokens * 0.6) / 100_000,
    items, itemCount: n, state: running ? "running" : failed ? "failed" : "done",
    startedAt: iso(startedMsAgo), endedAt: running ? null : iso(startedMsAgo - dur),
    inputTokens: tokens, outputTokens: running ? Math.round(tokens * 0.03) : Math.round(tokens * 0.08),
    cacheReadTokens: s.provider === "jev" ? null : Math.round(tokens * 0.5), cacheWriteTokens: s.provider === "jev" ? null : Math.round(tokens * 0.1),
    ...(s.provider === "claude" && { via: { login: pick(["kiri-n", "ochre-fox", "mara-t"]), harness: pick(["claude", "claude", "codex"]), model: s.model === "opus" ? "claude-opus-4-5" : "claude-haiku-4-5" } }),
    summary: running ? null : failed ? "timeout after 600 s" : s.step === "classify-new" ? `${n} classified` : `${Math.max(0, n - 1)} take, ${Math.min(1, n)} hold`,
  };
}

const RUNNING: AgentRun[] = Array.from({ length: 12 }, (_, i) => makeRun(5000 + i, (1 + i * 1.7) * MIN + rnd() * 30_000, true));
RUNNING[0]!.itemCount = 64;
RUNNING[0]!.items = Array.from({ length: 50 }, (_, i) => ({ repo: REPOS[i % REPOS.length]!, number: 1100 + i * 7 })).map(shown);
RUNNING[0]!.step = "classify-new";
RUNNING[0]!.promptId = "classify.haiku";
RUNNING[0]!.model = "haiku";
const RECENT: AgentRun[] = Array.from({ length: 360 }, (_, i) => makeRun(4999 - i, 2 * MIN + i * 4.2 * MIN + rnd() * MIN, false));

// Calls a model's safety filter refused: the refused run sits just after (older than) the run that retried it.
const REFUSED_ERROR = "helper: model error API Error: Opus's safeguards flagged this message as potentially violating our usage policy.";
function refuse(i: number, o: { promptId: string; step: string; repo: string; login: string; retry: "done" | "failed" | "refused" | null }) {
  const r = RECENT[i]!;
  const via = { login: o.login, harness: "claude", model: "claude-opus-4-5" };
  Object.assign(r, { promptId: o.promptId, step: o.step, model: "opus", provider: "claude", state: "failed", via, items: [shown({ repo: o.repo, number: 1300 + i })], itemCount: 1 });
  r.summary = o.retry === null ? `refused by opus on ${o.login}'s Task Runner` : `refused by opus on ${o.login}'s Task Runner; retried on another Task Runner`;
  if (o.retry === null) {
    r.refusal = { outcome: "failed", retry: null };
    return;
  }
  const next = RECENT[i - 1]!;
  const other = o.login === "kiri-n" ? "ochre-fox" : "kiri-n";
  Object.assign(next, { promptId: o.promptId, step: o.step, model: "opus", provider: "claude", items: r.items, itemCount: 1, via: { ...via, login: other }, state: o.retry === "done" ? "done" : "failed" });
  next.summary = o.retry === "refused" ? `refused by opus on ${other}'s Task Runner` : o.retry === "done" ? "1 take" : "timeout after 600 s";
  if (o.retry === "refused") next.refusal = { outcome: "failed", retry: null };
  r.refusal = { outcome: "retried", retry: { id: next.id, state: next.state } };
}
refuse(4, { promptId: "review.opus", step: "opus-review", repo: REPOS[1]!, login: "kiri-n", retry: "done" });
refuse(9, { promptId: "premerge.opus", step: "premerge", repo: REPOS[1]!, login: "ochre-fox", retry: null });
refuse(21, { promptId: "review.opus", step: "opus-review", repo: REPOS[2]!, login: "kiri-n", retry: "refused" });
refuse(48, { promptId: "cifix.patch", step: "cifix", repo: REPOS[0]!, login: "ochre-fox", retry: "done" });
refuse(130, { promptId: "premerge.opus", step: "premerge", repo: REPOS[1]!, login: "kiri-n", retry: null });

const WINDOW_MS: Record<RefusalWindow, number> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };
const inWindow = (r: AgentRun, w: RefusalWindow | undefined) => !w || NOW - Date.parse(r.startedAt) <= WINDOW_MS[w];

function refusals(window: RefusalWindow): RefusalBreakdown {
  const runs = RECENT.filter((r) => r.refusal && inWindow(r, window));
  const by = (key: (r: AgentRun) => string | null): RefusalGroup[] => {
    const m = new Map<string | null, RefusalGroup>();
    for (const r of runs) {
      const g = m.get(key(r)) ?? m.set(key(r), { key: key(r), n: 0, failed: 0 }).get(key(r))!;
      g.n++;
      if (r.refusal!.outcome === "failed") g.failed++;
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };
  return {
    window, total: runs.length, failed: runs.filter((r) => r.refusal!.outcome === "failed").length, capped: false,
    byPrompt: by((r) => r.promptId), byRepo: by((r) => r.items[0]?.repo ?? null), byModel: by((r) => r.via?.model ?? r.model), byLogin: by((r) => r.via?.login ?? null),
  };
}

function rates(window: "24h" | "7d"): Rates {
  const hourly = window === "24h";
  const n = hourly ? 24 : 7;
  const step = hourly ? HOUR : 24 * HOUR;
  const t = (i: number) => iso((n - 1 - i) * step);
  const stages = [
    ["classify-new", "Classify new and changed items", 30], ["fixup", "Fix-up pull requests", 6], ["opus-review", "Review pull requests", 9], ["merge", "Merge queued pull requests", 1.5],
  ].map(([s, title, base]) => ({
    step: s as string, title: title as string,
    buckets: Array.from({ length: n }, (_, i) => {
      const night = hourly && (i < 6 || i > 21) ? 0.3 : 1;
      const items = Math.round((base as number) * (hourly ? 1 : 22) * (0.4 + rnd()) * night);
      const runs = Math.max(items ? 1 : 0, Math.round(items / 6));
      return { t: t(i), items, runs, failed: rnd() < 0.15 ? 1 + Math.floor(rnd() * 2) : 0 };
    }),
  }));
  return { window, bucket: hourly ? "hour" : "day", stages };
}

export function createAgentsMock(): Pick<Api, "agents" | "rates"> {
  return {
    agents: {
      list(f) {
        if (f.state === "running") return wait({ runs: RUNNING.filter((r) => (!f.step || r.step === f.step)), nextCursor: null });
        const rows = RECENT.filter(
          (r) => (!f.state || f.state === "recent" || r.state === f.state) && (!f.step || r.step === f.step) && (!f.repo || r.items.some((i) => i.repo === f.repo)) && (!f.cursor || r.id < Number(f.cursor))
            && (!f.refused || (!!r.refusal && inWindow(r, f.window))),
        );
        const limit = f.limit ?? 50;
        const runs = rows.slice(0, limit);
        return wait({ runs, nextCursor: rows.length > limit ? String(runs[runs.length - 1]!.id) : null }, 80);
      },
      get(id) {
        if (id >= 9001 && id < 9100) {
          const running = id === 9005;
          const d: AgentRunDetail = {
            ...RECENT[0]!, id, step: "security-scan", promptId: id === 9001 ? "security.model" : id === 9003 ? "security.verify" : "security.area", model: "opus", jobId: 12040, items: [], itemCount: 0,
            state: running ? "running" : "done", endedAt: running ? null : RECENT[0]!.endedAt, summary: null, error: null,
            prompt: "You are a senior application security engineer auditing one area of a desktop application, working from a read-only checkout.\n\nArea: doc-io\nPaths: crates/doc-io/src\n\nList findings with file and line for every claim.",
            output: running ? null : "Read crates/doc-io/src/open.rs and chunk.rs.\n\n{\"findings\": [{\"title\": \"Chunk length in document files is trusted when copying into the read buffer\", \"severity\": \"high\", \"refs\": [{\"path\": \"crates/doc-io/src/open.rs\", \"line\": 212}]}]}",
            tools: [],
          };
          return wait(d);
        }
        const r = [...RUNNING, ...RECENT].find((x) => x.id === id);
        const traced = r ? null : traceRunDetail(id);
        if (traced) return wait(traced);
        if (!r) throw new Error(`no agent run ${id}`);
        const old = NOW - Date.parse(r.startedAt) > 90 * 24 * HOUR || id < 4850;
        const error = r.refusal ? (r.refusal.outcome === "failed" ? `refused by the model's safety filter: ${r.summary!.slice("refused by ".length)}; no other Task Runner or tier could take the call. ${REFUSED_ERROR}` : REFUSED_ERROR)
          : r.state === "failed" ? "claude -p exited after 600 s without output" : null;
        const d: AgentRunDetail = { ...r, prompt: old ? null : PROMPT(r), output: old || r.state === "running" || r.refusal ? null : OUTPUT, error, tools: [] };
        return wait(d);
      },
      refusals: (w) => wait(refusals(w), 80),
    },
    rates: (w) => wait(rates(w), 80),
  };
}
