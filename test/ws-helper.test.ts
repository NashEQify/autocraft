import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../deploy/container/ws", import.meta.url).pathname;

test("run reports exit codes, caps a large log, and background calls are waited for; kill ends a call; put checks the expected sha", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-helper-"));
  const env = { ...process.env, WS_ROOT: root };
  const ws = (args: string[], input = "") => {
    const r = spawnSync("sh", [script, ...args], { env, input, encoding: "utf8", timeout: 20000 });
    const nl = r.stdout.indexOf("\n");
    return { status: r.status, header: r.stdout.slice(0, nl), body: r.stdout.slice(nl + 1) };
  };
  try {
    // Directories the init subcommand creates, without its wait loop.
    spawnSync("mkdir", ["-p", join(root, ".ws/calls"), join(root, "src"), join(root, "home")]);

    const fg = ws(["run", "1", "20", "--", "sh", "-c", "seq 1 20000; exit 3"]);
    assert.equal(fg.status, 0);
    const [w, state, code, , total] = fg.header.split(" ");
    assert.deepEqual([w, state, code], ["WS", "exited", "3"]);
    assert.equal(Number(total), readFileSync(join(root, ".ws/calls/1.log")).length);
    assert.match(fg.body, /\[ws: \d+ bytes cut; full log .*1\.log\]/);
    assert.ok(Buffer.byteLength(fg.body) < 31500);
    assert.ok(fg.body.endsWith("20000\n"));

    assert.equal(ws(["run", "1", "5", "--", "true"]).status, 4, "call numbers are not reused");

    assert.equal(ws(["run", "2", "20", "--background", "--", "sh", "-c", "sleep 0.3; echo done"]).header, "WS started 2");
    const st = ws(["status", "2", "--wait", "10"]);
    assert.match(st.header, /^WS exited 0 \d+ 5$/);
    assert.equal(st.body, "done\n");
    assert.equal(ws(["status", "2", "--since", "2"]).body, "ne\n");
    assert.equal(ws(["status", "99"]).status, 3);

    ws(["run", "3", "60", "--background", "--", "sleep", "60"]);
    assert.match(ws(["status", "3"]).header, /^WS running - /);
    assert.match(ws(["kill", "3"]).header, /^WS killed \d+ /);

    const target = join(root, "src/a/b.txt");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    assert.match(ws(["put", target, "--expect", "none"], "one").header, new RegExp(`^WS ok 3 ${sha("one")}$`));
    const bad = ws(["put", target, "--expect", sha("zzz")], "two");
    assert.equal(bad.status, 4);
    assert.equal(bad.header, `WS error conflict ${sha("one")}`);
    assert.equal(ws(["put", target, "--expect", "none"], "two").status, 4);
    assert.equal(ws(["put", target, "--expect", sha("one")], "two").status, 0);
    assert.equal(readFileSync(target, "utf8"), "two");
    assert.equal(ws(["put", `${root}/src/../x`], "x").status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
