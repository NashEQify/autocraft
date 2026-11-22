// The `workspace` MCP server's tools. A session's tool call is a queued workspace_calls row; the job that owns the
// workspace runs it here, in the pod through `ws`, and writes the result to the row. The dashboard only relays
// (src/build/workspace-relay.ts).
import type { Db } from "../db/index.ts";
import type { KubeApi } from "./kube-api.ts";

export const WORKSPACE_SERVER = "workspace";

/** One image of a tool result: base64 PNG, JPEG, GIF or WebP, already scaled in the pod. */
export type ToolImage = { data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" };
/** A workspace tool's result. `images` follow the text in the MCP reply's content. */
export type WorkspaceToolResult = { text: string; isError?: boolean; images?: ToolImage[] };

/** The MCP tool definitions (name, description, inputSchema, annotations) of the workspace server. */
export const WORKSPACE_TOOLS: readonly unknown[] = [];

/**
 * One session's tools on one workspace: argument checks, per-session limits, concurrency and the exec into the pod.
 * The owning job keeps one instance per workspace for the session's life.
 */
export class WorkspaceSession {
  readonly db: Db;
  readonly api: KubeApi;
  readonly workspaceId: number;
  constructor(db: Db, api: KubeApi, workspaceId: number) {
    this.db = db;
    this.api = api;
    this.workspaceId = workspaceId;
  }

  /** Runs tool `name` with `args` for the queued workspace_calls row `row` and returns its result; never throws for a tool error. */
  async call(name: string, args: unknown, row: number): Promise<WorkspaceToolResult> {
    void name; void args; void row;
    return { text: "refused: the workspace tools are not built yet", isError: true };
  }
}
