// KubeApi.exec against a loopback server that speaks the exec WebSocket protocol (v5.channel.k8s.io).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { after, test } from "node:test";
import { kubeApi, KubeError } from "../src/build/kube-api.ts";

type Seen = { argv: string[]; stdin: Buffer[]; maxStdinFrame: number; stdinClosed: boolean; pong: boolean; clientClose: boolean };
const seen = new Map<string, Seen>();
const done = new Map<string, Promise<void>>();

function frame(op: number, payload: Buffer, fin = true): Buffer {
  const n = payload.length;
  const head = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
  if (n < 126) head[1] = n;
  else if (n < 65536) [head[1], head[2], head[3]] = [126, n >> 8, n & 255];
  else [head[1], head[9], head[8], head[7]] = [127, n & 255, (n >> 8) & 255, n >> 16];
  head[0] = (fin ? 0x80 : 0) | op;
  return Buffer.concat([head, payload]);
}
const msg = (ch: number, data: string | Buffer) => frame(2, Buffer.concat([Buffer.from([ch]), Buffer.from(data)]));

/** Reads masked client frames. */
function readFrames(socket: Duplex, on: (op: number, payload: Buffer) => void) {
  let buf = Buffer.alloc(0);
  socket.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      if (buf.length < 2) return;
      assert.ok(buf[1]! & 0x80, "client frames are masked");
      let len = buf[1]! & 0x7f, off = 2;
      if (len === 126) [len, off] = [buf.readUInt16BE(2), 4];
      else if (len === 127) [len, off] = [Number(buf.readBigUInt64BE(2)), 10];
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const p = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i & 3]!);
      const op = buf[0]! & 0x0f;
      buf = buf.subarray(off + 4 + len);
      on(op, Buffer.from(p));
    }
  });
}

const server = createServer();
server.on("upgrade", (req, socket: Duplex) => {
  socket.on("error", () => {});
  const url = new URL(req.url!, "http://x");
  if (url.pathname.includes("/pods/denied/")) {
    const body = JSON.stringify({ kind: "Status", status: "Failure", message: "pods \"denied\" is forbidden\u0007", code: 403 });
    return socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
  }
  const argv = url.searchParams.getAll("command");
  const s: Seen = { argv, stdin: [], maxStdinFrame: 0, stdinClosed: false, pong: false, clientClose: false };
  seen.set(argv[0]!, s);
  done.set(argv[0]!, new Promise((r) => socket.on("close", () => r())));
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}\r\n\r\n`);
  const status = (st: object) => {
    socket.write(msg(3, JSON.stringify(st)));
    socket.write(frame(8, Buffer.from([0x03, 0xe8])));
  };
  if (argv[0] === "flood") for (let i = 0; i < 10; i++) socket.write(msg(1, "x".repeat(1000)));
  readFrames(socket, (op, p) => {
    if (op === 10) s.pong = true;
    if (op === 8) {
      s.clientClose = true;
      socket.end();
    }
    if (op !== 2) return;
    if (p[0] === 0) {
      s.stdin.push(p.subarray(1));
      s.maxStdinFrame = Math.max(s.maxStdinFrame, p.length);
      return;
    }
    if (p[0] !== 255 || p[1] !== 0) return;
    s.stdinClosed = true;
    if (argv[0] === "cat") {
      const all = Buffer.concat(s.stdin);
      socket.write(frame(9, Buffer.from("hi")));
      // stdout as one message in two fragments
      socket.write(frame(2, Buffer.concat([Buffer.from([1]), all.subarray(0, 1000)]), false));
      socket.write(frame(0, all.subarray(1000)));
      socket.write(msg(2, "warning\n"));
      status({ status: "Success" });
    } else if (argv[0] === "exit") {
      status({ status: "Failure", reason: "NonZeroExitCode", message: "command terminated with non-zero exit code", details: { causes: [{ reason: "ExitCode", message: argv[1] }] } });
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const api = kubeApi({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, tls: false });

test("exec sends argv and stdin, splits output by channel and reads the exit code", async () => {
  const input = Buffer.from(Array.from({ length: 150_000 }, (_, i) => i % 251));
  const odd = "a b&c=d/é";
  const r = await api.exec("ns", "p", "work", ["cat", odd], { stdin: input, maxOut: 1 << 20, timeoutMs: 3000 });
  assert.equal(r.exitCode, 0, r.error ?? "");
  assert.equal(r.error, undefined);
  assert.ok(r.stdout.equals(input), "stdout carries stdin back");
  assert.equal(r.stderr.toString(), "warning\n");
  assert.equal(r.truncated, false);
  await done.get("cat");
  const s = seen.get("cat")!;
  assert.deepEqual(s.argv, ["cat", odd]);
  assert.ok(s.stdin.length > 1 && s.maxStdinFrame <= 64 * 1024, "stdin is split into frames of at most 64 KiB");
  assert.ok(s.stdinClosed && s.pong);

  const e = await api.exec("ns", "p", "work", ["exit", "3"], { maxOut: 100, timeoutMs: 3000 });
  assert.equal(e.exitCode, 3);
  assert.ok(seen.get("exit")!.stdinClosed, "stdin is closed even when none is given");
});

test("exec stops at maxOut and at the timeout, and a refused upgrade throws", async () => {
  const f = await api.exec("ns", "p", "work", ["flood"], { maxOut: 2500, timeoutMs: 3000 });
  assert.ok(f.truncated);
  assert.equal(f.stdout.length, 2500);
  assert.equal(f.exitCode, null);
  await done.get("flood");
  assert.ok(seen.get("flood")!.clientClose, "the client closes the stream once over the cap");

  const h = await api.exec("ns", "p", "work", ["hang"], { maxOut: 100, timeoutMs: 200 });
  assert.equal(h.exitCode, null);
  assert.equal(h.error, "timed out");

  await assert.rejects(api.exec("ns", "denied", "work", ["x"], { maxOut: 100, timeoutMs: 1000 }), (e: unknown) => {
    assert.ok(e instanceof KubeError && e.status === 403 && /forbidden/.test(e.message) && !/\u0007/.test(e.message));
    return true;
  });
});
