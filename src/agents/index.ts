// autocraft-server accounts list | set <id> [--label X] [--enabled yes|no] [--max-concurrent N] | jev [N | on | off] | pause [show | --five-hour N --weekly N]
import { jevEnabled, jevOutage, setJevEnabled } from "./jev.ts";
import { AccountError, jevParallel, listAccounts, setJevParallel, setUsagePause, updateAccount, usagePause } from "./accounts.ts";
import { openDb } from "../db/open.ts";

const USAGE = `usage: autocraft-server accounts list
       autocraft-server accounts set <id> [--label <text>] [--enabled yes|no] [--max-concurrent <N>]   (N from 1 to 100)
       autocraft-server accounts jev [<N> | on | off]   Jev calls at once (1 to 100), or switch Jev on or off; shows the setting and whether Jev is in use
       autocraft-server accounts pause [show]   usage levels (%) at which an account stops taking calls
       autocraft-server accounts pause --five-hour <N> --weekly <N>   set them (each 1 to 100)`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const pct = (n: number | null) => (n === null ? "  - " : `${String(Math.round(n)).padStart(3)}%`);

async function print(): Promise<void> {
  const list = await listAccounts(await openDb());
  if (!list.length) console.log("no accounts in the box config (AUTOCRAFT_ACCOUNTS)");
  for (const a of list) {
    console.log(`${a.id.padEnd(10)} ${a.enabled ? "enabled " : "disabled"} ${a.label.padEnd(24)} ${a.running}/${a.maxConcurrent} running  5h ${pct(a.usage.fiveHourPct)}  week ${pct(a.usage.weeklyPct)}${a.pausedReason ? `  ${a.pausedReason}` : ""}`);
  }
}

// Recorded as `cli`: only someone with a shell on the host can run this.
async function set(args: string[]): Promise<void> {
  const [id, ...rest] = args;
  if (!id) die(USAGE);
  const input: { label?: string; enabled?: boolean; maxConcurrent?: number } = {};
  for (let i = 0; i < rest.length; i += 2) {
    const v = rest[i + 1];
    if (v === undefined) die(USAGE);
    switch (rest[i]) {
      case "--label": input.label = v; break;
      case "--enabled": if (v !== "yes" && v !== "no") die(USAGE); input.enabled = v === "yes"; break;
      case "--max-concurrent": input.maxConcurrent = Number(v); break;
      default: die(USAGE);
    }
  }
  try {
    await updateAccount(await openDb(), id, input, "cli");
  } catch (e) {
    if (e instanceof AccountError) die(e.message);
    throw e;
  }
  await print();
}

async function jev(args: string[]): Promise<void> {
  const db = await openDb();
  if (args.length > 1) die(USAGE);
  if (args[0] === "on" || args[0] === "off") await setJevEnabled(db, args[0] === "on", "cli");
  else if (args[0] !== undefined) {
    try {
      await setJevParallel(db, Number(args[0]), "cli");
    } catch (e) {
      if (e instanceof AccountError) die(e.message);
      throw e;
    }
  }
  console.log(`Jev calls at once: ${await jevParallel(db)}`);
  const o = await jevOutage(db);
  console.log(o ? `Jev unavailable (${o.reason}) since ${o.since}; Haiku does its work` : await jevEnabled(db) ? "Jev in use" : "Jev off");
}

async function pause(args: string[]): Promise<void> {
  const db = await openDb();
  if (args.length && args[0] !== "show") {
    const cur = await usagePause(db);
    const input = { fiveHour: cur.fiveHour, weekly: cur.weekly };
    for (let i = 0; i < args.length; i += 2) {
      const v = args[i + 1];
      if (v === undefined) die(USAGE);
      if (args[i] === "--five-hour") input.fiveHour = Number(v);
      else if (args[i] === "--weekly") input.weekly = Number(v);
      else die(USAGE);
    }
    try {
      await setUsagePause(db, input, "cli");
    } catch (e) {
      if (e instanceof AccountError) die(e.message);
      throw e;
    }
  } else if (args.length > 1) die(USAGE);
  const p = await usagePause(db);
  console.log(`Pause at: 5-hour ${p.fiveHour} %, weekly ${p.weekly} %`);
}

export const commands = {
  accounts: {
    summary: "Claude accounts: list | set <id> [--label X] [--enabled yes|no] [--max-concurrent N] | jev [N | on | off] | pause [show | --five-hour N --weekly N]",
    run: async (args: string[]) => {
      if (args[0] === "list") await print();
      else if (args[0] === "set") await set(args.slice(1));
      else if (args[0] === "jev") await jev(args.slice(1));
      else if (args[0] === "pause") await pause(args.slice(1));
      else die(USAGE);
    },
  },
};
