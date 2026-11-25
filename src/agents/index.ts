// autocraft-server inference jev [N | on | off] | pause [show | --five-hour N --weekly N]
import { jevEnabled, jevOutage, setJevEnabled } from "./jev.ts";
import { loadLiveConfig, saveSettings } from "../data/control/index.ts";
import { openDb } from "../db/open.ts";

const USAGE = `usage: autocraft-server inference jev [<N> | on | off]   Jev calls at once (1 to 100), or switch Jev on or off; shows the setting and whether Jev is in use
       autocraft-server inference pause [show]   usage levels (%) at which a Task Runner stops taking calls
       autocraft-server inference pause --five-hour <N> --weekly <N>   set them (each 1 to 100)`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const whole = (v: number, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;

async function jev(args: string[]): Promise<void> {
  const db = await openDb();
  if (args.length > 1) die(USAGE);
  if (args[0] === "on" || args[0] === "off") await setJevEnabled(db, args[0] === "on", "cli");
  else if (args[0] !== undefined) {
    const n = Number(args[0]);
    if (!whole(n, 1, 100)) die("Jev calls at once must be a whole number from 1 to 100");
    await saveSettings(db, [{ key: "jev_parallel", value: String(n) }], "cli", { action: "account-change", target: "jev", details: { jevParallel: n } });
  }
  console.log(`Jev calls at once: ${(await loadLiveConfig(db)).jevParallel}`);
  const o = await jevOutage(db);
  console.log(o ? `Jev unavailable (${o.reason}) since ${o.since}; Haiku does its work` : await jevEnabled(db) ? "Jev in use" : "Jev off");
}

async function pause(args: string[]): Promise<void> {
  const db = await openDb();
  if (args.length && args[0] !== "show") {
    const cur = (await loadLiveConfig(db)).usagePause;
    const input = { fiveHour: cur.fiveHour, weekly: cur.weekly };
    for (let i = 0; i < args.length; i += 2) {
      const v = args[i + 1];
      if (v === undefined) die(USAGE);
      if (args[i] === "--five-hour") input.fiveHour = Number(v);
      else if (args[i] === "--weekly") input.weekly = Number(v);
      else die(USAGE);
    }
    if (!whole(input.fiveHour, 1, 100) || !whole(input.weekly, 1, 100)) die("pause levels must be whole numbers from 1 to 100");
    await saveSettings(db, [{ key: "usage_pause", value: JSON.stringify(input) }], "cli", { action: "account-change", target: "usage-pause", details: input });
  } else if (args.length > 1) die(USAGE);
  const p = (await loadLiveConfig(db)).usagePause;
  console.log(`Pause at: 5-hour ${p.fiveHour} %, weekly ${p.weekly} %`);
}

export const commands = {
  inference: {
    summary: "Model calls: jev [N | on | off] | pause [show | --five-hour N --weekly N]",
    run: async (args: string[]) => {
      if (args[0] === "jev") await jev(args.slice(1));
      else if (args[0] === "pause") await pause(args.slice(1));
      else die(USAGE);
    },
  },
};
