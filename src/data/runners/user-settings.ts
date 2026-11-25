// Per-person Task Runner settings: the keys `repos`, `skip_tasks`, `task_items`, `manual_only`, `max_calls`, `reserve_five_hour`,
// `reserve_weekly`, `interactive_slots`, `runner_private` of `user_settings` (package runners-b).
import type { Db } from "../../db/index.ts";
import type { KeySource } from "../keys.ts";
import type { LowerLogin, UserSettings } from "./types.ts";

/** Settings of the logins as raw values; defaults and task-id filtering are pure code. `logins` is a list or a key source of logins. */
export async function loadUserSettings(db: Db, logins: string[] | KeySource): Promise<Map<LowerLogin, UserSettings>> { throw new Error("not built: runners.loadUserSettings"); }
/** The logins whose runners are private, for the live board. */
export async function loadPrivateLogins(db: Db, logins: string[]): Promise<Set<LowerLogin>> { throw new Error("not built: runners.loadPrivateLogins"); }
/** Reads the old values, upserts changed keys, deletes keys set to their default and audits one row per changed setting. */
export async function saveUserSettings(db: Db, login: string, patch: Partial<UserSettings>, by: string): Promise<UserSettings> { throw new Error("not built: runners.saveUserSettings"); }
