// Model calls and rates on fake data: twelve runs in flight and a few hundred finished ones.
import { traceRunDetail } from "./traceMock";
import type { Api } from "../client";
import type { AgentRun, AgentRunDetail, Rates } from "../types";
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
          (r) => (!f.state || f.state === "recent" || r.state === f.state) && (!f.step || r.step === f.step) && (!f.repo || r.items.some((i) => i.repo === f.repo)) && (!f.cursor || r.id < Number(f.cursor)),
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
        const d: AgentRunDetail = { ...r, prompt: old ? null : PROMPT(r), output: old || r.state === "running" ? null : OUTPUT, error: r.state === "failed" ? "claude -p exited after 600 s without output" : null, tools: [] };
        return wait(d);
      },
    },
    rates: (w) => wait(rates(w), 80),
  };
}
