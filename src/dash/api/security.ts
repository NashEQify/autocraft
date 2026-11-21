// The security deep scan API. Operators and maintainers read; operators act. Everyone else gets 404, so the
// endpoints do not show that findings exist.
import type { FindingView, ScanDetail, ScanView, SecurityOverview } from "../../../web/src/api/types.ts";
import { actOnFindingAs, continueScanAs, SecurityError, startScanAs, stopScanAs } from "../../security/actions.ts";
import { listScans, overview, reconcileFindings, findingRow, scanDetail, toFinding, scanRow } from "../../security/store.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { canSeeInternals } from "./staff.ts";
import { needVisible, visibleRepos } from "./visible.ts";
import type { Db } from "../../db/index.ts";

const NOT_FOUND = "not found";
function needStaff(req: Req): void {
  if (!canSeeInternals(req)) throw new HttpError(404, NOT_FOUND);
}

function needOperator(req: Req): void {
  needStaff(req);
  if (req.user.role !== "operator") throw new HttpError(403, "only operators start or stop scans and decide findings");
}

function body(req: Req): Record<string, unknown> {
  const b = req.json;
  if (b === undefined) return {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
}

function number(v: string | undefined, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `not a ${what} number`);
  return n;
}

export async function security(db: Db, req: Req): Promise<SecurityOverview> {
  needStaff(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  return await overview(db, repo);
}

/** Runs a security action and gives its refusals the HTTP status they carry. */
async function asHttp<T>(run: () => Promise<Promise<T> | T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof SecurityError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

export async function startScan(db: Db, req: Req): Promise<ScanView> {
  needOperator(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  const b = body(req);
  return asHttp(async () => startScanAs(db, repo, req.user.login, b.capUsd));
}

export async function stopScan(db: Db, req: Req): Promise<ScanView> {
  needOperator(req);
  const id = number(req.params.id, "scan");
  const scan = await scanRow(db, id);
  if (!scan) throw new HttpError(404, NOT_FOUND);
  await needVisible(db, req, scan.repo);
  return asHttp(async () => await stopScanAs(db, id, req.user.login));
}

export async function continueScan(db: Db, req: Req): Promise<ScanView> {
  needOperator(req);
  const id = number(req.params.id, "scan");
  const scan = await scanRow(db, id);
  if (!scan) throw new HttpError(404, NOT_FOUND);
  await needVisible(db, req, scan.repo);
  return asHttp(async () => continueScanAs(db, id, req.user.login, body(req).cap));
}

export async function finding(db: Db, req: Req): Promise<FindingView> {
  needStaff(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  await reconcileFindings(db, repo);
  const row = await findingRow(db, repo, number(req.params.n, "finding"));
  if (!row) throw new HttpError(404, NOT_FOUND);
  return await toFinding(db, row);
}

export async function actOnFinding(db: Db, req: Req): Promise<FindingView> {
  needOperator(req);
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  const n = number(req.params.n, "finding");
  const b = body(req);
  return asHttp(async () => actOnFindingAs(db, repo, n, req.user.login, b));
}

/** Scans of the repos the reader can see, newest first; `?repo=` narrows to one. */
export async function scans(db: Db, req: Req): Promise<ScanView[]> {
  needStaff(req);
  return await listScans(db, await visibleRepos(db, req), req.query.get("repo") || undefined);
}

export async function scanOf(db: Db, req: Req): Promise<ScanDetail> {
  needStaff(req);
  const scan = await scanRow(db, number(req.params.id, "scan"));
  if (!scan) throw new HttpError(404, NOT_FOUND);
  await needVisible(db, req, scan.repo);
  return await scanDetail(db, scan);
}
