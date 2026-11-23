// The GitHub App's allowed owners: with accounts listed, an installation elsewhere is uninstalled through the audited
// write, an account that owns a tracked repo keeps its installation and stays on the list, and an empty list removes nothing.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ackRemovals, AllowedOwnerError, allowOwner, installationEvent, removeOwner, sweepInstallations, unackedRemovals } from "../src/github/allowed-owners.ts";
import type { AppSecrets } from "../src/dash/server/config.ts";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "allowed-owners-test-"));
const db = await connectDb(join(dir, "a.db"));
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const app: AppSecrets = { id: "1", slug: "autocraft-test", privateKey: PEM, clientId: "Iv1.test", clientSecret: "s", webhookSecret: "w", owner: { login: "glasswing", type: "Organization" } };
let github: Server;
let apiBase = "";
let listed = 0;
const deleted: string[] = [];

before(async () => {
  github = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/app/installations?")) {
      listed++;
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify([
        { id: 1, account: { login: "Glasswing", type: "Organization" }, repository_selection: "all" },
        { id: 2, account: { login: "lumenworks", type: "Organization" }, repository_selection: "all" },
        { id: 3, account: { login: "storytold", type: "Organization" }, repository_selection: "selected" },
      ]));
    }
    if (req.method === "DELETE" && /^\/app\/installations\/\d+$/.test(url)) {
      deleted.push(url);
      res.writeHead(204);
      return void res.end();
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  // A tracked repo without a `repos` row belongs to storytold.
  await db.run(db.k.insertInto("main.tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.column("name").doNothing()));
});
after(async () => {
  await new Promise((r) => github.close(r));
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("only installations on accounts that are neither allowed nor owners of tracked repos are removed, and only while the list has accounts", async () => {
  assert.equal(await sweepInstallations(db, app, { apiBase, log: () => {} }), 0);
  assert.equal(listed + deleted.length, 0);

  await db.run(db.k.insertInto("app_allowed_owners").values({ login: "glasswing", added_by: "op", added_at: new Date().toISOString() }));
  assert.equal(await sweepInstallations(db, app, { apiBase, log: () => {} }), 1);
  assert.deepEqual(deleted, ["/app/installations/2"]);
  const row = await db.get(db.k.selectFrom("audit").select(["target", "details"]).where("action", "=", "app-install-removed"));
  assert.equal(row?.target, "lumenworks");
  const d = JSON.parse(row!.details!) as { state: string; installation: number; identity: string };
  assert.deepEqual([d.state, d.installation, d.identity], ["done", 2, "app"]);

  // A new installation's webhook removes it at once.
  assert.equal(await installationEvent(db, "installation", { action: "created", installation: { id: 9, account: { login: "elsewhere" } } }, { app, apiBase, log: () => {} }), true);
  assert.equal(deleted.at(-1), "/app/installations/9");

  assert.ok((await unackedRemovals(db, Date.now())).length > 0);
  await ackRemovals(db, "op");
  assert.equal((await unackedRemovals(db, Date.now() + 1000)).length, 0);

  await allowOwner(db, "op", "storytold", app.owner!.login);
  await assert.rejects(removeOwner(db, "op", "storytold", app.owner!.login), AllowedOwnerError);
  await assert.rejects(removeOwner(db, "op", "glasswing", app.owner!.login), AllowedOwnerError);
});
