// The GitHub App's own record of its webhook deliveries (`GET /app/hook/deliveries`, newest first), read by each sync run. A
// delivery this server did not take (the receiver was restarting, the gateway failed, a timeout) is asked for again, up to
// three attempts in all, so a missed change and a missed command in a comment both arrive late instead of never. Any delivery
// that did not succeed also makes the run poll GitHub (src/mirror.ts pollReason), because what it named is not in the mirror.
import type { AppSecrets } from "../dash/server/config.ts";
import { loadSyncState, saveSyncState } from "../data/mirror/index.ts";
import type { Db } from "../db/index.ts";
import { appJwt, call, GITHUB_API } from "./app.ts";
import { redeliverWebhook } from "./write.ts";

export type Delivery = { id: number; guid: string; delivered_at: string; status_code: number; event: string };

/** Deliveries newer than this may still be in flight; the next check looks at them. */
const SETTLE_MS = 30_000;
/** How far back the first check looks. */
const FIRST_LOOK_MS = 3600_000;
/** Attempts of one delivery, the first included, after which it is left alone. */
const MAX_ATTEMPTS = 3;
/** Redeliveries one check asks for at most; a longer outage is covered by the poll it causes. */
const MAX_REDELIVER = 20;
const PAGE = 100;

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const ok = (d: Delivery): boolean => d.status_code >= 200 && d.status_code < 300;
/** No answer, a server error or a rate limit: worth sending again. A 4xx is this server refusing it, which a retry repeats. */
const retryable = (d: Delivery): boolean => d.status_code === 0 || d.status_code === 429 || d.status_code >= 500;

export type DeliveryCheck = {
  /** Deliveries in the checked span that never succeeded. */
  failed: number;
  redelivered: number;
  /** False when the page did not reach back to the last check: deliveries may have failed unseen. */
  covered: boolean;
};

export type DeliveryDeps = {
  list?: () => Promise<Delivery[]>;
  redeliver?: (d: Delivery) => Promise<void>;
  log?: (line: string) => void;
};

/** Checks the deliveries since the last check and asks for the failed ones again. */
export async function checkDeliveries(db: Db, app: AppSecrets, now = Date.now(), deps: DeliveryDeps = {}): Promise<DeliveryCheck> {
  const log = deps.log ?? console.log;
  const list = deps.list ?? (async () => (await call(GITHUB_API, `/app/hook/deliveries?per_page=${PAGE}`, appJwt(app))) as Delivery[]);
  const redeliver = deps.redeliver ?? ((d: Delivery) => redeliverWebhook({ db, login: "webhook-check" }, { app, id: d.id, guid: d.guid, event: d.event }));
  const last = (await loadSyncState(db)).deliveries_checked_at;
  const since = last ?? iso(now - FIRST_LOOK_MS);
  const until = iso(now - SETTLE_MS);
  const page = (await list()).filter((d) => typeof d?.guid === "string" && typeof d.delivered_at === "string");
  const covered = page.length < PAGE || page.some((d) => d.delivered_at <= since);
  const attempts = new Map<string, Delivery[]>();
  for (const d of page) attempts.set(d.guid, [...(attempts.get(d.guid) ?? []), d]);
  // The deliveries whose latest attempt falls in the span: a redelivery shows up again as a new attempt with a later time.
  const due = [...attempts.values()]
    .map((all) => all.sort((a, b) => b.delivered_at.localeCompare(a.delivered_at)))
    .filter((all) => all[0]!.delivered_at > since && all[0]!.delivered_at <= until && !all.some(ok));
  let redelivered = 0;
  for (const all of due) {
    const latest = all[0]!;
    if (!retryable(latest) || all.length >= MAX_ATTEMPTS || redelivered >= MAX_REDELIVER) {
      log(`webhook delivery ${latest.guid} (${latest.event}) failed with ${latest.status_code || "no answer"}; not sent again`);
      continue;
    }
    try {
      await redeliver(latest);
      redelivered++;
    } catch (e) {
      log(`webhook redelivery ${latest.guid}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  await saveSyncState(db, { deliveries_checked_at: until > since ? until : since });
  if (due.length) log(`webhook deliveries: ${due.length} failed, ${redelivered} asked for again`);
  return { failed: due.length, redelivered, covered };
}
