import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { MIRROR_HOSTS, startMirror, type Mirror } from "../src/cratemirror/server.ts";
import { IndexCache } from "../src/cratemirror/crates.ts";
import { Slots } from "../src/cratemirror/store.ts";

const hasTools = spawnSync("openssl", ["version"]).status === 0 && spawnSync("git", ["--version"]).status === 0;
const root = mkdtempSync(join(tmpdir(), "crate-mirror-test-"));
const tlsDir = join(root, "tls");
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function makeCerts(): void {
  mkdirSync(tlsDir);
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: tlsDir, stdio: "pipe" });
  o("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=test-ca", "-days", "1", "-keyout", "ca.key", "-out", "ca.pem");
  for (const host of MIRROR_HOSTS) {
    writeFileSync(join(tlsDir, `${host}.ext`), `subjectAltName=DNS:${host}\n`);
    o("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", `/CN=${host}`, "-keyout", `${host}.key`, "-out", `${host}.csr`);
    o("x509", "-req", "-in", `${host}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", `${host}.ext`, "-out", `${host}.crt`);
  }
}

// Fake crates.io: the index lists demo 1.0.0..1.0.3; 1.0.3's download does not match its cksum.
const crateBody = (v: string): Buffer => Buffer.from(`crate demo ${v} `.repeat(20));
const versions = ["1.0.0", "1.0.1", "1.0.2", "1.0.3"];
let indexMode: "ok" | "down" = "ok";
const calls: string[] = [];
const indexText = (): string => versions.map((v) => JSON.stringify({ name: "demo", vers: v, cksum: v === "1.0.3" ? sha("something else") : sha(crateBody(v)) })).join("\n") + "\n";
const fakeFetch = (async (input: string | URL | Request) => {
  const u = String(input);
  calls.push(u);
  if (u.startsWith("https://idx.test/")) {
    if (indexMode === "down") return new Response("oops", { status: 503 });
    if (u === "https://idx.test/de/mo/demo") return new Response(indexText(), { headers: { etag: "\"up1\"" } });
    if (u === "https://idx.test/3/b/big") return new Response(JSON.stringify({ name: "big", vers: "1.0.0", cksum: sha(Buffer.alloc(4096)) }) + "\n");
    return new Response("not found", { status: 404 });
  }
  const m = /^https:\/\/static\.test\/crates\/demo\/([^/]+)\/download$/.exec(u);
  if (m && versions.includes(m[1]!)) return new Response(new Uint8Array(crateBody(m[1]!)));
  if (u === "https://static.test/crates/big/1.0.0/download") return new Response(new Uint8Array(4096));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

let clock = Date.now();
let mirror: Mirror;
let dataDir: string;
let upstreamGit: string;
const allowFile = join(root, "allow.txt");

function get(host: string, path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Buffer; cert: X509Certificate | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: mirror.port, servername: host, path, method: o.method ?? "GET", headers: { host, ...o.headers }, ca: readFileSync(join(tlsDir, "ca.pem")), agent: false }, (res) => {
      const cert = (res.socket as TLSSocket).getPeerX509Certificate();
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), cert }));
    });
    req.on("error", reject);
    req.end();
  });
}

const storedCrates = (): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(e.name); };
  walk(join(dataDir, "crates"));
  return out.sort();
};

before(async () => {
  if (!hasTools) return;
  makeCerts();
  dataDir = join(root, "data");
  upstreamGit = join(root, "upstream");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  for (const repo of ["craft-libs", "other"]) {
    const work = join(root, `work-${repo}`);
    mkdirSync(work);
    git(work, "init", "--quiet", "-b", "main");
    writeFileSync(join(work, "lib.rs"), `// ${repo}\n`);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "first");
    mkdirSync(join(upstreamGit, "storytold"), { recursive: true });
    git(root, "clone", "--quiet", "--bare", work, join(upstreamGit, "storytold", `${repo}.git`));
  }
  writeFileSync(allowFile, "# test\nstorytold/craft-libs\n");
  mirror = await startMirror(
    { listen: "127.0.0.1:0", dataDir, tlsDir, gitAllowlistFile: allowFile, crateCapBytes: crateBody("1.0.0").length * 2.5, indexCapBytes: 1024 * 1024 },
    { log: process.env.MIRROR_TEST_LOG ? undefined : () => undefined, fetch: fakeFetch, indexUpstream: "https://idx.test", staticUpstream: "https://static.test", gitUpstream: upstreamGit, crateMaxBytes: 1024, now: () => clock },
  );
});

after(async () => {
  await mirror?.close();
  rmSync(root, { recursive: true, force: true });
});

test("the server name picks the certificate; an unknown name gets none", { skip: !hasTools }, async () => {
  for (const host of ["static.crates.io", "github.com"]) {
    const r = await get(host, "/nothing");
    assert.ok(r.cert?.subject.includes(`CN=${host}`), `${host}: ${r.cert?.subject}`);
  }
  await assert.rejects(get("example.com", "/"));
  await assert.rejects(new Promise((resolve, reject) => {
    // An IP address as host: the client sends no server name at all.
    const s = connect({ host: "127.0.0.1", port: mirror.port, ca: readFileSync(join(tlsDir, "ca.pem")), rejectUnauthorized: false }, () => { s.end(); resolve(undefined); });
    s.on("error", reject);
  }));
  assert.equal((await get("static.crates.io", "/crates/demo/1.0.0/download", { headers: { host: "github.com" } })).status, 421);
  assert.equal((await get("api.github.com", "/repos/storytold/craft-libs/commits/main")).status, 404);
});

