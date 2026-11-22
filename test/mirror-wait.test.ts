import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MIRROR_UNREACHABLE, mirrorWaitPhase } from "../src/worker/pod.ts";

const env = () => ({ work: "/tmp", message: join(mkdtempSync(join(tmpdir(), "mw-")), "msg"), ran: 0, log: () => {} });

test("mirror-wait waits for a listener that appears late and reports an environment error when none does", async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  const late = setTimeout(() => { const s = createServer((c) => c.end()); s.listen(port, "127.0.0.1"); (late as any).s = s; }, 600);
  const t = Date.now();
  assert.equal(await mirrorWaitPhase(env(), "127.0.0.1", port, 5000, 100), 0);
  assert.ok(Date.now() - t >= 500);
  (late as any).s.close();

  const e = env();
  assert.equal(await mirrorWaitPhase(e, "127.0.0.1", port, 700, 100), 5);
  assert.equal(readFileSync(e.message, "utf8"), MIRROR_UNREACHABLE);
});
