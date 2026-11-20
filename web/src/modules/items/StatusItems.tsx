// Items with a phase: the same browser, scoped to the status endpoint (phase, q, kind,
// repositories, Discord, cursor). State, classification, label and flag are locked, not faked.
// The rows are the same compact rows as the normal list; the expansion states what this payload
// does not carry instead of inventing a classification.
import { useMemo } from "react";
import { usePagedQuery, useQuery } from "../../api/client";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Button } from "../../ui/atoms/Button";
import { Page } from "../../ui/organisms/Page";
import { num } from "../../lib/format";
import { useUser } from "../../shell/UserContext";
import { usePageProject } from "../../api/scope";
import { BrowserChrome, EmptyResults, type BrowserProps } from "./ItemFilters";
import { ItemRow, OpenRowDetail, SelectionUnavailable } from "./ItemRows";
import { factsFromStatusRow, refKey, selectionProblem } from "./rows";
import { statusFilter } from "./browseState";

/** Phase mode: the status endpoint behind the same toolbar, rows and inline expansion. */
export function PhaseItems({ browse, phone, onPatch, search, author, onClearPhase, onReset, onRemove, selection, onToggleRow, onCloseSelection, selectionNote, resetKey }: BrowserProps) {
  const user = useUser();
  const project = usePageProject();
  const scope = JSON.stringify([user.login, user.role, project]);
  const filter = statusFilter(browse);
  const { pages: receipts, error, loading, hasMore, loadingMore, loadMore } = usePagedQuery(
    `items-status:${scope}:${JSON.stringify(filter)}`,
    async (api, cursor) => ({ scope, page: await api.itemStatusList({ ...filter, cursor }) }),
    (receipt) => receipt.page.nextCursor,
  );
  const { data: repoOptions } = useQuery("repos", (api) => api.repos());
  // Every loaded page must carry this reader's scope; anything else is the previous reader's data.
  const pages = receipts && receipts.every((receipt) => receipt.scope === scope) ? receipts.map((receipt) => receipt.page) : undefined;
  const firstPage = pages?.[0];
  const ready = !!firstPage;
  const first = firstPage;
  const rows = ready ? pages?.flatMap((page) => page.rows) ?? [] : [];
  const facts = useMemo(() => rows.map(factsFromStatusRow), [rows]);
  const total = first && browse.phase ? first.byPhase[browse.phase] : undefined;
  const settled = ready && !!first && !loading && !error;
  const problem = settled ? selectionProblem(selection, facts.map((row) => row.key)) : null;
  const bar = !ready
    ? "Loading this view for your role…"
    : loading
    ? "Updating results…"
    : total !== undefined
      ? <>Filtered view · {num(total)} {total === 1 ? "item" : "items"} in {browse.phase} · counts include the search, type and repository filters</>
      : "Loading items…";
  return <Page title="Items" sub={ready && !loading && total !== undefined ? `${num(total)} ${total === 1 ? "item" : "items"}` : undefined}>
    <BrowserChrome browse={browse} repos={repoOptions ?? []} phone={phone} phaseCounts={first?.byPhase} onPatch={onPatch} search={search} author={author} onClearPhase={onClearPhase} onReset={onReset} onRemove={onRemove} resetKey={resetKey} bar={bar} hasRows={rows.length > 0}>
      <ErrorLine error={error?.message} className="px-4 py-3" />
      {!ready && !error && <p role="status" className="px-4 py-6 text-sm text-ink/50">Loading this view for your role…</p>}
      {ready && !first && !error && <p role="status" className="px-4 py-6 text-sm text-ink/50">Loading {browse.phase} items…</p>}
      {/* A new phase key loads over the old one; another phase's rows are never shown under this phase's name. */}
      {first && loading && <p role="status" className="px-4 py-6 text-sm text-ink/50">Updating results…</p>}
      {!loading && first && !rows.length && !error && !problem && <EmptyResults onReset={onReset} />}
      {problem && <SelectionUnavailable {...problem} onClose={onCloseSelection} />}
      {!loading && rows.length > 0 && <>
        <ul aria-label="Items" className="m-0 list-none p-0">
          {facts.map((row) => <ItemRow key={row.key} facts={row} open={!!selection.open && refKey(selection.open) === row.key} onToggle={() => onToggleRow({ repo: row.repo, number: row.number })}>
            {selection.open && refKey(selection.open) === row.key && <OpenRowDetail facts={row} note={selectionNote} />}
          </ItemRow>)}
        </ul>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2 text-xs text-ink/55"><span className="num">{rows.length} of {num(total ?? rows.length)}</span>{hasMore && <Button loading={loadingMore} onClick={loadMore} className="max-md:h-11">Load more</Button>}</div>
      </>}
    </BrowserChrome>
  </Page>;
}
