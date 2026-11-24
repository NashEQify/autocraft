import { useSearchParams } from "react-router-dom";
import { useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { Page } from "../../ui/organisms/Page";
import { Connector } from "../connect/views";
import { Fold } from "../connect/Fold";
import { MySettings } from "../connect/MySettings";
import { Runners } from "../connect/Runners";
import { RunnerGuide } from "../connect/Setup";

/** Which of the user's repos their runner takes work on, and why not for the others; read from the user's own settings. */
function RepoTakes() {
  const { data } = useQuery("my-settings", (a) => a.me.settings.get());
  if (!data || !data.repoChoices.length) return null;
  const why = (repo: string) => (data.manualOnly ? "Manual only is on" : data.repos.length && !data.repos.includes(repo) ? "not in My repos" : null);
  const taken = data.repoChoices.filter((r) => !why(r)).length;
  return (
    <Fold className="mt-4" title="What your runner takes" summary={`${taken} of ${data.repoChoices.length} repos`}>
      <ul className="mt-1 divide-y divide-line rounded-md border border-line text-sm sm:max-w-xl">
          {data.repoChoices.map((repo) => (
            <li key={repo} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <span className="code">{repo}</span>
              <span className="text-right text-ink/70">{why(repo) ? `Only what you start (${why(repo)})` : "All work you may run"}</span>
            </li>
          ))}
        </ul>
    </Fold>
  );
}

export function RunnerView({ user }: ViewProps) {
  const [sp] = useSearchParams();
  const local = user.inference === "user-local";
  const runners = useQuery("runners", (a) => a.runners.list(), { enabled: local });
  if (local && !runners.data && !runners.error) return <Page title="Runner"><></></Page>;
  // No Task Runner yet: the setup steps and agent access; a login waiting for approval (`?runner=CODE`) still shows its card.
  const none = local && runners.data?.runners.length === 0 && !sp.get("runner");
  return (
    <Page title="Runner">
      {none && <RunnerGuide />}
      {local && !none && <Runners />}
      {local && !none && <MySettings advanced />}
      {local && !none && <RepoTakes />}
      <Connector user={user} />
    </Page>
  );
}
