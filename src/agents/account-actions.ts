// The Claude account operations the dashboard offers, run where the account directories are: in this process when they
// are on its disk, otherwise on the runner through its /internal/ API (src/remote/runner-client.ts), which runs the same
// functions as the signed-in operator. Replies are the ClaudeAccount views the UI already shows; no directory, token or
// credential comes back.
import type { ClaudeAccount } from "../../web/src/api/types.ts";
import type { Db } from "../db/index.ts";
import { callRunner, runnerClient, RunnerError } from "../remote/runner-client.ts";
import { AccountError, listAccounts, updateAccount } from "./accounts.ts";
import { addAccount, beginLogin, beginToken, refreshNow, removeToken, sendCode, sendTokenCode, signOut, stopLogin, stopToken } from "./manage.ts";

type Action = (db: Db, id: unknown, input: unknown, by: string) => Promise<ClaudeAccount>;

export const ACCOUNT_ACTIONS: Record<string, Action> = {
  add: (db, _id, input, by) => addAccount(db, input, by),
  update: (db, id, input, by) => updateAccount(db, id, input, by),
  "login-start": (db, id, _input, by) => beginLogin(db, id, by),
  "login-code": (db, id, input, by) => sendCode(db, id, input, by),
  "login-cancel": (db, id, _input, by) => stopLogin(db, id, by),
  "token-start": (db, id, _input, by) => beginToken(db, id, by),
  "token-code": (db, id, input, by) => sendTokenCode(db, id, input, by),
  "token-cancel": (db, id, _input, by) => stopToken(db, id, by),
  "token-remove": (db, id, _input, by) => removeToken(db, id, by),
  "sign-out": (db, id, _input, by) => signOut(db, id, by),
  refresh: (db, id, _input, by) => refreshNow(db, id, by),
};

/** A runner refusal with a client status reads as the AccountError the local call would have thrown. */
const asAccountError = (e: unknown): never => {
  if (e instanceof RunnerError && e.status >= 400 && e.status < 500) throw new AccountError(e.status, e.message);
  throw e;
};

export async function accountAction(db: Db, action: keyof typeof ACCOUNT_ACTIONS, id: unknown, input: unknown, by: string): Promise<ClaudeAccount> {
  const c = runnerClient();
  if (!c) return await ACCOUNT_ACTIONS[action]!(db, id, input, by);
  try {
    return (await (await callRunner(c, "POST", `/internal/accounts/${action}`, by, { id: id ?? null, input: input ?? null })).json()) as ClaudeAccount;
  } catch (e) {
    return asAccountError(e);
  } finally {
    forgetAccountList();
  }
}

/** The runner's list, kept this long: the live and attention pages read it on every refresh. */
const LIST_TTL_MS = 2_000;
const listMemo = new Map<boolean, { at: number; list: Promise<ClaudeAccount[]> }>();

/** listAccounts, on the runner when the account directories are there; `by` is the login the runner logs the read under. */
export async function accountList(db: Db, nowMs: number = Date.now(), sync = true, by = "dashboard"): Promise<ClaudeAccount[]> {
  const c = runnerClient();
  if (!c) return await listAccounts(db, nowMs, sync);
  const m = listMemo.get(sync);
  if (m && Date.now() - m.at < LIST_TTL_MS) return await m.list;
  const list = (async () => (await (await callRunner(c, "POST", "/internal/accounts/list", by, { sync })).json()) as ClaudeAccount[])();
  listMemo.set(sync, { at: Date.now(), list });
  list.catch(() => listMemo.delete(sync));
  return await list;
}

/** After a change, the next list reads the runner again. */
export function forgetAccountList(): void {
  listMemo.clear();
}
