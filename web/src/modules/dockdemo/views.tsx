import type { ViewProps } from "../../registry/types";
import { SideDock, useDockState, type DockView } from "../../ui/organisms/SideDock";
import { GithubLinkButton } from "../../ui/atoms/GithubButton";
import { MessageTime } from "../../ui/atoms/MessageTime";

type V = "github" | "events";

const lines = (n: number, what: string) =>
  Array.from({ length: n }, (_, i) => (
    <li key={i} className="border-b border-line px-4 py-3 text-sm">
      {what} {i + 1} <MessageTime iso={`2026-11-26T09:${String(10 + i).padStart(2, "0")}:00Z`} className="num text-ink/70" />
    </li>
  ));

export function DockDemoView({ user }: ViewProps) {
  const views: DockView<V>[] = [
    { value: "github", label: "GitHub", defaultSize: 46, content: <ul>{lines(12, "GitHub activity")}</ul> },
    { value: "events", label: "Events", defaultSize: 34, count: 8, content: <ul>{lines(8, "Event")}</ul> },
  ];
  const dock = useDockState<V>(user.login, "dock-demo", views);
  return (
    <SideDock
      id="dock-demo"
      login={user.login}
      header={
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
          <h1 className="min-w-0 flex-1 truncate text-md font-semibold">Fix the clippy warning in bundle</h1>
          <GithubLinkButton href="https://github.com/example/repo/pull/12" />
        </div>
      }
      main={<div className="h-full overflow-y-auto p-4 text-sm"><p className="max-w-prose">Chat column.</p><ul>{lines(20, "Message")}</ul></div>}
      mainLabel="Chat"
      views={views}
      view={dock.view}
      onView={dock.setView}
      open={dock.open}
      onOpen={dock.setOpen}
    />
  );
}
