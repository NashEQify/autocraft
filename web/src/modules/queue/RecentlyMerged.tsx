// Recently merged: the pull requests merged lately in the project or in every repo, newest first.
import { useQuery } from "../../api/client";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { WorkableRow, WorkableTable, type WorkableColumn } from "../../ui/organisms/Workable";
import { ErrorLine } from "../admin/parts";

const LIMIT = 50;

const COLUMNS: WorkableColumn[] = [
  { id: "author", label: "Author", width: "140px" },
  { id: "merged", label: "Updated", width: "116px" },
];

export function RecentlyMerged({ repo }: { repo: string | null }) {
  const { data, error } = useQuery(`maintain-items:merged:${repo ?? ""}`, (a) => a.maintain.items({ show: "closed", sort: "updated", limit: 2 * LIMIT }), { project: repo });
  const rows = (data?.rows ?? []).filter((r) => r.state === "merged").slice(0, LIMIT);
  return (
    <>
      <ErrorLine error={error?.message} className="mt-3" />
      {data && rows.length === 0 && <p className="mt-4 text-sm text-ink/60">No pull request was merged lately.</p>}
      {rows.length > 0 && (
        <WorkableTable columns={COLUMNS} label="Recently merged" className="mt-4">
          {rows.map((r) => (
            <WorkableRow
              key={`${r.repo}#${r.number}`}
              item={{ repo: r.repo, number: r.number, kind: r.kind, state: r.state, title: r.title }}
              cells={{
                author: <span className="block truncate text-xs text-ink/70">{r.author || "unknown"}</span>,
                merged: <TimeAgo iso={r.updatedAt} className="num text-xs text-ink/50" />,
              }}
            />
          ))}
        </WorkableTable>
      )}
    </>
  );
}
