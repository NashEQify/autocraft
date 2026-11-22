import { useQuery } from "../../api/client";
import type { BrowseState } from "./browseState";

/** The area names the Area filter offers: the list of the one repository the browser shows, else none. */
export function useAreaNames(browse: BrowseState): string[] {
  const repo = browse.repos.length === 1 ? browse.repos[0]! : null;
  const { data } = useQuery(`areas:${repo ?? ""}`, (api) => api.areas.get(repo!), { enabled: !!repo });
  return repo && data?.repo === repo ? data.areas.map((a) => a.name) : [];
}
