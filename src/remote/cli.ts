// `autocraft-server inference [server|user-local]`: shows or sets the inference mode (src/remote/mode.ts). `autocraft-server remote cooloff clear <login>`: ends the cool-off of a login's helpers (src/remote/cooloff.ts).
// `autocraft-server remote token <login>`: makes a Task Runner credential for a maintainer or operator and prints only the credential,
// so it can be piped into `autocraft login --stdin` on the same host without anyone seeing it (no device login needed).
import { audit } from "../dash/audit.ts";
import { createToken, MCP_TOKENS_PER_LOGIN } from "../dash/mcp/tokens.ts";
import { clearCooloff } from "./cooloff.ts";
import { inferenceMode, isInferenceMode, setInferenceMode } from "./mode.ts";
import { openDb } from "../db/open.ts";

export const commands = {
  inference: {
    summary: "show or set the inference mode: server (accounts on this host) or user-local (maintainers' helpers)",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      const want = args[0];
      if (want === undefined) {
        console.log(`inference: ${await inferenceMode(db)}`);
        return;
      }
      if (!isInferenceMode(want) || args.length > 1) {
        console.error("usage: autocraft-server inference [server|user-local]");
        process.exit(1);
      }
      console.log(await setInferenceMode(db, want, "cli") ? `inference: ${want}` : `inference was already ${want}`);
    },
  },
  remote: {
    summary: "remote cooloff clear <login>: lets the login's helpers claim calls again after a cool-off; remote token <login> [--label <text>]: a Task Runner credential on stdout, for piping into autocraft login --stdin",
    async run(args: string[]): Promise<void> {
      if (args[0] === "token") return await makeToken(args.slice(1));
      if (args[0] !== "cooloff" || args[1] !== "clear" || !args[2] || args.length > 3) {
        console.error("usage: autocraft-server remote cooloff clear <login>");
        process.exit(1);
      }
      console.log(await clearCooloff(await openDb(), args[2], "cli") ? `cleared the cool-off of ${args[2]}` : `${args[2]} is not cooling off`);
    },
  },
};

const TOKEN_USAGE = "usage: autocraft-server remote token <login> [--label <text>] | autocraft login --stdin <dashboard url>   (stdout must not be a terminal)";

async function makeToken(args: string[]): Promise<void> {
  const login = args[0];
  const at = args.indexOf("--label");
  const label = at > 0 ? args[at + 1] : "Task Runner";
  if (!login || login.startsWith("-") || (at > 0 && !label) || args.length !== (at > 0 ? 3 : 1)) {
    console.error(TOKEN_USAGE);
    process.exit(1);
  }
  // The token is printed once and only into a pipe: on a terminal it would be on screen and in scrollback.
  if (process.stdout.isTTY) {
    console.error(`refused: stdout is a terminal\n${TOKEN_USAGE}`);
    process.exit(1);
  }
  const db = await openDb();
  const role = (await db.get(db.k.selectFrom("access").select("role").where("login", "=", login)))?.role;
  if (role !== "maintainer" && role !== "operator") {
    console.error(`refused: ${login} is ${role ? `a ${role}` : "not on the access list"}; only maintainers and operators run model calls`);
    process.exit(1);
  }
  let made: Awaited<ReturnType<typeof createToken>>;
  try {
    made = await createToken(db, login, label, { kind: "runner" });
  } catch (e) {
    console.error(`refused: ${(e as Error).message} (at most ${MCP_TOKENS_PER_LOGIN} Task Runners per login; remove one on the Connect page)`);
    process.exit(1);
  }
  const { token, row } = made;
  await audit(db, "cli", "runner-approve", login, { id: row.id, label: row.label ?? undefined, via: "cli" });
  process.stdout.write(`${token}\n`);
  console.error(`made Task Runner credential ${row.id} (${row.label ?? "no label"}) for ${login}; remove it on the Connect page`);
}