test("index files are cached briefly and served stale while upstream fails", { skip: !hasTools }, async () => {
  const before = calls.length;
  const first = await get("index.crates.io", "/de/mo/demo");
  assert.equal(first.status, 200);
  assert.equal((await get("index.crates.io", "/de/mo/demo")).body.toString(), first.body.toString());
  assert.equal(calls.length - before, 1, "second read within the TTL is a cache hit");

  clock += 5 * 60_000;
  indexMode = "down";
  const stale = await get("index.crates.io", "/de/mo/demo");
  assert.equal(stale.status, 200);
  assert.equal(stale.body.toString(), first.body.toString());
  clock += 8 * 24 * 3600_000;
  assert.equal((await get("index.crates.io", "/de/mo/demo")).status, 502, "too old to serve stale");
  indexMode = "ok";
  assert.equal((await get("index.crates.io", "/../etc/passwd")).status, 404);
  const n = calls.length;
  assert.equal((await get("index.crates.io", "/3/n/nop")).status, 404);
  assert.equal((await get("index.crates.io", "/3/n/nop")).status, 404);
  assert.equal(calls.length - n, 1, "upstream 404 remembered for the TTL");
});

test("a crate whose checksum differs from the index is refused and not stored", { skip: !hasTools }, async () => {
  assert.equal((await get("static.crates.io", "/crates/demo/1.0.3/download")).status, 502);
  assert.ok(!storedCrates().some((f) => f.includes("1.0.3")));
  const ok = await get("static.crates.io", "/crates/demo/demo-1.0.0.crate");
  assert.equal(ok.status, 200);
  assert.equal(sha(ok.body), sha(crateBody("1.0.0")));
  const before = calls.length;
  assert.equal((await get("static.crates.io", "/crates/demo/1.0.0/download")).status, 200);
  assert.equal(calls.length, before, "stored crate served without upstream");
  assert.equal((await get("static.crates.io", "/crates/demo/1.0.0/download", { method: "POST" })).status, 405);
});

test("the crate store evicts the least recently read crate past its cap and refuses oversized downloads", { skip: !hasTools }, async () => {
  await get("static.crates.io", "/crates/demo/1.0.1/download");
  await get("static.crates.io", "/crates/demo/1.0.0/download"); // read 1.0.0 again: 1.0.1 is now the oldest read
  await get("static.crates.io", "/crates/demo/1.0.2/download");
  assert.deepEqual(storedCrates(), ["demo-1.0.0.crate", "demo-1.0.2.crate"]);
  assert.equal((await get("static.crates.io", "/crates/big/1.0.0/download")).status, 502, "larger than the per-response limit");
  assert.equal((await get("static.crates.io", "/crates/nope/1.0.0/download")).status, 404, "not in the index");
  assert.ok(!storedCrates().some((f) => f.startsWith("big")));
});

test("git serves allowlisted repos to a real client and 404s the rest", { skip: !hasTools }, async () => {
  const dest = join(root, "clone");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_SSL_CAINFO: join(tlsDir, "ca.pem"), GIT_TERMINAL_PROMPT: "0" };
  // Async: the mirror runs in this process, so a synchronous child would block it.
  await promisify(execFile)("git", ["-c", `http.curloptResolve=github.com:${mirror.port}:127.0.0.1`, "clone", "--quiet", `https://github.com:${mirror.port}/storytold/craft-libs`, dest], { env });
  assert.equal(readFileSync(join(dest, "lib.rs"), "utf8"), "// craft-libs\n");
  assert.ok(existsSync(join(dataDir, "git", "storytold", "craft-libs.git")));

  assert.equal((await get("github.com", "/storytold/other/info/refs?service=git-upload-pack")).status, 404);
  assert.equal((await get("github.com", "/storytold/craft-libs/info/refs?service=git-receive-pack")).status, 404);
  assert.equal((await get("github.com", "/storytold/craft-libs/git-receive-pack", { method: "POST" })).status, 404);
  assert.equal((await get("github.com", "/storytold/craft-libs")).status, 404);
});

test("an unreadable allowlist keeps the previous list and deletes no mirror", { skip: !hasTools }, async () => {
  const mirrorDir = join(dataDir, "git", "storytold", "craft-libs.git");
  assert.equal((await get("github.com", "/storytold/craft-libs/info/refs?service=git-upload-pack")).status, 200);
  renameSync(allowFile, `${allowFile}.away`);
  await mirror.git.sync();
  assert.ok(existsSync(mirrorDir));
  assert.equal((await get("github.com", "/storytold/craft-libs/info/refs?service=git-upload-pack")).status, 200);

  writeFileSync(allowFile, "storytold/other\n");
  await mirror.git.sync();
  assert.ok(!existsSync(mirrorDir), "a readable list without the repo removes its mirror");
  assert.equal((await get("github.com", "/storytold/craft-libs/info/refs?service=git-upload-pack")).status, 404);
});

test("requests past the upstream slots wait in line, and identical ones share one fetch", async () => {
  let running = 0;
  let peak = 0;
  const fetched: string[] = [];
  const slow = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return new Response("{}\n");
  }) as typeof fetch;
  const cache = new IndexCache({ dir: join(root, "queue-index"), capBytes: 1024 * 1024, upstream: "https://idx.test", fetch: slow, log: () => undefined, slots: new Slots(2, { queue: 100, waitMs: 10_000 }) });
  const paths = ["/se/rd/serde", "/3/s/syn", "/2/cc", "/1/a", "/ra/nd/rand", "/to/ki/tokio", "/li/bc/libc", "/se/rd/serde", "/3/s/syn", "/se/rd/serde"];
  const answers = await Promise.all(paths.map((p) => cache.get(p)));
  assert.ok(answers.every((a) => a.status === 200), "every queued request is answered");
  assert.ok(peak <= 2, "no more upstream requests at once than slots");
  assert.equal(fetched.length, new Set(paths).size, "identical paths fetch once");
});
