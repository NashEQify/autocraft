// Alert opt-ins and sent alerts (`discord_alerts`, `discord_alert_msgs`). Row identity of a sent alert is (user_hash, workflow_id, rec_at).
import type { Db } from "../../db/index.ts";
import type { Alerter, SentAlert } from "./types.ts";

/** Opted-in accounts that still have a link (via the `access.linkedLogin` fragment) and their sent rows after `sinceIso`; 2 statements in the caller's wave. */
export async function loadAlertState(db: Db, f: { sinceIso: string }): Promise<{ alerters: Alerter[]; sent: SentAlert[] }> { throw new Error("not built: discord.loadAlertState"); }
/** Which user hashes have alerts on. */
export async function loadAlertOptIns(db: Db, userHashes: string[]): Promise<Set<string>> { throw new Error("not built: discord.loadAlertOptIns"); }
/** Upserts an opt-in; `created_at` is kept on conflict, `sealed` updates. */
export async function saveAlertOptIn(db: Db, row: { userHash: string; sealed: string; createdAt: string }): Promise<void> { throw new Error("not built: discord.saveAlertOptIn"); }
/** Removes opt-ins and their sent rows. */
export async function removeAlertOptIns(db: Db, userHashes: string[]): Promise<void> { throw new Error("not built: discord.removeAlertOptIns"); }
/** Records sent alerts (`ON CONFLICT DO NOTHING`); also marks a closed direct-message channel so it is not retried. */
export async function addSentAlerts(db: Db, rows: SentAlert[]): Promise<void> { throw new Error("not built: discord.addSentAlerts"); }
/** Deletes sent alerts before a time. */
export async function pruneSentAlerts(db: Db, beforeIso: string): Promise<number> { throw new Error("not built: discord.pruneSentAlerts"); }
