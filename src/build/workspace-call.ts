// A remote call whose session works in a workspace: Claude Code with its own tools off and the `work` MCP server
// (src/build/workspace-relay.ts) beside any other per-lease servers, bound to the workspace so the dashboard routes the
// session's tool calls to it and the job that waits for the call (awaitCall) serves them.
import type { ItemRef } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { ITEM_SERVER } from "../itemtools/index.ts";
import { REFERENCE_SERVER } from "../remote/bundle.ts";
import { enqueueCall } from "../remote/calls.ts";
import type { TaskBundle, Tier } from "../remote/protocol.ts";
import { MCP_PATH, mcpTools } from "../sandbox/agents.ts";
import { BuildError } from "./envs.ts";
import { OWN_CALLS, WORKSPACE_SERVER } from "./workspace-tools.ts";
import { diffStat, LIVE_STATES } from "./workspaces.ts";

/** Servers a workspace session may have beside `workspace`. */
const EXTRA_SERVERS = new Set([ITEM_SERVER, REFERENCE_SERVER]);

export type WorkspaceCallRequest = {
  workspaceId: number;
  promptId: string;
  promptVersion: string;
  model: string;
  tier: Tier;
  effort: TaskBundle["effort"];
  stdin: string;
  /** Replaces Claude Code's system prompt when given. */
  system?: string | null;
  timeoutSeconds: number;
  maxTurns: number;
  items: ItemRef[];
  level?: number;
  maxAttempts?: number;
  /** Other per-lease servers: items, reference (with `referenceRepo`). */
  servers?: string[];
  referenceRepo?: string;
  /** Keep the harness session so a follow-up turn (`parentId`) can continue it. */
  keepSession?: boolean;
  parentId?: number;
};

/** The `claude` arguments of a workspace session: no built-in tools, only the listed MCP servers' tools, allowed without asking. */
export function workspaceClaudeArgs(r: Pick<WorkspaceCallRequest, "model" | "effort" | "maxTurns" | "system" | "keepSession">, servers: string[]): string[] {
  return ["-p", "--model", r.model, "--effort", r.effort, "--output-format", "stream-json", "--verbose", "--tools", "", "--allowedTools", mcpTools(servers).join(","),
    "--permission-mode", "dontAsk", "--permission-prompts", "none", "--restricted", ...(r.system ? ["--system-prompt", r.system] : []),
    "--mcp-config", MCP_PATH, "--strict-mcp-config", "--disable-slash-commands", ...(r.keepSession ? [] : ["--no-session-persistence"]), "--max-turns", String(r.maxTurns)];
}

/**
 * Queues a remote call for a session in workspace `workspaceId` and binds the workspace to it, in one transaction, so no
 * Task Runner can lease the call before its tool calls have a workspace to go to. Refused while another call bound to the
 * workspace is queued or leased, unless it is the new call's parent. Returns the call id; the caller waits with
 * awaitCall, which serves the session's tool calls meanwhile.
 */
export async function queueWorkspaceCall(db: Db, r: WorkspaceCallRequest): Promise<number> {
  const extra = [...new Set(r.servers ?? [])];
  const bad = extra.find((s) => !EXTRA_SERVERS.has(s));
  if (bad) throw new BuildError(400, `a workspace session cannot have the ${bad} server`);
  if (extra.includes(REFERENCE_SERVER) && !r.referenceRepo) throw new BuildError(400, "the reference server needs referenceRepo");
  const servers = [WORKSPACE_SERVER, ...extra].sort();
  return await db.write(async () => {
    const ws = await db.get(db.k.selectFrom("workspaces").select(["id", "remote_call_id"]).where("id", "=", r.workspaceId).where("state", "in", LIVE_STATES));
    if (!ws) throw new BuildError(409, `workspace ${r.workspaceId} is not live`);
    const id = await enqueueCall(db, {
      promptId: r.promptId, promptVersion: r.promptVersion, tier: r.tier, effort: r.effort, askedModel: r.model, items: r.items, level: r.level ?? 2, maxAttempts: r.maxAttempts ?? 1,
      ...(r.parentId !== undefined && { parentId: r.parentId }), ...(r.referenceRepo && extra.includes(REFERENCE_SERVER) && { referenceRepo: r.referenceRepo }),
      bundle: {
        promptId: r.promptId, promptVersion: r.promptVersion, tier: r.tier, effort: r.effort, timeoutSeconds: r.timeoutSeconds, maxTurns: r.maxTurns,
        stdin: r.stdin, system: r.system ?? null, mounts: [], mcpServers: servers, keepSession: r.keepSession === true,
        ...(r.parentId !== undefined && { resume: { parentCallId: r.parentId } }),
        hints: { claude: { args: workspaceClaudeArgs(r, servers) } },
      },
    });
    // Checked after the enqueue: a resumed job adopts its earlier call, which is then the one bound already.
    const bound = ws.remote_call_id;
    if (bound !== null && bound !== id && bound !== r.parentId) {
      const other = await db.get(db.k.selectFrom("remote_calls").select("state").where("id", "=", bound).where("state", "in", ["queued", "leased"]));
      if (other) throw new BuildError(409, `workspace ${ws.id} is in use by call ${bound}, which is ${other.state}`);
    }
    await db.run(db.k.updateTable("workspaces").set({ remote_call_id: id, updated_at: new Date().toISOString() }).where("id", "=", ws.id));
    return id;
  });
}

/** Starts the note a lease adds to a workspace session's prompt; what follows it is replaced at each lease. */
const RESUME_MARK = "\n\n---\nNote from AutoCraft: ";

/**
 * A workspace session's prompt for its next lease: `stdin` without an earlier lease's note, plus a note when an earlier
 * lease of the call already worked in the workspace (its Task Runner was lost): the workspace keeps that work, and the
 * note gives its changes as of the last checkpoint, which the launcher takes when the call goes back to the queue.
 */
export async function resumePrompt(db: Db, callId: number, stdin: string): Promise<string> {
  const mark = stdin.indexOf(RESUME_MARK);
  const prompt = mark < 0 ? stdin : stdin.slice(0, mark);
  const w = await db.get(db.k.selectFrom("workspaces").select(["id", "checkpoint", "checkpoint_at"]).where("remote_call_id", "=", callId).where("state", "in", LIVE_STATES));
  const since = (await db.get(db.k.selectFrom("remote_calls").select("since").where("id", "=", callId)))?.since;
  if (!w || since == null) return prompt;
  const worked = await db.get(db.k.selectFrom("workspace_calls").select("id").where("workspace_id", "=", w.id).where("tool", "not in", OWN_CALLS)
    .where("created_at", ">=", new Date(Number(since)).toISOString()).limit(1));
  if (!worked) return prompt;
  const at = w.checkpoint_at ? `${w.checkpoint_at.slice(11, 16)} UTC` : null;
  const stat = w.checkpoint?.length && at ? `Its changes against the base commit as of ${at} (the last checkpoint):\n${diffStat(w.checkpoint)}\n` : "";
  return `${prompt}${RESUME_MARK}an earlier session on this task was cut off before it finished. The workspace keeps its work, so /work/src may already hold changes, and commands it started may have ended.\n${stat}Check the current state with \`git status\` and \`git diff --stat\` in /work/src before you continue.\n`;
}
