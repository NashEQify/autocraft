// The project picker at the top of the navigation: narrows the list pages to one repo, with each repo's items that wait for an answer beside it.
import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "../api/client";
import { setScope, useScope } from "../api/scope";
import { RepoSelect } from "../ui/molecules/RepoSelect";
import { cn } from "../ui/cn";

/** `onPicked` runs after a pick, for the phone drawer to close. */
export function ScopePicker({ className, onPicked, modal }: { className?: string; onPicked?: () => void; modal?: boolean }) {
  const scope = useScope();
  const { data } = useQuery("maintain-repos", (api) => api.maintain.repos(), { project: null });
  const counts = useMemo(() => data && { total: data.reduce((n, r) => n + r.waiting, 0), byRepo: Object.fromEntries(data.map((r) => [r.name, r.waiting])) }, [data]);
  const pick = (repo: string | null) => {
    setScope(repo);
    onPicked?.();
  };
  return <RepoSelect value={scope} onChange={pick} counts={counts} allLabel="All projects" align="start" modal={modal} className={cn("w-full max-w-none justify-between", scope && "border-accent-ink/50", className)} />;
}

/** A list page's own repo filter: shown only under All projects; with a project picked, the picker is the repo control. */
export function UnlessProject({ children }: { children: ReactNode }) {
  return useScope() ? null : <>{children}</>;
}

/** Clears a pick the user can no longer see (untracked, or access lost); the server ignores it anyway. */
export function useStalePickCleared(): void {
  const scope = useScope();
  const { data: repos } = useQuery("repos", (api) => api.repos());
  useEffect(() => {
    if (scope && repos && !repos.includes(scope)) setScope(null);
  }, [scope, repos]);
}
